import { existsSync } from "node:fs";
import path from "node:path";

import { getErrorCode } from "./error-code.ts";
import { formatDiagnostic } from "./run-completion.ts";
import type { Exec } from "./run-context.ts";

export type BaseSnapshot = { branch: string; commit: string };

export type GitState = {
  // Warns about untracked files; false when tracked changes are present.
  hasSafeWorkingTree: () => Promise<boolean>;
  // False when an active rebase could not be aborted and was preserved.
  abortRebase: (worktreePath: string) => Promise<boolean>;
  getCheckedOutBranch: () => Promise<string>;
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
  deleteReviewedBranch: (branch: string) => Promise<void>;
  createMergerVerificationWorktree: (
    verificationWorktreePath: string,
    branch: string,
  ) => Promise<void>;
};

export function createGitState(execFile: Exec): GitState {
  async function hasSafeWorkingTree(): Promise<boolean> {
    const { stdout } = await execFile("git", ["status", "--porcelain"]);
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

  async function isRebaseInProgress(worktreePath: string): Promise<boolean> {
    const rebaseDirectories = await Promise.all(
      ["rebase-merge", "rebase-apply"].map(async (directory) => {
        const { stdout } = await execFile("git", [
          "-C",
          worktreePath,
          "rev-parse",
          "--git-path",
          directory,
        ]);
        return stdout.trim();
      }),
    );

    return rebaseDirectories.some((directory) => existsSync(directory));
  }

  async function abortRebase(worktreePath: string): Promise<boolean> {
    if (!existsSync(worktreePath)) {
      return true;
    }

    if (!(await isRebaseInProgress(worktreePath))) {
      return true;
    }

    try {
      await execFile("git", ["-C", worktreePath, "rebase", "--abort"]);
      return true;
    } catch (error) {
      console.warn(
        `WARNING: Could not abort the active rebase in ${worktreePath}. Preserving it for manual recovery. ${formatDiagnostic(error)}`,
      );
      return false;
    }
  }

  async function getCheckedOutBranch(): Promise<string> {
    const { stdout } = await execFile("git", ["branch", "--show-current"]);
    const branch = stdout.trim();

    if (!branch) {
      throw new Error("Git did not return the checked-out branch.");
    }

    return branch;
  }

  async function getBranchCommit(branch: string): Promise<string> {
    const { stdout } = await execFile("git", ["rev-parse", "--verify", branch]);
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
    const { stdout } = await execFile("git", [
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
    const { stdout } = await execFile("git", [
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
    const { stdout } = await execFile("git", [
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
      await execFile("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch (error) {
      if (getErrorCode(error) === 1) {
        return false;
      }
      throw error;
    }
  }

  async function getBaseSnapshot(): Promise<BaseSnapshot> {
    const { stdout } = await execFile("git", [
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
    await execFile("git", ["merge", "--ff-only", branch]);
  }

  async function deleteReviewedBranch(branch: string): Promise<void> {
    await execFile("git", ["branch", "-d", branch]);
  }

  async function createMergerVerificationWorktree(
    verificationWorktreePath: string,
    branch: string,
  ): Promise<void> {
    await execFile("git", ["worktree", "add", verificationWorktreePath, branch]);
  }

  return {
    hasSafeWorkingTree,
    abortRebase,
    getCheckedOutBranch,
    getBranchCommit,
    hasCommitsBeyondBase,
    getChangedDockerfiles,
    getBranchHeadCommitSubject,
    isAncestorCommit,
    getBaseSnapshot,
    fastForwardTo,
    deleteReviewedBranch,
    createMergerVerificationWorktree,
  };
}
