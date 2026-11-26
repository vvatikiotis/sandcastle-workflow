import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getErrorCode } from "./error-code.ts";
import { isWithinDirectory } from "./file-resolution.ts";
import type { GitState } from "./git-state.ts";
import { formatDiagnostic } from "./run-completion.ts";
import type { Exec } from "./run-context.ts";
import { cleanupVerificationWorktree } from "./verification-worktree-cleanup.ts";
import { listRegisteredWorktreePaths } from "./worktree-registration.ts";

const mergerRecoverySchema = z.object({
  baseBranch: z.string().min(1),
  reviewedBranch: z.string().min(1),
  verificationWorktreePath: z.string().min(1),
});

export type MergerRecovery = {
  // Workflow State that marks a merger in progress; named in recovery messages.
  mergerRecoveryPath: string;
  writeMergerRecoveryMarker: (
    baseBranch: string,
    reviewedBranch: string,
    verificationWorktreePath: string,
  ) => Promise<void>;
  clearMergerRecoveryMarker: () => Promise<void>;
  // True when the base checkout is back on the base branch and the
  // verification worktree is gone; false preserves both for manual recovery.
  recoverMergerState: (
    baseBranch: string,
    verificationWorktreePath: string,
  ) => Promise<boolean>;
  recoverAfterMergerStepFailure: (
    step: "setup" | "validation",
    error: unknown,
    baseBranch: string,
    verificationWorktreePath: string,
  ) => Promise<never>;
  // Runs before planning; false when an interrupted merger was not recovered.
  recoverInterruptedMerger: () => Promise<boolean>;
  removeVerificationWorktree: (
    verificationWorktreePath: string,
  ) => Promise<boolean>;
};

// Persists the base branch, reviewed branch, and verification worktree from
// merger setup until the runner has integrated and deleted the reviewed
// branch. A later run uses it to recover from process termination before
// planning.
export function createMergerRecovery({
  projectRoot,
  execFile,
  git,
}: {
  projectRoot: string;
  execFile: Exec;
  git: GitState;
}): MergerRecovery {
  const mergerRecoveryPath = path.join(
    projectRoot,
    ".sandcastle",
    "merger-recovery.json",
  );


  async function recoverBaseCheckout(baseBranch: string): Promise<boolean> {
    if (!(await git.abortRebase(projectRoot))) {
      return false;
    }

    const { stdout } = await execFile("git", ["status", "--porcelain"]);
    const trackedEntries = stdout
      .split("\n")
      .filter(Boolean)
      .filter((entry) => !entry.startsWith("??"));

    if (trackedEntries.length > 0) {
      console.warn(
        `WARNING: Merger recovery found ${trackedEntries.length} tracked working-tree change(s). Preserving the checkout for manual recovery.`,
      );
      return false;
    }

    try {
      await execFile("git", ["switch", baseBranch]);
      return true;
    } catch (error) {
      console.warn(
        `WARNING: Merger recovery could not switch back to base branch ${baseBranch}. Preserving the checkout for manual recovery. ${formatDiagnostic(error)}`,
      );
      return false;
    }
  }

  async function removeVerificationWorktree(
    verificationWorktreePath: string,
  ): Promise<boolean> {
    const result = await cleanupVerificationWorktree({
      repositoryPath: projectRoot,
      worktreePath: verificationWorktreePath,
    });
    if (result.outcome !== "preserved") {
      return true;
    }

    console.warn(
      `WARNING: Could not remove merger verification worktree. ${result.detail} Recovery marker: ${mergerRecoveryPath}.`,
    );
    return false;
  }

  async function clearMergerRecoveryMarker(): Promise<void> {
    await rm(mergerRecoveryPath, { force: true });
  }

  async function resolveRegisteredRecoveryWorktree(
    verificationWorktreePath: string,
  ): Promise<string | undefined> {
    const worktreeRoot = path.join(projectRoot, ".sandcastle", "worktrees");
    const resolvedRoot = await realpath(worktreeRoot);
    if (resolvedRoot !== path.resolve(worktreeRoot)) {
      throw new Error(
        `Workflow worktree directory is redirected: ${worktreeRoot}.`,
      );
    }

    const requestedPath = path.resolve(verificationWorktreePath);
    if (
      !isWithinDirectory(resolvedRoot, requestedPath) ||
      !/^sandcastle-merger-verify-issue-\d+$/.test(path.basename(requestedPath))
    ) {
      throw new Error(
        `Recovery worktree is not an expected verification path: ${requestedPath}.`,
      );
    }

    let metadata;
    try {
      metadata = await lstat(requestedPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(
        `Recovery worktree must be a real directory: ${requestedPath}.`,
      );
    }
    const resolvedPath = await realpath(requestedPath);
    if (resolvedPath !== requestedPath) {
      throw new Error(`Recovery worktree is redirected: ${requestedPath}.`);
    }

    const registered = (
      await listRegisteredWorktreePaths(projectRoot)
    ).includes(resolvedPath);
    if (!registered) {
      throw new Error(
        `Git does not register the recovery worktree: ${resolvedPath}.`,
      );
    }

    return resolvedPath;
  }

  async function recoverMergerState(
    baseBranch: string,
    verificationWorktreePath: string,
  ): Promise<boolean> {
    try {
      const resolvedVerificationWorktreePath =
        await resolveRegisteredRecoveryWorktree(verificationWorktreePath);
      const verificationRebaseAborted =
        resolvedVerificationWorktreePath === undefined ||
        (await git.abortRebase(resolvedVerificationWorktreePath));
      const baseCheckoutRecovered = verificationRebaseAborted
        ? await recoverBaseCheckout(baseBranch)
        : false;
      const verificationWorktreeRemoved = verificationRebaseAborted
        ? await removeVerificationWorktree(verificationWorktreePath)
        : false;

      return baseCheckoutRecovered && verificationWorktreeRemoved;
    } catch (error) {
      console.warn(
        `WARNING: Could not recover merger state for ${verificationWorktreePath}. Preserving it and ${mergerRecoveryPath} for manual recovery. ${formatDiagnostic(error)}`,
      );
      return false;
    }
  }

  // Recovers the merger checkout after a runner-owned merger step fails, then
  // rethrows that step's error.
  async function recoverAfterMergerStepFailure(
    step: "setup" | "validation",
    error: unknown,
    baseBranch: string,
    verificationWorktreePath: string,
  ): Promise<never> {
    const recovered = await recoverMergerState(
      baseBranch,
      verificationWorktreePath,
    );
    if (recovered) {
      try {
        await clearMergerRecoveryMarker();
      } catch (markerError) {
        process.exitCode = 1;
        throw new AggregateError(
          [error, markerError],
          `Merger ${step} failed and its recovery marker could not be cleared.`,
        );
      }
      throw error;
    }

    process.exitCode = 1;
    throw new AggregateError(
      [
        error,
        new Error(
          `Merger ${step} recovery failed. Preserved ${mergerRecoveryPath}.`,
        ),
      ],
      `Merger ${step} and recovery both failed.`,
    );
  }

  async function recoverInterruptedMerger(): Promise<boolean> {
    if (!existsSync(mergerRecoveryPath)) {
      return true;
    }

    try {
      const marker = mergerRecoverySchema.parse(
        JSON.parse(await readFile(mergerRecoveryPath, "utf8")),
      );
      console.warn(
        `WARNING: Recovering an interrupted merger for base branch ${marker.baseBranch}.`,
      );
      const recovered = await recoverMergerState(
        marker.baseBranch,
        marker.verificationWorktreePath,
      );

      if (recovered) {
        await clearMergerRecoveryMarker();
        console.warn(
          `WARNING: Interrupted merger recovery preserved reviewed branch ${marker.reviewedBranch}.`,
        );
        console.log("Interrupted merger recovery completed.");
      }

      return recovered;
    } catch (error) {
      console.warn(
        `WARNING: Interrupted merger recovery failed. Preserving the checkout and ${mergerRecoveryPath} for manual recovery. ${formatDiagnostic(error)}`,
      );
      return false;
    }
  }

  // Cleanup must not replace the write failure, but a leftover temporary file
  // or descriptor is reported so the operator can remove it. ENOENT means the
  // temporary file was never created.
  async function discardTemporaryMergerRecoveryMarker(
    handle: FileHandle | undefined,
    temporaryPath: string,
  ): Promise<void> {
    try {
      await handle?.close();
    } catch (error) {
      console.warn(
        `WARNING: Could not close temporary merger recovery state ${temporaryPath}. ${formatDiagnostic(error)}`,
      );
    }
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(
          `WARNING: Could not remove temporary merger recovery state ${temporaryPath}. ${formatDiagnostic(error)}`,
        );
      }
    }
  }

  async function writeMergerRecoveryMarker(
    baseBranch: string,
    reviewedBranch: string,
    verificationWorktreePath: string,
  ): Promise<void> {
    const temporaryPath = `${mergerRecoveryPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ baseBranch, reviewedBranch, verificationWorktreePath }),
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, mergerRecoveryPath);
    } catch (error) {
      await discardTemporaryMergerRecoveryMarker(handle, temporaryPath);
      throw new Error(
        `Could not write private merger recovery state ${mergerRecoveryPath}.`,
        { cause: error },
      );
    }
  }

  return {
    mergerRecoveryPath,
    writeMergerRecoveryMarker,
    clearMergerRecoveryMarker,
    recoverMergerState,
    recoverAfterMergerStepFailure,
    recoverInterruptedMerger,
    removeVerificationWorktree,
  };
}
