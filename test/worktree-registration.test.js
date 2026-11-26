import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { listRegisteredWorktreePaths } from "../src/worktree-registration.ts";

async function createRepositoryWithWorktree() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "sandcastle-registration-"))
  );
  const repositoryPath = path.join(root, "repo");
  const worktreeParent = path.join(root, "real");
  const worktreePath = path.join(worktreeParent, "wt");
  await mkdir(repositoryPath);
  await mkdir(worktreeParent);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: repositoryPath });
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--quiet", "--allow-empty", "-m", "init"],
    { cwd: repositoryPath }
  );
  execFileSync("git", ["worktree", "add", "--quiet", worktreePath], {
    cwd: repositoryPath,
  });
  return { root, repositoryPath, worktreeParent, worktreePath };
}

describe("registered worktree paths", () => {
  it("lists the repository and its worktrees by canonical path", async () => {
    const { root, repositoryPath, worktreePath } =
      await createRepositoryWithWorktree();
    try {
      assert.deepEqual(await listRegisteredWorktreePaths(repositoryPath), [
        repositoryPath,
        worktreePath,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a worktree registered through a symlinked path", async () => {
    const { root, repositoryPath, worktreeParent, worktreePath } =
      await createRepositoryWithWorktree();
    try {
      const linkedParent = path.join(root, "link");
      await symlink(worktreeParent, linkedParent);
      // Git records the path it was given; rewriting the registration models a
      // worktree whose recorded parent was later replaced by a symlink.
      await writeFile(
        path.join(repositoryPath, ".git", "worktrees", "wt", "gitdir"),
        `${path.join(linkedParent, "wt", ".git")}\n`
      );

      assert.deepEqual(await listRegisteredWorktreePaths(repositoryPath), [
        repositoryPath,
        worktreePath,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a registered worktree whose directory is gone, under its canonical parent", async () => {
    const { root, repositoryPath, worktreePath } =
      await createRepositoryWithWorktree();
    try {
      await rm(worktreePath, { recursive: true, force: true });

      assert.deepEqual(await listRegisteredWorktreePaths(repositoryPath), [
        repositoryPath,
        worktreePath,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
