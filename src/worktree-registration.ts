import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { getErrorCode } from "./error-code.ts";

const execFile = promisify(execFileCallback);

// Resolves symlinks in every existing component. A missing tail keeps its
// name under the canonical parent, so a registered worktree whose directory
// is gone still compares equal to its canonical path.
export async function canonicalizePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }

    const parentPath = path.dirname(filePath);
    if (parentPath === filePath) {
      return filePath;
    }
    return path.join(
      await canonicalizePath(parentPath),
      path.basename(filePath)
    );
  }
}

// Lists every worktree Git registers for the repository, including the main
// worktree, by canonical path. Git reports the path it recorded, which can run
// through a symlink, so callers compare canonical paths instead.
export async function listRegisteredWorktreePaths(
  repositoryPath: string
): Promise<string[]> {
  const { stdout } = await execFile("git", [
    "-C",
    repositoryPath,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return Promise.all(
    stdout
      .split("\0")
      .filter((entry) => entry.startsWith("worktree "))
      .map((entry) =>
        canonicalizePath(path.resolve(entry.slice("worktree ".length)))
      )
  );
}
