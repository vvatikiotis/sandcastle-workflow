import { execFile as execFileCallback } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getErrorCode } from "./error-code.ts";
import { isWithinDirectory } from "./file-resolution.ts";
import {
  canonicalizePath,
  listRegisteredWorktreePaths,
} from "./worktree-registration.ts";

type VerificationWorktreeCleanupResult =
  | { outcome: "removed" }
  | { outcome: "already-absent" }
  | { outcome: "preserved"; detail: string };

type CleanupVerificationWorktreeOptions = {
  repositoryPath: string;
  worktreePath: string;
};

type WorktreeState = {
  pathExists: boolean;
  registered: boolean;
};

type WorktreeInspectionResult =
  { state: WorktreeState; error?: never } | { state?: never; error: unknown };

const execFile = promisify(execFileCallback);

export async function cleanupVerificationWorktree({
  repositoryPath,
  worktreePath,
}: CleanupVerificationWorktreeOptions): Promise<VerificationWorktreeCleanupResult> {
  let resolvedRepositoryPath: string;
  let resolvedWorktreePath: string;
  let resolvedWorkflowWorktreeRoot: string;
  try {
    resolvedRepositoryPath = await realpath(path.resolve(repositoryPath));
    resolvedWorktreePath = await canonicalizePath(
      path.resolve(resolvedRepositoryPath, worktreePath)
    );
    const workflowWorktreeRoot = path.join(
      resolvedRepositoryPath,
      ".sandcastle",
      "worktrees"
    );
    resolvedWorkflowWorktreeRoot = await canonicalizePath(workflowWorktreeRoot);
    if (resolvedWorkflowWorktreeRoot !== workflowWorktreeRoot) {
      return preservedResult(
        resolvedWorktreePath,
        undefined,
        `Workflow worktree directory resolves outside ${workflowWorktreeRoot}.`
      );
    }
  } catch (error) {
    return preservedResult(
      path.resolve(repositoryPath, worktreePath),
      undefined,
      `Could not normalize repository and worktree paths. ${formatError(error)}`
    );
  }

  // The worktree root itself is not a worktree, so it must be strictly inside.
  if (
    path.relative(resolvedWorkflowWorktreeRoot, resolvedWorktreePath) === "" ||
    !isWithinDirectory(resolvedWorkflowWorktreeRoot, resolvedWorktreePath)
  ) {
    return preservedResult(
      resolvedWorktreePath,
      undefined,
      `Worktree is outside ${resolvedWorkflowWorktreeRoot}.`
    );
  }

  let state: WorktreeState;
  try {
    state = await inspectWorktreeState(
      resolvedRepositoryPath,
      resolvedWorktreePath
    );
  } catch (error) {
    return preservedResult(
      resolvedWorktreePath,
      undefined,
      `Command failed: git -C ${resolvedRepositoryPath} worktree list --porcelain -z. ${formatError(error)}`
    );
  }

  if (!state.pathExists && !state.registered) {
    return { outcome: "already-absent" };
  }

  if (state.pathExists && !state.registered) {
    return preservedResult(
      resolvedWorktreePath,
      state,
      "The directory exists but Git no longer registers it as a worktree."
    );
  }

  const removeWorktree = () =>
    execFile("git", [
      "-C",
      resolvedRepositoryPath,
      "worktree",
      "remove",
      resolvedWorktreePath,
    ]);

  try {
    await removeWorktree();
  } catch (firstError) {
    const failedInspection = await inspectWorktreeStateSafely(
      resolvedRepositoryPath,
      resolvedWorktreePath
    );
    if (isRemoved(failedInspection.state)) {
      return { outcome: "removed" };
    }
    if (
      !isTransientRemovalError(firstError) ||
      !failedInspection.state?.registered
    ) {
      return preservedResult(
        resolvedWorktreePath,
        failedInspection.state,
        `Command failed: git worktree remove ${resolvedWorktreePath}. ${formatError(firstError)}${formatInspectionFailure(failedInspection.error, resolvedRepositoryPath)}`
      );
    }

    await wait(250);
    try {
      await removeWorktree();
    } catch (secondError) {
      const retryInspection = await inspectWorktreeStateSafely(
        resolvedRepositoryPath,
        resolvedWorktreePath
      );
      if (isRemoved(retryInspection.state)) {
        return { outcome: "removed" };
      }
      return preservedResult(
        resolvedWorktreePath,
        retryInspection.state,
        `Cleanup retry failed: git worktree remove ${resolvedWorktreePath}. ${formatError(secondError)}${formatInspectionFailure(retryInspection.error, resolvedRepositoryPath)}`
      );
    }
  }

  const finalInspection = await inspectWorktreeStateSafely(
    resolvedRepositoryPath,
    resolvedWorktreePath
  );
  return isRemoved(finalInspection.state)
    ? { outcome: "removed" }
    : preservedResult(
        resolvedWorktreePath,
        finalInspection.state,
        `Git reported successful removal, but the cleanup postconditions failed.${formatInspectionFailure(finalInspection.error, resolvedRepositoryPath)}`
      );
}

async function inspectWorktreeState(
  repositoryPath: string,
  worktreePath: string
): Promise<WorktreeState> {
  const [registeredPaths, pathExists] = await Promise.all([
    listRegisteredWorktreePaths(repositoryPath),
    fileExists(worktreePath),
  ]);

  return {
    pathExists,
    registered: registeredPaths.includes(worktreePath),
  };
}

async function inspectWorktreeStateSafely(
  repositoryPath: string,
  worktreePath: string
): Promise<WorktreeInspectionResult> {
  try {
    return { state: await inspectWorktreeState(repositoryPath, worktreePath) };
  } catch (error) {
    return { error };
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function preservedResult(
  worktreePath: string,
  state: WorktreeState | undefined,
  reason: string
): VerificationWorktreeCleanupResult {
  const stateDetail = state
    ? `Path exists: ${state.pathExists ? "yes" : "no"}; Git registration exists: ${state.registered ? "yes" : "no"}.`
    : "Path and Git registration state could not be determined.";

  return {
    outcome: "preserved",
    detail: `${reason} Worktree: ${worktreePath}. ${stateDetail}`,
  };
}

function isRemoved(state: WorktreeState | undefined): boolean {
  return state !== undefined && !state.pathExists && !state.registered;
}

function isTransientRemovalError(error: unknown): boolean {
  return (
    getErrorCode(error) === "EBUSY" ||
    /resource busy/i.test(formatError(error)) ||
    (typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      /resource busy/i.test(error.stderr))
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatInspectionFailure(
  error: unknown | undefined,
  repositoryPath: string
): string {
  return error === undefined
    ? ""
    : ` Postcondition command failed: git -C ${repositoryPath} worktree list --porcelain -z. ${formatError(error)}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
