import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { cleanupVerificationWorktree } from "../src/verification-worktree-cleanup.ts";

async function createRepository() {
  const repositoryPath = await mkdtemp(
    path.join(os.tmpdir(), "sandcastle-worktree-cleanup-")
  );

  execFileSync("git", ["init", "--quiet", "-b", "main"], {
    cwd: repositoryPath,
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repositoryPath,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: repositoryPath,
  });
  await writeFile(path.join(repositoryPath, "fixture.txt"), "fixture\n");
  execFileSync("git", ["add", "fixture.txt"], { cwd: repositoryPath });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repositoryPath,
  });

  return repositoryPath;
}

async function createWorktree(repositoryPath, name = "verification") {
  const worktreePath = path.join(repositoryPath, name);
  execFileSync("git", ["branch", name], { cwd: repositoryPath });
  execFileSync("git", ["worktree", "add", "--quiet", worktreePath, name], {
    cwd: repositoryPath,
  });
  return worktreePath;
}

function registeredWorktreePaths(repositoryPath) {
  return execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: repositoryPath,
    encoding: "utf8",
  })
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

async function withFakeGit(mode, operation) {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "sandcastle-fake-git-"));
  const fakeGitPath = path.join(fakeBin, "git");
  const attemptPath = path.join(fakeBin, "remove-attempts");
  const realGitPath = execFileSync("which", ["git"], {
    encoding: "utf8",
  }).trim();
  const script = `#!/bin/sh
if [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then
  attempts=0
  if [ -f '${attemptPath}' ]; then attempts=$(cat '${attemptPath}'); fi
  attempts=$((attempts + 1))
  printf '%s' "$attempts" > '${attemptPath}'
  if [ '${mode}' = 'transient-once' ] && [ "$attempts" -eq 1 ]; then
    echo 'error: Device or resource busy' >&2
    exit 255
  fi
  if [ '${mode}' = 'partial-transient' ] && [ "$attempts" -eq 1 ]; then
    rm -rf "$2/.git/worktrees/$(basename "$5")"
    echo 'error: Device or resource busy' >&2
    exit 255
  fi
  if [ '${mode}' = 'successful-noop' ]; then
    exit 0
  fi
fi
exec '${realGitPath}' "$@"
`;
  await writeFile(fakeGitPath, script);
  await chmod(fakeGitPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const value = await operation();
    const attempts = Number(await readFile(attemptPath, "utf8"));
    return { value, attempts };
  } finally {
    process.env.PATH = originalPath;
    await rm(fakeBin, { recursive: true, force: true });
  }
}

describe("verification worktree cleanup", () => {
  it("reports an absent path with no Git registration as already absent", async () => {
    const repositoryPath = await createRepository();

    try {
      const result = await cleanupVerificationWorktree({
        repositoryPath,
        worktreePath: "missing-worktree",
      });

      assert.deepEqual(result, { outcome: "already-absent" });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("removes a clean registered worktree from disk and Git", async () => {
    const repositoryPath = await createRepository();
    const worktreePath = await createWorktree(repositoryPath);

    try {
      const result = await cleanupVerificationWorktree({
        repositoryPath,
        worktreePath: path.basename(worktreePath),
      });

      assert.deepEqual(result, { outcome: "removed" });
      await assert.rejects(() => rm(worktreePath), { code: "ENOENT" });
      assert.equal(
        registeredWorktreePaths(repositoryPath).includes(worktreePath),
        false
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("preserves a dirty registered worktree after a non-transient Git failure", async () => {
    const repositoryPath = await createRepository();
    const worktreePath = await createWorktree(repositoryPath);
    await writeFile(path.join(worktreePath, "untracked.txt"), "preserve me\n");

    try {
      const result = await cleanupVerificationWorktree({
        repositoryPath,
        worktreePath,
      });

      assert.equal(result.outcome, "preserved");
      assert.match(result.detail, /modified or untracked files/);
      assert.match(result.detail, /Path exists: yes/);
      assert.match(result.detail, /Git registration exists: yes/);
      assert.equal(
        registeredWorktreePaths(repositoryPath).includes(
          await realpath(worktreePath)
        ),
        true
      );
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repositoryPath,
      });
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("preserves a surviving directory that Git no longer registers", async () => {
    const repositoryPath = await createRepository();
    const worktreePath = await createWorktree(repositoryPath);
    const canonicalWorktreePath = await realpath(worktreePath);
    const adminDirectory = path.join(
      repositoryPath,
      ".git",
      "worktrees",
      path.basename(worktreePath)
    );
    await rm(adminDirectory, { recursive: true, force: true });

    try {
      const result = await cleanupVerificationWorktree({
        repositoryPath,
        worktreePath,
      });

      assert.equal(result.outcome, "preserved");
      assert.match(result.detail, /no longer registers it as a worktree/);
      assert.match(result.detail, /Path exists: yes/);
      assert.match(result.detail, /Git registration exists: no/);
      assert.equal(
        registeredWorktreePaths(repositoryPath).includes(canonicalWorktreePath),
        false
      );
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("retries one transient registered-worktree failure after 250 ms", async () => {
    const repositoryPath = await createRepository();
    const worktreePath = await createWorktree(repositoryPath);

    try {
      const startedAt = Date.now();
      const { value: result, attempts } = await withFakeGit(
        "transient-once",
        () => cleanupVerificationWorktree({ repositoryPath, worktreePath })
      );

      assert.deepEqual(result, { outcome: "removed" });
      assert.equal(attempts, 2);
      assert.ok(Date.now() - startedAt >= 200);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not retry after a transient failure drops the Git registration", async () => {
    const repositoryPath = await createRepository();
    const worktreePath = await createWorktree(repositoryPath);

    try {
      const { value: result, attempts } = await withFakeGit(
        "partial-transient",
        () => cleanupVerificationWorktree({ repositoryPath, worktreePath })
      );

      assert.equal(result.outcome, "preserved");
      assert.match(result.detail, /Path exists: yes/);
      assert.match(result.detail, /Git registration exists: no/);
      assert.equal(attempts, 1);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("preserves the worktree when a successful command misses its postconditions", async () => {
    const repositoryPath = await createRepository();
    const worktreePath = await createWorktree(repositoryPath);

    try {
      const { value: result, attempts } = await withFakeGit(
        "successful-noop",
        () => cleanupVerificationWorktree({ repositoryPath, worktreePath })
      );

      assert.equal(result.outcome, "preserved");
      assert.match(result.detail, /cleanup postconditions failed/);
      assert.match(result.detail, /Path exists: yes/);
      assert.match(result.detail, /Git registration exists: yes/);
      assert.equal(attempts, 1);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repositoryPath,
      });
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
