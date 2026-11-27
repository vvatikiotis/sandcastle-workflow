// Docker regression: builds the ejected packaged Dockerfile, then runs
// Integration's rebase, verification, re-attach, and restore against a real
// Sandcastle 0.14 Docker sandbox. Skips when Docker is unavailable.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createSandbox } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import { rebaseAndVerify, restoreIssueBranch } from "../src/integration.ts";

const packageRoot = path.resolve(process.cwd());
const dockerCheck = spawnSync("docker", ["info"], { encoding: "utf8" });
const dockerUnavailable =
  dockerCheck.status === 0 ? false : `Docker is unavailable: ${dockerCheck.stderr.trim()}`;
// Rootless Docker maps the host user to root inside the container, so only
// UID 0 there can write the bind-mounted worktree.
const rootless = /name=rootless/.test(
  spawnSync("docker", ["info", "--format", "{{.SecurityOptions}}"], { encoding: "utf8" }).stdout ?? ""
);
const containerUid = rootless ? 0 : (process.getuid?.() ?? 1000);
const containerGid = rootless ? 0 : (process.getgid?.() ?? 1000);

function git(repositoryPath, ...args) {
  return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}

async function createRepository(prefix) {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(repositoryPath, "init", "--quiet", "-b", "main");
  git(repositoryPath, "config", "user.email", "test@example.com");
  git(repositoryPath, "config", "user.name", "Test");
  await writeFile(path.join(repositoryPath, "shared.txt"), "original\n");
  await writeFile(path.join(repositoryPath, ".gitignore"), "node_modules/\n.sandcastle/\n");
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "--quiet", "-m", "fixture");
  return repositoryPath;
}

async function commitFile(repositoryPath, filePath, contents, message) {
  await writeFile(path.join(repositoryPath, filePath), contents);
  git(repositoryPath, "add", filePath);
  git(repositoryPath, "commit", "--quiet", "-m", message);
}

async function installPackedWorkflow(repositoryPath) {
  const packRoot = await mkdtemp(path.join(path.dirname(repositoryPath), "docker-workflow-pack-"));
  try {
    const packedOutput = execFileSync("pnpm", ["pack", "--pack-destination", packRoot], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const packedPath = path.resolve(packageRoot, packedOutput.trim().split("\n").at(-1));
    const vendorRoot = path.join(repositoryPath, "vendor");
    await mkdir(vendorRoot);
    const vendoredPath = path.join(vendorRoot, path.basename(packedPath));
    await copyFile(packedPath, vendoredPath);
    await writeFile(
      path.join(repositoryPath, "package.json"),
      `${JSON.stringify(
        {
          name: "docker-eject-consumer",
          private: true,
          packageManager: "pnpm@11.10.0",
          devDependencies: {
            "@vvatikiotis/sandcastle-workflow": `file:vendor/${path.basename(packedPath)}`,
          },
        },
        null,
        2
      )}\n`
    );
    execFileSync("pnpm", ["install", "--ignore-scripts"], { cwd: repositoryPath, stdio: "pipe" });
    return path.join(repositoryPath, "node_modules", ".bin", "sandcastle-workflow");
  } finally {
    await rm(packRoot, { recursive: true, force: true });
  }
}

describe("Integration in a real Sandcastle Docker sandbox", { skip: dockerUnavailable }, () => {
  const imageName = `sandcastle-integration-test-${process.pid}-${Date.now()}`;
  const repositories = [];

  // Builds the image from the ejected packaged Dockerfile, as a consumer does.
  before(async () => {
    const repositoryPath = await createRepository("docker-eject-");
    repositories.push(repositoryPath);
    const workflow = await installPackedWorkflow(repositoryPath);
    const eject = spawnSync(workflow, ["eject-dockerfile"], { cwd: repositoryPath, encoding: "utf8" });
    assert.equal(eject.status, 0, `${eject.error ?? ""}${eject.stderr}`);
    const build = spawnSync(
      "docker",
      [
        "build",
        "--build-arg",
        `AGENT_UID=${containerUid}`,
        "--build-arg",
        `AGENT_GID=${containerGid}`,
        "--file",
        path.join(repositoryPath, ".sandcastle", "Dockerfile"),
        "--tag",
        imageName,
        repositoryPath,
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
    assert.equal(build.status, 0, build.stderr);
  });

  after(async () => {
    spawnSync("docker", ["image", "rm", "--force", imageName], { encoding: "utf8" });
    for (const repositoryPath of repositories) {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  async function openSandbox(repositoryPath, branch) {
    return createSandbox({
      branch,
      cwd: repositoryPath,
      sandbox: docker({ imageName, containerUid, containerGid }),
    });
  }

  const passingChecks = { install: "true", typecheck: "true", test: "test -f base.txt" };

  it("rebases on a detached HEAD, re-attaches the branch, and leaves a reusable branch after close", async () => {
    const repositoryPath = await createRepository("docker-integration-");
    repositories.push(repositoryPath);
    const branch = "sandcastle/issue-1";
    git(repositoryPath, "branch", branch);
    await commitFile(repositoryPath, "base.txt", "base\n", "base moves on");
    const onto = git(repositoryPath, "rev-parse", "main");
    const logPath = path.join(repositoryPath, "integration.log");
    const log = (text) => appendFile(logPath, text);

    const sandbox = await openSandbox(repositoryPath, branch);
    let closeResult;
    try {
      // An agent commits in the container, through the read-only Git control paths.
      const agentCommit = await sandbox.exec(
        "echo agent > agent.txt && git add agent.txt && git commit --quiet -m 'sandcastle(implementer): #1: agent change'"
      );
      assert.equal(agentCommit.exitCode, 0, agentCommit.stderr);

      const outcome = await rebaseAndVerify(sandbox, { branch, onto, commands: passingChecks, log });

      assert.equal(outcome.kind, "verified", JSON.stringify(outcome));
      const head = await sandbox.exec("git symbolic-ref HEAD");
      assert.equal(head.stdout.trim(), `refs/heads/${branch}`);
    } finally {
      closeResult = await sandbox.close();
    }

    assert.equal(closeResult.preservedWorktreePath, undefined);
    await assert.rejects(access(sandbox.worktreePath));
    git(repositoryPath, "merge-base", "--is-ancestor", onto, branch);
    assert.equal(git(repositoryPath, "log", "-1", "--format=%s", branch), "sandcastle(implementer): #1: agent change");

    // The rebased branch opens again in a new sandbox.
    const reopened = await openSandbox(repositoryPath, branch);
    try {
      const reopenedHead = await reopened.exec("git rev-parse HEAD");
      assert.equal(reopenedHead.stdout.trim(), git(repositoryPath, "rev-parse", branch));
    } finally {
      await reopened.close();
    }

    git(repositoryPath, "merge", "--ff-only", branch);
    assert.equal(git(repositoryPath, "rev-parse", "main"), git(repositoryPath, "rev-parse", branch));
  });

  it("aborts a conflicting rebase and restores the unchanged branch before close", async () => {
    const repositoryPath = await createRepository("docker-conflict-");
    repositories.push(repositoryPath);
    const branch = "sandcastle/issue-2";
    git(repositoryPath, "switch", "--quiet", "-c", branch);
    await commitFile(repositoryPath, "shared.txt", "from the branch\n", "branch change");
    git(repositoryPath, "switch", "--quiet", "main");
    await commitFile(repositoryPath, "shared.txt", "from the base\n", "base change");
    const reviewedCommit = git(repositoryPath, "rev-parse", branch);
    const onto = git(repositoryPath, "rev-parse", "main");
    const log = (text) => appendFile(path.join(repositoryPath, "integration.log"), text);

    const sandbox = await openSandbox(repositoryPath, branch);
    let closeResult;
    try {
      const outcome = await rebaseAndVerify(sandbox, { branch, onto, commands: passingChecks, log });
      assert.equal(outcome.kind, "conflict", JSON.stringify(outcome));
      assert.match(outcome.detail, /conflicts in: shared\.txt/);

      await restoreIssueBranch(sandbox, branch, log);
      const head = await sandbox.exec("git symbolic-ref HEAD && git status --porcelain");
      assert.equal(head.stdout.trim(), `refs/heads/${branch}`);
    } finally {
      closeResult = await sandbox.close();
    }

    assert.equal(closeResult.preservedWorktreePath, undefined);
    await assert.rejects(access(sandbox.worktreePath));
    assert.equal(git(repositoryPath, "rev-parse", branch), reviewedCommit);
    assert.equal(git(repositoryPath, "rev-parse", "main"), onto);
  });
});
