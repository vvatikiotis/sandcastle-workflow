import path from "node:path";

import { getErrorCode } from "./error-code.ts";
import type { Exec } from "./run-context.ts";

export type BaseSnapshot = { branch: string; commit: string };

// Disables repository hooks for a runner-owned git command. Agents' own
// commits keep the repository's hooks.
export const runnerGitPrefix = ["-c", "core.hooksPath=/dev/null"] as const;

// A ref and the value it holds: a commit for a branch, tag, or stash, and the
// symbolic target ("ref: refs/heads/main") or commit for HEAD.
export type RefValue = { ref: string; value: string };

export const unsafeBaseCheckoutReason =
  "The base checkout has tracked working-tree changes.";

export type GitState = {
  // Warns about untracked files; false when tracked changes are present.
  hasSafeWorkingTree: () => Promise<boolean>;
  getBranchCommit: (branch: string) => Promise<string>;
  hasCommitsBeyondBase: (branch: string, baseCommit: string) => Promise<boolean>;
  getChangedDockerfiles: (
    beforeCommit: string,
    afterCommit: string,
  ) => Promise<string[]>;
  getBranchHeadCommitSubject: (branch: string) => Promise<string>;
  isAncestorCommit: (ancestor: string, descendant: string) => Promise<boolean>;
  getBaseSnapshot: () => Promise<BaseSnapshot>;
  // Integration's base-branch update; fails unless it is a fast-forward.
  fastForwardTo: (branch: string) => Promise<void>;
  // Fails when the branch already exists.
  createBranch: (branch: string, commit: string) => Promise<void>;
  // Deletes a branch whose commits the checked-out branch already contains.
  deleteBranch: (branch: string) => Promise<void>;
  // Branches, tags, the stash, and the main checkout's HEAD.
  listGuardedRefs: () => Promise<RefValue[]>;
};

export function createGitState(execFile: Exec): GitState {
  function git(args: readonly string[]): Promise<{ stdout: string }> {
    return execFile("git", [...runnerGitPrefix, ...args]);
  }

  async function hasSafeWorkingTree(): Promise<boolean> {
    const { stdout } = await git(["status", "--porcelain"]);
    const entries = stdout.split("\n").filter(Boolean);
    const untrackedEntries = entries.filter((entry) => entry.startsWith("??"));
    const trackedEntries = entries.filter((entry) => !entry.startsWith("??"));

    if (untrackedEntries.length > 0) {
      console.warn(
        `WARNING: ${untrackedEntries.length} untracked file(s) are present. Continuing.`,
      );
    }

    if (trackedEntries.length === 0) {
      return true;
    }

    console.warn(
      `WARNING: ${trackedEntries.length} tracked working-tree change(s) are present. Aborting before planning.`,
    );
    return false;
  }

  async function getBranchCommit(branch: string): Promise<string> {
    const { stdout } = await git(["rev-parse", "--verify", branch]);
    const commit = stdout.trim();

    if (!commit) {
      throw new Error(`Git did not return a commit for branch ${branch}.`);
    }

    return commit;
  }

  // A leftover issue branch holds a committed implementation only when it has
  // commits the base lacks. Its head alone differs from the base commit whenever
  // the base moved on after the branch was created, even with no work on it.
  async function hasCommitsBeyondBase(
    branch: string,
    baseCommit: string,
  ): Promise<boolean> {
    const { stdout } = await git([
      "rev-list",
      "--count",
      `${baseCommit}..${branch}`,
    ]);
    const count = Number.parseInt(stdout.trim(), 10);

    if (Number.isNaN(count)) {
      throw new Error(
        `Git returned an invalid commit count for ${branch}: ${stdout}`,
      );
    }

    return count > 0;
  }

  async function getChangedDockerfiles(
    beforeCommit: string,
    afterCommit: string,
  ): Promise<string[]> {
    const { stdout } = await git([
      "diff",
      "--name-only",
      beforeCommit,
      afterCommit,
      "--",
    ]);
    return stdout
      .split("\n")
      .map((filePath) => filePath.trim())
      .filter((filePath) => path.basename(filePath) === "Dockerfile");
  }

  async function getBranchHeadCommitSubject(branch: string): Promise<string> {
    const { stdout } = await git([
      "log",
      "-1",
      "--pretty=%s",
      branch,
    ]);
    const subject = stdout.trim();

    if (!subject) {
      throw new Error(`Branch ${branch} has no commit subject in git log.`);
    }

    return subject;
  }

  async function isAncestorCommit(
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      await git(["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (getErrorCode(error) === 1) {
        return false;
      }
      throw error;
    }
  }

  async function getBaseSnapshot(): Promise<BaseSnapshot> {
    const { stdout } = await git([
      "status",
      "--porcelain=v2",
      "--branch",
    ]);
    const lines = stdout.split("\n");
    const branch = lines
      .find((line) => line.startsWith("# branch.head "))
      ?.slice("# branch.head ".length);
    const commit = lines
      .find((line) => line.startsWith("# branch.oid "))
      ?.slice("# branch.oid ".length);

    if (!branch || branch === "(detached)" || !commit || commit === "(initial)") {
      throw new Error(
        "Sandcastle requires a named base branch with an existing HEAD commit.",
      );
    }

    return { branch, commit };
  }

  async function fastForwardTo(branch: string): Promise<void> {
    await git(["merge", "--ff-only", branch]);
  }

  async function deleteBranch(branch: string): Promise<void> {
    await git(["branch", "-d", branch]);
  }

  async function createBranch(branch: string, commit: string): Promise<void> {
    await git(["branch", "--no-track", branch, commit]);
  }

  async function listGuardedRefs(): Promise<RefValue[]> {
    const { stdout } = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/tags",
      "refs/stash",
    ]);
    const refs = stdout
      .split("\n")
      .filter(Boolean)
      .map((line): RefValue => {
        const [ref = "", value = ""] = line.split(" ");
        return { ref, value };
      });

    let head: string;
    try {
      const { stdout: target } = await git(["symbolic-ref", "--quiet", "HEAD"]);
      head = `ref: ${target.trim()}`;
    } catch (error) {
      if (getErrorCode(error) !== 1) {
        throw error;
      }
      const { stdout: commit } = await git(["rev-parse", "--verify", "HEAD"]);
      head = commit.trim();
    }

    return [...refs, { ref: "HEAD", value: head }];
  }

  return {
    hasSafeWorkingTree,
    getBranchCommit,
    hasCommitsBeyondBase,
    getChangedDockerfiles,
    getBranchHeadCommitSubject,
    isAncestorCommit,
    getBaseSnapshot,
    fastForwardTo,
    createBranch,
    deleteBranch,
    listGuardedRefs,
  };
}
