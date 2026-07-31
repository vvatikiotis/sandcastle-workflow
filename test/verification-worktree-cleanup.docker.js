import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { cleanupVerificationWorktree } from "../src/verification-worktree-cleanup.ts";
import { getVerificationWorktreePaths } from "../src/verification-worktree-paths.ts";

async function createRepository() {
  const repositoryPath = await mkdtemp(
    path.join(path.dirname(process.cwd()), "docker-worktree-cleanup-")
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
  await writeFile(path.join(repositoryPath, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["add", "fixture.txt", ".gitignore"], {
    cwd: repositoryPath,
  });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repositoryPath,
  });
  return repositoryPath;
}

async function createWorktree(repositoryPath, name) {
  const worktreePath = path.join(
    repositoryPath,
    ".sandcastle",
    "worktrees",
    name
  );
  await mkdir(path.dirname(worktreePath), { recursive: true });
  execFileSync("git", ["branch", name], { cwd: repositoryPath });
  execFileSync("git", ["worktree", "add", "--quiet", worktreePath, name], {
    cwd: repositoryPath,
  });
  return worktreePath;
}

function runContainer(repositoryPath, worktreePath, overlayPath, command) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${repositoryPath},dst=${repositoryPath}`,
      "--mount",
      `type=bind,src=${overlayPath},dst=${worktreePath}/node_modules`,
      "--workdir",
      repositoryPath,
      "node:22-bookworm",
      "sh",
      "-c",
      command,
    ],
    { encoding: "utf8" }
  );
}

test("the merger sees a clean verification worktree through its sandbox path", async (t) => {
  const dockerCheck = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (dockerCheck.status !== 0) {
    t.skip(`Docker is unavailable: ${dockerCheck.stderr.trim()}`);
    return;
  }

  const repositoryPath = await createRepository();
  const paths = getVerificationWorktreePaths(repositoryPath, "fixture");
  const overlayPath = await mkdtemp(
    path.join(path.dirname(repositoryPath), "docker-worktree-overlay-")
  );

  try {
    await mkdir(path.dirname(paths.hostPath), { recursive: true });
    execFileSync("git", ["branch", "verification"], { cwd: repositoryPath });
    execFileSync(
      "git",
      ["worktree", "add", "--quiet", paths.hostPath, "verification"],
      { cwd: repositoryPath }
    );

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--mount",
        `type=bind,src=${repositoryPath},dst=/home/agent/workspace`,
        "--mount",
        `type=bind,src=${path.join(repositoryPath, ".git")},dst=${path.join(repositoryPath, ".git")}`,
        "--mount",
        `type=bind,src=${overlayPath},dst=${paths.sandboxPath}/node_modules`,
        "--workdir",
        "/home/agent/workspace",
        "node:22-bookworm",
        "sh",
        "-c",
        `git config --global --add safe.directory '${paths.sandboxPath}' && test -z "$(git -C '${paths.sandboxPath}' status --porcelain)"`,
      ],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
    await rm(overlayPath, { recursive: true, force: true });
  }
});

test("host cleanup waits for the merger dependency mount to close", async (t) => {
  const dockerCheck = spawnSync("docker", ["info"], { encoding: "utf8" });
  if (dockerCheck.status !== 0) {
    t.skip(`Docker is unavailable: ${dockerCheck.stderr.trim()}`);
    return;
  }

  const repositoryPath = await createRepository();
  const overlayPath = path.join(repositoryPath, "overlay");
  await mkdir(overlayPath);

  try {
    const oldWorktreePath = await createWorktree(repositoryPath, "old-flow");
    const oldFlow = runContainer(
      repositoryPath,
      oldWorktreePath,
      overlayPath,
      `git worktree remove '${oldWorktreePath}'`
    );
    assert.notEqual(oldFlow.status, 0);
    assert.match(oldFlow.stderr, /resource busy/i);
    await rm(oldWorktreePath, { recursive: true, force: true });

    const correctedWorktreePath = await createWorktree(
      repositoryPath,
      "corrected-flow"
    );
    const correctedFlow = runContainer(
      repositoryPath,
      correctedWorktreePath,
      overlayPath,
      `test -d '${correctedWorktreePath}'`
    );
    assert.equal(correctedFlow.status, 0, correctedFlow.stderr);

    const cleanup = await cleanupVerificationWorktree({
      repositoryPath,
      worktreePath: correctedWorktreePath,
    });
    assert.deepEqual(cleanup, { outcome: "removed" });
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});
