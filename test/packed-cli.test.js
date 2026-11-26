import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@vvatikiotis/sandcastle-workflow";
const packageManifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8")
);
const packageVersion = packageManifest.version;
const ansi = {
  blue: "\u001b[34m",
  resetForeground: "\u001b[39m",
};
const validRunnerConfig = [
  "IMPLEMENTER_MODEL=test-model",
  "IMPLEMENTER_EFFORT=low",
  "REVIEWER_MODEL=test-model",
  "REVIEWER_EFFORT=low",
  "MERGER_MODEL=test-model",
  "MERGER_EFFORT=low",
  "FINAL_SPEC_REVIEWER_MODEL=test-model",
  "FINAL_SPEC_REVIEWER_EFFORT=low",
  "MAX_ITERATIONS=1",
].join("\n");

let tempRoot;
let tarballPath;

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function installConsumer(manager) {
  const managerFamily = manager.startsWith("npm") ? "npm" : "pnpm";
  const consumerRoot = path.join(tempRoot, manager);
  const vendorRoot = path.join(consumerRoot, "vendor");
  await mkdir(vendorRoot, { recursive: true });
  const vendoredTarball = path.join(vendorRoot, path.basename(tarballPath));
  await copyFile(tarballPath, vendoredTarball);
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: `${manager}-consumer`,
        private: true,
        packageManager:
          managerFamily === "npm" ? "npm@10.9.2" : "pnpm@11.10.0",
        scripts: {
          test: "node --test",
          typecheck: "node --check index.js",
          sandcastle: "sandcastle-workflow",
        },
        devDependencies: {
          [packageName]: `file:vendor/${path.basename(tarballPath)}`,
        },
      },
      null,
      2
    )}\n`
  );

  if (managerFamily === "npm") {
    await run("npx", ["--yes", "npm@10.9.2", "install", "--ignore-scripts"], {
      cwd: consumerRoot,
    });
  } else {
    await run("pnpm", ["install", "--ignore-scripts"], { cwd: consumerRoot });
  }

  return consumerRoot;
}

async function fingerprintInstalledPackage(consumerRoot) {
  const installedRoot = await realpath(
    path.join(
      consumerRoot,
      "node_modules",
      "@vvatikiotis",
      "sandcastle-workflow"
    )
  );
  const hash = createHash("sha256");

  async function addDirectory(directory, relativeRoot = "") {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const absolutePath = path.join(directory, name);
      const relativePath = path.join(relativeRoot, name);
      const fileStats = await stat(absolutePath);
      if (fileStats.isDirectory()) {
        await addDirectory(absolutePath, relativePath);
      } else if (fileStats.isFile()) {
        hash.update(relativePath);
        hash.update(await readFile(absolutePath));
      }
    }
  }

  await addDirectory(installedRoot);
  return hash.digest("hex");
}

async function prepareDryRunConsumer(manager) {
  const consumerRoot = await installConsumer(manager);
  const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");
  await run("git", ["init", "--quiet"], { cwd: consumerRoot });
  await run("git", ["config", "user.email", "test@example.com"], {
    cwd: consumerRoot,
  });
  await run("git", ["config", "user.name", "Test"], { cwd: consumerRoot });
  await run("git", ["remote", "add", "origin", "https://github.com/example/project.git"], {
    cwd: consumerRoot,
  });
  await run(shim, ["init"], { cwd: consumerRoot });
  await writeFile(path.join(consumerRoot, "CODING_STANDARDS.md"), "# Standards\n");
  await writeFile(path.join(consumerRoot, "index.js"), "export {};\n");
  await writeFile(path.join(consumerRoot, ".gitignore"), "node_modules/\n");
  await writeFile(
    path.join(consumerRoot, ".sandcastle", "sandcastle.env"),
    `${validRunnerConfig}\n`
  );
  await run("git", ["add", "."], { cwd: consumerRoot });
  await run("git", ["commit", "--quiet", "-m", "fixture"], { cwd: consumerRoot });

  const binRoot = path.join(consumerRoot, "bin");
  await mkdir(binRoot);
  const ghPath = path.join(binRoot, "gh");
  await writeFile(
    ghPath,
    `#!/bin/sh
if [ "$1 $2" = "label list" ]; then
  printf '%s\\n' '[{"name":"needs-triage"},{"name":"needs-info"},{"name":"ready-for-agent"},{"name":"ready-for-human"},{"name":"wontfix"}]'
elif [ "$1 $2" = "issue list" ]; then
  printf '%s\\n' '[]'
else
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi
`
  );
  await chmod(ghPath, 0o755);
  return { consumerRoot, shim, binRoot, ghPath };
}

async function installFakeSandcastleBoundary(consumerRoot) {
  const fakeRoot = path.join(consumerRoot, "fake-sandcastle");
  await mkdir(fakeRoot);
  const fakeModulePath = path.join(fakeRoot, "index.mjs");
  const fakeDockerPath = path.join(fakeRoot, "docker.mjs");
  const hookPath = path.join(fakeRoot, "hook.mjs");

  await writeFile(
    fakeModulePath,
    `import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

function capture(value) {
  appendFileSync(process.env.FAKE_SANDCASTLE_CAPTURE, JSON.stringify(value) + "\\n");
}

function addCommit(cwd, branch, message) {
  const parent = execFileSync("git", ["rev-parse", branch], { cwd, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", parent + "^{tree}"], { cwd, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-p", parent, "-m", message], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fake Agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "Fake Agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
    },
  }).trim();
  execFileSync("git", ["update-ref", "refs/heads/" + branch, commit], { cwd });
}

function addFileCommit(cwd, branch, filePath, contents, message) {
  const parent = execFileSync("git", ["rev-parse", branch], { cwd, encoding: "utf8" }).trim();
  const indexPath = cwd + "/.git/fake-agent-index";
  const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
  execFileSync("git", ["read-tree", parent], { cwd, env: gitEnv });
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    encoding: "utf8",
    input: contents,
  }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", "100644," + blob + "," + filePath], {
    cwd,
    env: gitEnv,
  });
  const tree = execFileSync("git", ["write-tree"], { cwd, env: gitEnv, encoding: "utf8" }).trim();
  rmSync(indexPath, { force: true });
  const commit = execFileSync("git", ["commit-tree", tree, "-p", parent, "-m", message], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fake Agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "Fake Agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
    },
  }).trim();
  execFileSync("git", ["update-ref", "refs/heads/" + branch, commit], { cwd });
}

function commitInWorktree(worktree, filePath, contents, message) {
  const target = worktree + "/" + filePath;
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  writeFileSync(target, contents);
  execFileSync("git", ["add", "--", filePath], { cwd: worktree });
  execFileSync("git", ["commit", "--quiet", "-m", message], {
    cwd: worktree,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fake Agent",
      GIT_AUTHOR_EMAIL: "agent@example.com",
      GIT_COMMITTER_NAME: "Fake Agent",
      GIT_COMMITTER_EMAIL: "agent@example.com",
    },
  });
}

function changesFileFor(role) {
  const change = process.env.FAKE_AGENT_FILE_CHANGE;
  if (!change) return undefined;
  const [changeRole, filePath] = change.split(":");
  return changeRole === role ? filePath : undefined;
}

export function codex(model, options) {
  return { model, options };
}

export async function createSandbox(options) {
  execFileSync("git", ["branch", options.branch], { cwd: options.cwd });
  capture({ type: "sandbox", hooks: options.hooks });
  return {
    async run(runOptions) {
      capture({
        type: "phase",
        name: runOptions.name,
        promptArgs: runOptions.promptArgs,
        promptFile: runOptions.promptFile,
        logMode: statSync(runOptions.logging.path).mode & 0o777,
        verbose: runOptions.logging.verbose,
      });
      if (runOptions.name.includes("implementer")) {
        const changedFile = changesFileFor("implementer");
        if (changedFile) {
          addFileCommit(options.cwd, options.branch, changedFile, "FROM scratch\\n", "sandcastle(implementer): #42: fake implementation");
        } else {
          addCommit(options.cwd, options.branch, "sandcastle(implementer): #42: fake implementation");
        }
        if (process.env.RECOVERY_SYMLINK_TARGET) {
          symlinkSync(
            process.env.RECOVERY_SYMLINK_TARGET,
            options.cwd + "/.sandcastle/merger-recovery.json"
          );
        }
        return { stdout: "<phase-outcome>implemented</phase-outcome>\\n<promise>COMPLETE</promise>" };
      }
      const reviewerFile = changesFileFor("reviewer");
      if (reviewerFile) {
        addFileCommit(options.cwd, options.branch, reviewerFile, "FROM scratch\\n", "sandcastle(reviewer): #42: fake refinement");
      }
      return { stdout: "<phase-outcome>approved</phase-outcome>\\n<promise>COMPLETE</promise>" };
    },
    async close() {
      return {};
    },
  };
}

export async function run(options) {
  const recoveryPath = options.cwd + "/.sandcastle/merger-recovery.json";
  capture({
    type: "phase",
    name: options.name,
    promptArgs: options.promptArgs,
    promptFile: options.promptFile,
    hooks: options.hooks,
    logMode: statSync(options.logging.path).mode & 0o777,
    verbose: options.logging.verbose,
    recoveryMode: options.name.includes("merger")
      ? statSync(recoveryPath).mode & 0o777
      : undefined,
    recoveryState: options.name.includes("merger")
      ? JSON.parse(readFileSync(recoveryPath, "utf8"))
      : undefined,
  });
  if (options.name.includes("final-spec-reviewer")) {
    execFileSync("gh", ["issue", "close", options.promptArgs.SPEC_ISSUE_ID], { cwd: options.cwd });
    return { stdout: "<phase-outcome>closed</phase-outcome>\\n<promise>COMPLETE</promise>" };
  }
  // The merger rebases, verifies, and commits on the reviewed branch only.
  // The runner owns the base-branch fast-forward and issue closure.
  const mergerFile = changesFileFor("merger");
  if (mergerFile) {
    const worktree = options.promptArgs.VERIFICATION_WORKTREE_PATH.replace(
      "/home/agent/workspace",
      options.cwd
    );
    commitInWorktree(worktree, mergerFile, "FROM scratch\\n", "sandcastle(merger): #" + options.promptArgs.ISSUE_ID + ": fake verification fix");
  }
  return { stdout: "<phase-outcome>merged</phase-outcome>\\n<promise>COMPLETE</promise>" };
}
`
  );
  await writeFile(
    fakeDockerPath,
    `import path from "node:path";
export function docker(options) { return options; }
export function defaultImageName(projectRoot) {
  return "sandcastle:" + path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}
`
  );
  await writeFile(
    hookPath,
    `import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const rootUrl = pathToFileURL(${JSON.stringify(fakeModulePath)}).href;
const dockerUrl = pathToFileURL(${JSON.stringify(fakeDockerPath)}).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@ai-hero/sandcastle") return { url: rootUrl, shortCircuit: true };
    if (specifier === "@ai-hero/sandcastle/sandboxes/docker") return { url: dockerUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`
  );
  return hookPath;
}


const requiredLabels = [
  "needs-triage",
  "needs-info",
  "ready-for-agent",
  "ready-for-human",
  "wontfix",
];

// A data-driven GitHub CLI boundary. The fixture lists ready issues per
// `issue list` call, native sub-issues, parents, blockers, blocked issues, and
// closed issues;
// `issue close` persists closures beside the fixture.
async function writeGitHubFixture(ghPath, fixturePath, fixture) {
  await writeFile(fixturePath, JSON.stringify(fixture));
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const fixture = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
const statePath = ${JSON.stringify(`${fixturePath}.state`)};
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { closed: [], listCalls: 0 };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const print = (value) =>
  process.stdout.write((typeof value === "string" ? value : JSON.stringify(value)) + "\\n");
const isClosed = (id) =>
  state.closed.includes(String(id)) || (fixture.closed ?? []).includes(String(id));
const [command, action, target] = process.argv.slice(2);
const args = process.argv.slice(2);
if (command === "label" && action === "list") {
  print(${JSON.stringify(requiredLabels.map((name) => ({ name })))});
} else if (command === "issue" && action === "list") {
  state.listCalls += 1;
  save();
  const lists = fixture.readyIssueLists;
  const list = lists[Math.min(state.listCalls, lists.length) - 1];
  print(list.filter((issue) => !isClosed(issue.id)));
} else if (command === "api") {
  const match = /issues\\/(\\d+)\\/sub_issues/.exec(action);
  print((match && fixture.subIssues?.[match[1]]) ?? []);
} else if (command === "issue" && action === "view") {
  if (args.includes("state")) {
    print(isClosed(target) ? "CLOSED" : "OPEN");
  } else {
    const parent = fixture.parents?.[target];
    print({
      parent: parent ? { number: Number(parent) } : null,
      blockedBy: { nodes: (fixture.blockers?.[target] ?? []).map((id) => ({ number: Number(id) })) },
      blocking: { nodes: (fixture.blocking?.[target] ?? []).map((id) => ({ number: Number(id) })) },
    });
  }
} else if (command === "issue" && action === "close") {
  state.closed.push(String(target));
  save();
} else if (command === "issue" && (action === "comment" || action === "edit")) {
  // Accepted without changing fixture state.
} else {
  process.stderr.write("unexpected gh arguments: " + args.join(" ") + "\\n");
  process.exit(1);
}
`
  );
  await chmod(ghPath, 0o755);
}

function standaloneIssue(id, title = `Standalone ${id}`) {
  return { id, title, createdAt: `2026-01-01T00:00:${id.padStart(2, "0").slice(-2)}Z`, parentId: null };
}

// Prepares a consumer that can launch fake agents: credentials, an available
// Docker image, the fake Sandcastle SDK boundary, and a GitHub fixture.
async function prepareWorkflowConsumer(manager, fixture) {
  const prepared = await prepareDryRunConsumer(manager);
  const { consumerRoot, binRoot, ghPath } = prepared;
  await writeFile(
    path.join(consumerRoot, ".sandcastle", ".env"),
    "GH_TOKEN=test-token\n"
  );
  const dockerPath = path.join(binRoot, "docker");
  await writeFile(
    dockerPath,
    '#!/bin/sh\nif [ "$1 $2" = "image inspect" ]; then exit 0; fi\nexit 1\n'
  );
  await chmod(dockerPath, 0o755);
  const fixturePath = path.join(consumerRoot, "gh-fixture.json");
  await writeGitHubFixture(ghPath, fixturePath, fixture);
  const hookPath = await installFakeSandcastleBoundary(consumerRoot);
  const capturePath = path.join(consumerRoot, "fake-sandcastle-capture");
  const environment = {
    ...process.env,
    FAKE_SANDCASTLE_CAPTURE: capturePath,
    NODE_OPTIONS: `--import=${hookPath}`,
    PATH: `${binRoot}:${process.env.PATH ?? ""}`,
  };
  return { ...prepared, environment, capturePath, fixturePath };
}

async function readClosedIssues(fixturePath) {
  try {
    return JSON.parse(await readFile(`${fixturePath}.state`, "utf8")).closed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readCapturedPhases(capturePath) {
  try {
    return (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "phase")
      .map((entry) => entry.name.split(":")[0]);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readLogs(consumerRoot) {
  const logRoot = path.join(consumerRoot, ".sandcastle", "logs");
  const names = await readdir(logRoot);
  return Promise.all(
    names.map(async (name) => ({
      name,
      contents: await readFile(path.join(logRoot, name), "utf8"),
    }))
  );
}

async function runExpectingFailure(shim, args, options) {
  try {
    const result = await run(shim, args, options);
    assert.fail(`expected a non-zero exit; stdout:\n${result.stdout}`);
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      throw error;
    }
    return error;
  }
}

describe("packed CLI", () => {
  before(async () => {
    tempRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "sandcastle-workflow-package-"))
    );
    const packRoot = path.join(tempRoot, "pack");
    await mkdir(packRoot);
    const { stdout } = await run(
      "pnpm",
      ["pack", "--pack-destination", packRoot],
      { cwd: packageRoot }
    );
    const packedFilename = stdout.trim().split("\n").at(-1);
    assert.ok(packedFilename, "pnpm pack should report its tarball path");
    tarballPath = path.resolve(packageRoot, packedFilename);
  });

  after(async () => {
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("contains only the initial public package artifact", async () => {
    const { stdout } = await run("tar", ["-tf", tarballPath]);
    const entries = stdout.trim().split("\n");

    const expectedEntries = [
      "package/README.md",
      "package/CONSUMER.md",
      "package/MAINTAINER.md",
      "package/dist/cli.js",
      "package/dist/defaults/docker/Dockerfile",
      "package/dist/defaults/prompts/final-spec-prompt.md",
      "package/dist/defaults/prompts/implement-prompt.md",
      "package/dist/defaults/prompts/merge-prompt.md",
      "package/dist/defaults/prompts/review-prompt.md",
      "package/dist/defaults/prompts/standalone-implement-prompt.md",
      "package/dist/defaults/prompts/standalone-merge-prompt.md",
      "package/dist/defaults/prompts/standalone-review-prompt.md",
      "package/dist/setup.sh",
      "package/package.json",
      "package/skills/github-ticket-relationships/SKILL.md",
    ].sort();
    assert.deepEqual(entries.sort(), expectedEntries);

    const { stdout: bundledCli } = await run("tar", [
      "-xOf",
      tarballPath,
      "package/dist/cli.js",
    ]);
    assert.match(bundledCli, /^#!\/usr\/bin\/env node\n/);
    assert.doesNotMatch(bundledCli, /sourceMappingURL=/);

    for (const forbidden of [
      "/src/",
      "/test/",
      "/.env",
      "/sandcastle.env",
      "/logs/",
      "/worktrees/",
      "/node-modules-overlays/",
      "/merger-recovery.json",
      "/run.lock",
    ]) {
      assert.equal(entries.some((entry) => entry.includes(forbidden)), false);
    }

    for (const promptName of [
      "implement-prompt.md",
      "merge-prompt.md",
      "standalone-implement-prompt.md",
      "standalone-merge-prompt.md",
      "standalone-review-prompt.md",
    ]) {
      const { stdout: prompt } = await run("tar", [
        "-xOf",
        tarballPath,
        `package/dist/defaults/prompts/${promptName}`,
      ]);
      assert.doesNotMatch(prompt, /\bpnpm\b/);
      assert.match(prompt, /\{\{TYPECHECK_COMMAND\}\}/);
      assert.match(prompt, /\{\{TEST_COMMAND\}\}/);
      if (promptName.includes("merge")) {
        assert.match(prompt, /\{\{INSTALL_COMMAND\}\}/);
      }
      if (promptName === "implement-prompt.md") {
        assert.doesNotMatch(prompt, /gh issue list --state open/);
        assert.match(prompt, /gh issue view \{\{ISSUE_ID\}\}/);
      }
    }

    const { stdout: manifestText } = await run("tar", [
      "-xOf",
      tarballPath,
      "package/package.json",
    ]);
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.bin, {
      "sandcastle-workflow": "dist/cli.js",
      "sandcastle-workflow-setup": "dist/setup.sh",
    });
    assert.equal("pi" in manifest, false);
  });

  for (const manager of ["npm", "pnpm"]) {
    it(`runs help and version from a clean ${manager} consumer`, async () => {
      const consumerRoot = await installConsumer(manager);
      const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");
      const entry = path.join(
        consumerRoot,
        "node_modules",
        "@vvatikiotis",
        "sandcastle-workflow",
        "dist",
        "cli.js"
      );

      await assert.rejects(
        access(path.join(consumerRoot, "node_modules", "@daytona", "sdk"))
      );
      await assert.rejects(
        access(path.join(consumerRoot, "node_modules", "@vercel", "sandbox"))
      );

      const help = await run(shim, ["--help"], { cwd: tempRoot });
      assert.match(help.stdout, /^Usage: sandcastle-workflow/m);

      const version = await run(process.execPath, [entry, "--version"], {
        cwd: tempRoot,
      });
      assert.equal(version.stdout.trim(), packageVersion);
      assert.equal((await stat(entry)).mode & 0o111, 0o111);

      const installedPackageRoot = await realpath(path.dirname(path.dirname(entry)));
      assert.equal(installedPackageRoot.startsWith(packageRoot), false);
    });
  }

  for (const manager of ["npm-eject", "pnpm-eject"]) {
    it(`ejects the default Dockerfile from a nested ${manager.split("-")[0]} consumer`, async () => {
      const consumerRoot = await installConsumer(manager);
      await run("git", ["init", "--quiet"], { cwd: consumerRoot });
      const nestedRoot = path.join(consumerRoot, "nested", "directory");
      await mkdir(nestedRoot, { recursive: true });
      const installedRoot = await realpath(
        path.join(
          consumerRoot,
          "node_modules",
          "@vvatikiotis",
          "sandcastle-workflow"
        )
      );
      const packagedDockerfile = path.join(
        installedRoot,
        "dist",
        "defaults",
        "docker",
        "Dockerfile"
      );
      const ejectedDockerfile = path.join(consumerRoot, ".sandcastle", "Dockerfile");

      const managerFamily = manager.startsWith("npm") ? "npm" : "pnpm";
      const command =
        managerFamily === "npm"
          ? ["run", "sandcastle", "--", "eject-dockerfile"]
          : ["sandcastle", "eject-dockerfile"];
      const first = await run(managerFamily, command, { cwd: nestedRoot });
      assert.match(first.stdout, new RegExp(`Created ${ejectedDockerfile}`));
      assert.equal(
        await readFile(ejectedDockerfile, "utf8"),
        await readFile(packagedDockerfile, "utf8")
      );

      const consumerOverride = `${await readFile(ejectedDockerfile, "utf8")}# Consumer customization\n`;
      await writeFile(ejectedDockerfile, consumerOverride);
      const second = await run(managerFamily, command, { cwd: consumerRoot });
      assert.match(second.stdout, new RegExp(`Preserved ${ejectedDockerfile}`));
      assert.equal(await readFile(ejectedDockerfile, "utf8"), consumerOverride);

      await rm(ejectedDockerfile);
      const third = await run(managerFamily, command, { cwd: consumerRoot });
      assert.match(third.stdout, new RegExp(`Created ${ejectedDockerfile}`));
      assert.equal(
        await readFile(ejectedDockerfile, "utf8"),
        await readFile(packagedDockerfile, "utf8")
      );
    });
  }

  it("initializes a nested consumer safely and preserves existing files", async () => {
    const consumerRoot = await installConsumer("pnpm-init");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const nestedRoot = path.join(consumerRoot, "nested", "directory");
    await mkdir(nestedRoot, { recursive: true });
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    const first = await run(shim, ["init"], { cwd: nestedRoot });
    assert.match(first.stdout, new RegExp(`Sandcastle project root: ${consumerRoot}`));
    assert.match(first.stdout, /Configure the GitHub relationship skill project-locally/);
    assert.match(
      first.stdout,
      /node_modules\/@vvatikiotis\/sandcastle-workflow\/skills\/github-ticket-relationships/
    );

    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    const examplePath = path.join(sandcastleRoot, "sandcastle.env.example");
    assert.match(await readFile(examplePath, "utf8"), /IMPLEMENTER_MODEL=/);
    assert.match(
      await readFile(path.join(sandcastleRoot, ".gitignore"), "utf8"),
      /^run\.lock$/m
    );
    await access(path.join(sandcastleRoot, ".env.example"));
    await assert.rejects(access(path.join(sandcastleRoot, "sandcastle.env")));
    await assert.rejects(access(path.join(sandcastleRoot, ".env")));

    await writeFile(examplePath, "project-owned\n");
    const second = await run(shim, ["init"], { cwd: consumerRoot });
    assert.match(second.stdout, new RegExp(`Preserved ${examplePath}`));
    assert.equal(await readFile(examplePath, "utf8"), "project-owned\n");
  });

  it("runs guided setup from the packed consumer", async () => {
    const consumerRoot = await installConsumer("pnpm-setup");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const setup = path.join(
      consumerRoot,
      "node_modules",
      ".bin",
      "sandcastle-workflow-setup"
    );

    const shadowBin = path.join(consumerRoot, "shadow-bin");
    const shadowMarker = path.join(consumerRoot, "shadow-cli-ran");
    await mkdir(shadowBin);
    await writeFile(
      path.join(shadowBin, "sandcastle-workflow"),
      `#!/bin/sh\nprintf '%s\\n' shadowed > "${shadowMarker}"\nexit 97\n`
    );
    await chmod(path.join(shadowBin, "sandcastle-workflow"), 0o755);

    const result = await run(
      "sh",
      ["-c", "printf 'y\\ny\\n' | \"$1\"", "setup", setup],
      {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${shadowBin}:${process.env.PATH ?? ""}`,
        },
      }
    );

    await assert.rejects(access(shadowMarker));
    assert.match(result.stdout, /pnpm sandcastle build-image/);
    assert.match(result.stdout, /pnpm sandcastle:dry-run/);
    assert.doesNotMatch(result.stdout, /^  sandcastle-workflow /m);
    await access(path.join(consumerRoot, ".sandcastle", "sandcastle.env"));
    await access(path.join(consumerRoot, ".sandcastle", ".env"));
    assert.match(
      await readFile(path.join(consumerRoot, ".sandcastle", "CONSUMER.md"), "utf8"),
      /^# Consumer Guide/m
    );
  });

  it("updates an existing stale .sandcastle/CONSUMER.md during setup", async () => {
    const consumerRoot = await installConsumer("pnpm-setup-update");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const setup = path.join(
      consumerRoot,
      "node_modules",
      ".bin",
      "sandcastle-workflow-setup"
    );
    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    await mkdir(sandcastleRoot);
    await writeFile(
      path.join(sandcastleRoot, "CONSUMER.md"),
      "# Consumer Guide\\n\\nThese steps install version `0.3.6` in a new pnpm consumer.\\n"
    );

    const result = await run(
      "sh",
      ["-c", "printf 'y\\ny\\n' | \"$1\"", "setup", setup],
      { cwd: consumerRoot }
    );

    const updatedGuide = await readFile(
      path.join(sandcastleRoot, "CONSUMER.md"),
      "utf8"
    );
    assert.match(
      updatedGuide,
      /These steps install version `/
    );
    assert.match(updatedGuide, new RegExp(`These steps install version \`${packageVersion}\``));
    assert.equal(updatedGuide.includes("0.3.6"), false);
    assert.ok(
      result.stdout.includes(
        `Updated .sandcastle/CONSUMER.md from 0.3.6 to ${packageVersion}`
      )
    );
    await access(path.join(sandcastleRoot, "sandcastle.env"));
    await access(path.join(sandcastleRoot, ".env"));
  });

  it("prints npm project commands after guided setup", async () => {
    const consumerRoot = await installConsumer("npm-setup");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const setup = path.join(
      consumerRoot,
      "node_modules",
      ".bin",
      "sandcastle-workflow-setup"
    );

    const result = await run(
      "sh",
      ["-c", "printf 'n\\nn\\n' | \"$1\"", "setup", setup],
      { cwd: consumerRoot }
    );

    assert.match(result.stdout, /npm run sandcastle -- build-image/);
    assert.match(result.stdout, /npm run sandcastle:dry-run/);
    assert.doesNotMatch(result.stdout, /^  sandcastle-workflow /m);
    assert.match(
      await readFile(path.join(consumerRoot, ".sandcastle", "CONSUMER.md"), "utf8"),
      /^# Consumer Guide/m
    );
  });

  it("does not leave partial configuration when input ends", async () => {
    const consumerRoot = await installConsumer("pnpm-setup-eof");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const setup = path.join(
      consumerRoot,
      "node_modules",
      ".bin",
      "sandcastle-workflow-setup"
    );

    await assert.rejects(
      run("sh", ["-c", "printf 'y\\n' | \"$1\"", "setup", setup], {
        cwd: consumerRoot,
      }),
      (error) => {
        assert.match(error.stderr, /Input ended; setup aborted/);
        return true;
      }
    );

    await assert.rejects(
      access(path.join(consumerRoot, ".sandcastle", "sandcastle.env"))
    );
    await assert.rejects(
      access(path.join(consumerRoot, ".sandcastle", ".env"))
    );
  });

  it("rejects a symbolic active configuration path", async () => {
    const consumerRoot = await installConsumer("pnpm-setup-symlink");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    await mkdir(sandcastleRoot);
    const outsideTarget = path.join(consumerRoot, "outside-env");
    await symlink(outsideTarget, path.join(sandcastleRoot, ".env"));
    const setup = path.join(
      consumerRoot,
      "node_modules",
      ".bin",
      "sandcastle-workflow-setup"
    );

    await assert.rejects(
      run("sh", ["-c", "printf 'n\\n' | \"$1\"", "setup", setup], {
        cwd: consumerRoot,
      }),
      (error) => {
        assert.match(error.stderr, /Refusing symbolic configuration path/);
        return true;
      }
    );

    await assert.rejects(access(outsideTarget));
  });

  it("builds the versioned default Docker image from packaged defaults", async () => {
    const consumerRoot = await installConsumer("pnpm-docker");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    await mkdir(sandcastleRoot);
    await writeFile(
      path.join(sandcastleRoot, "sandcastle.env"),
      `${validRunnerConfig}\n`
    );
    const binRoot = path.join(consumerRoot, "bin");
    const capturePath = path.join(consumerRoot, "docker-arguments");
    await mkdir(binRoot);
    const dockerPath = path.join(binRoot, "docker");
    await writeFile(
      dockerPath,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_CAPTURE"\n'
    );
    await chmod(dockerPath, 0o755);
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    const result = await run(shim, ["build-image"], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        DOCKER_CAPTURE: capturePath,
        FORCE_COLOR: "1",
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.ok(
      result.stdout.includes(`Docker image: sandcastle:pnpm-docker-v${packageVersion}`)
    );
    assert.match(result.stdout, /Dockerfile: .*dist\/defaults\/docker\/Dockerfile/);
    assert.ok(
      result.stdout.includes(
        `(${ansi.blue}packaged${ansi.resetForeground})`
      )
    );
    assert.match(
      result.stdout,
      /Build arguments: AGENT_UID=\d+, AGENT_GID=\d+/
    );
    const dockerArguments = (await readFile(capturePath, "utf8")).trim().split("\n");
    const fileIndex = dockerArguments.indexOf("--file");
    const tagIndex = dockerArguments.indexOf("--tag");
    assert.equal(
      dockerArguments[tagIndex + 1],
      `sandcastle:pnpm-docker-v${packageVersion}`
    );
    assert.match(dockerArguments[fileIndex + 1], /dist\/defaults\/docker\/Dockerfile$/);
    assert.equal(
      dockerArguments.at(-1),
      path.dirname(dockerArguments[fileIndex + 1])
    );
  });

  it("uses an explicit image and contained project Dockerfile unchanged", async () => {
    const consumerRoot = await installConsumer("pnpm-docker-override");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    await mkdir(sandcastleRoot);
    await writeFile(
      path.join(sandcastleRoot, "sandcastle.env"),
      `${validRunnerConfig}\nDOCKER_IMAGE=registry.example/team/agent:custom\n`
    );
    await writeFile(path.join(sandcastleRoot, "Dockerfile"), "FROM scratch\n");
    const binRoot = path.join(consumerRoot, "bin");
    const capturePath = path.join(consumerRoot, "docker-arguments");
    await mkdir(binRoot);
    const dockerPath = path.join(binRoot, "docker");
    await writeFile(
      dockerPath,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_CAPTURE"\n'
    );
    await chmod(dockerPath, 0o755);
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    const result = await run(shim, ["build-image"], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        DOCKER_CAPTURE: capturePath,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.match(result.stdout, /Docker image: registry\.example\/team\/agent:custom/);
    assert.match(result.stdout, /Dockerfile: .*\.sandcastle\/Dockerfile \(project override\)/);
    const dockerArguments = (await readFile(capturePath, "utf8")).trim().split("\n");
    assert.equal(
      dockerArguments[dockerArguments.indexOf("--tag") + 1],
      "registry.example/team/agent:custom"
    );
    assert.equal(dockerArguments.at(-1), consumerRoot);
  });

  it("rejects an escaping project Dockerfile before Docker runs", async () => {
    const consumerRoot = await installConsumer("pnpm-docker-escape");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    await mkdir(sandcastleRoot);
    await writeFile(
      path.join(sandcastleRoot, "sandcastle.env"),
      `${validRunnerConfig}\n`
    );
    const outsideDockerfile = path.join(tempRoot, "outside.Dockerfile");
    await writeFile(outsideDockerfile, "FROM scratch\n");
    await symlink(outsideDockerfile, path.join(sandcastleRoot, "Dockerfile"));
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    await assert.rejects(
      run(shim, ["build-image"], { cwd: consumerRoot }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Project override resolves outside/);
        return true;
      }
    );
  });

  it("rejects an overlong derived Docker image tag", async () => {
    const consumerRoot = await installConsumer("p".repeat(125));
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const sandcastleRoot = path.join(consumerRoot, ".sandcastle");
    await mkdir(sandcastleRoot);
    await writeFile(
      path.join(sandcastleRoot, "sandcastle.env"),
      `${validRunnerConfig}\n`
    );
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    await assert.rejects(
      run(shim, ["build-image"], { cwd: consumerRoot }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /exceeds Docker's 128-character limit/);
        assert.match(error.stderr, /Configure DOCKER_IMAGE explicitly/);
        return true;
      }
    );
  });

  for (const manager of ["npm-dry-run", "pnpm-dry-run"]) {
    it(`performs a read-only dry run for a valid ${manager.split("-")[0]} consumer`, async () => {
      const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(manager);
      const staleOverlay = path.join(
        consumerRoot,
        ".sandcastle",
        "node-modules-overlays",
        "99999999-stale"
      );
      if (manager.startsWith("pnpm")) {
        await mkdir(staleOverlay, { recursive: true });
      }
      const runLockPath = path.join(consumerRoot, ".sandcastle", "run.lock");
      const existingLock = '{"pid":99999999,"startedAt":"2026-01-01T00:00:00.000Z"}\n';
      await writeFile(runLockPath, existingLock);
      const result = await run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      });

      assert.ok(
        result.stdout.includes(`Sandcastle Workflow v${packageVersion}\n`)
      );
      assert.match(result.stdout, /^Max iterations: 1$/m);
      assert.doesNotMatch(result.stdout, /=== Iteration /);
      assert.match(result.stdout, /No open ready-for-agent issues found/);
      assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
      await assert.rejects(
        access(path.join(consumerRoot, ".sandcastle", "logs"))
      );
      await assert.rejects(
        access(path.join(consumerRoot, ".sandcastle", "worktrees"))
      );
      if (manager.startsWith("pnpm")) {
        await access(staleOverlay);
      }
      assert.equal(await readFile(runLockPath, "utf8"), existingLock);
    });
  }

  it("rejects a package-manager and lockfile mismatch before GitHub access", async () => {
    const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
      "pnpm-manager-mismatch"
    );
    const manifestPath = path.join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.packageManager = "npm@10.9.2";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /npm requires package-lock\.json/);
        return true;
      }
    );
  });

  it("accepts one supported lockfile when packageManager is absent", async () => {
    const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
      "pnpm-lockfile-fallback"
    );
    const manifestPath = path.join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.packageManager;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await run("git", ["add", "package.json"], { cwd: consumerRoot });
    await run("git", ["commit", "--quiet", "-m", "use lockfile fallback"], {
      cwd: consumerRoot,
    });

    const result = await run(shim, ["--dry-run"], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });
    assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
  });

  it("rejects ambiguous and unsupported package-manager evidence", async () => {
    const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
      "pnpm-manager-invalid"
    );
    const manifestPath = path.join(consumerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const runDry = () =>
      run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      });

    await writeFile(path.join(consumerRoot, "package-lock.json"), "{}\n");
    await assert.rejects(runDry(), (error) => {
      assert.match(error.stderr, /both package-lock\.json and pnpm-lock\.yaml/);
      return true;
    });
    await rm(path.join(consumerRoot, "package-lock.json"));

    manifest.packageManager = "yarn@4.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(runDry(), (error) => {
      assert.match(error.stderr, /Unsupported or malformed consumer packageManager/);
      assert.ok(
        error.stderr.includes(
          `Version ${packageVersion} supports npm 10 and pnpm 11.`
        )
      );
      return true;
    });

    manifest.packageManager = "pnpm@10.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(runDry(), (error) => {
      assert.ok(
        error.stderr.includes(`Version ${packageVersion} supports pnpm 11.`)
      );
      return true;
    });

    manifest.packageManager = "pnpm@11.10.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(consumerRoot, "npm-shrinkwrap.json"), "{}\n");
    await assert.rejects(runDry(), (error) => {
      assert.match(error.stderr, /npm-shrinkwrap\.json is unsupported/);
      return true;
    });

    await rm(path.join(consumerRoot, "npm-shrinkwrap.json"));
    await rm(path.join(consumerRoot, "pnpm-lock.yaml"));
    await mkdir(path.join(consumerRoot, "pnpm-lock.yaml"));
    await assert.rejects(runDry(), (error) => {
      assert.match(error.stderr, /pnpm-lock\.yaml must be a regular file/);
      return true;
    });
  });

  it("reports the package version for an unsupported origin", async () => {
    const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
      "pnpm-unsupported-origin"
    );
    await run(
      "git",
      ["remote", "set-url", "origin", "https://gitlab.com/example/project.git"],
      { cwd: consumerRoot }
    );

    await assert.rejects(
      run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(
          error.stderr.includes(
            `Sandcastle version ${packageVersion} supports only GitHub.com origin remotes.`
          )
        );
        return true;
      }
    );
  });

  it("fails preflight when required GitHub labels are missing", async () => {
    const { consumerRoot, shim, binRoot, ghPath } = await prepareDryRunConsumer(
      "pnpm-missing-labels"
    );
    await writeFile(
      ghPath,
      '#!/bin/sh\nif [ "$1 $2" = "label list" ]; then printf "[]\\n"; else exit 1; fi\n'
    );
    await chmod(ghPath, 0o755);

    await assert.rejects(
      run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /missing required triage labels/);
        return true;
      }
    );
  });

  it("stops safely when more than 100 issues are simultaneously eligible", async () => {
    const { consumerRoot, shim, binRoot, ghPath } = await prepareDryRunConsumer(
      "pnpm-too-many-issues"
    );
    const readyIssues = Array.from({ length: 101 }, (_, index) => ({
      id: String(index + 1),
      title: `Issue ${index + 1}`,
      createdAt: "2026-01-01T00:00:00Z",
      parentId: null,
    }));
    const readyIssuesPath = path.join(consumerRoot, "ready-issues.json");
    await writeFile(readyIssuesPath, JSON.stringify(readyIssues));
    await writeFile(
      ghPath,
      `#!/bin/sh
if [ "$1 $2" = "label list" ]; then
  printf '%s\\n' '[{"name":"needs-triage"},{"name":"needs-info"},{"name":"ready-for-agent"},{"name":"ready-for-human"},{"name":"wontfix"}]'
elif [ "$1 $2" = "issue list" ]; then
  cat "$READY_ISSUES"
else
  exit 1
fi
`
    );
    await chmod(ghPath, 0o755);

    await assert.rejects(
      run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          READY_ISSUES: readyIssuesPath,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      }),
      (error) => {
        assert.equal(error.code, 3);
        const output = `${error.stdout}\n${error.stderr}`;
        assert.match(output, /more than 100 open ready-for-agent issues/);
        assert.ok(output.includes(`documented version ${packageVersion} limit`));
        return true;
      }
    );
  });

  it("uses safe-stop exit status 3 for an invalid native issue graph", async () => {
    const { consumerRoot, shim, binRoot, ghPath } = await prepareDryRunConsumer(
      "pnpm-invalid-graph"
    );
    await writeFile(
      ghPath,
      `#!/bin/sh
if [ "$1 $2" = "label list" ]; then
  printf '%s\\n' '[{"name":"needs-triage"},{"name":"needs-info"},{"name":"ready-for-agent"},{"name":"ready-for-human"},{"name":"wontfix"}]'
elif [ "$1 $2" = "issue list" ]; then
  printf '%s\\n' '[{"id":"1","title":"Spec","createdAt":"2026-01-01T00:00:00Z","parentId":null},{"id":"2","title":"Child","createdAt":"2026-01-01T00:01:00Z","parentId":"1"}]'
elif [ "$1" = "api" ]; then
  printf '%s\\n' '[{"number":2,"title":"Child","state":"open","labels":[{"name":"ready-for-agent"}]}]'
elif [ "$1 $2" = "issue view" ]; then
  printf '%s\\n' '{"parent":{"number":3},"blockedBy":{"nodes":[]},"blocking":{"nodes":[]}}'
else
  exit 1
fi
`
    );
    await chmod(ghPath, 0o755);

    await assert.rejects(
      run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        },
      }),
      (error) => {
        assert.equal(error.code, 3);
        assert.match(error.stdout, /SANDCASTLE RUN: STOPPED/);
        assert.match(error.stdout, /sub-issue validation failed/);
        return true;
      }
    );
  });

  it("colors startup and packaged and project-guidance status text blue", async () => {
    const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
      "pnpm-prompt-guidance"
    );
    const guidancePath = path.join(
      consumerRoot,
      ".sandcastle",
      "final-spec-prompt.md"
    );
    await writeFile(guidancePath, "Run the project-specific acceptance check.\n");

    const result = await run(shim, ["--dry-run"], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        FORCE_COLOR: "1",
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.ok(
      result.stdout.startsWith(
        `${ansi.blue}Sandcastle Workflow v${packageVersion}${ansi.resetForeground}\n`
      )
    );
    assert.ok(
      result.stdout.includes(
        `Prompt final-spec-prompt.md: ${ansi.blue}packaged${ansi.resetForeground} `
      )
    );
    assert.ok(
      result.stdout.includes(
        `${ansi.blue}Project guidance final-spec-prompt.md: ${guidancePath}${ansi.resetForeground}`
      )
    );
  });

  for (const manager of ["npm-standalone", "pnpm-standalone"]) {
    it(`executes a standalone issue in a ${manager.split("-")[0]} consumer`, async () => {
      const { consumerRoot, shim, binRoot, ghPath } = await prepareDryRunConsumer(
        manager
      );
      await writeFile(
        path.join(consumerRoot, ".sandcastle", ".env"),
        "GH_TOKEN=test-token\n"
      );
      const projectGuidance = "Run the project-specific acceptance check.\n";
      await writeFile(
        path.join(
          consumerRoot,
          ".sandcastle",
          "standalone-implement-prompt.md"
        ),
        projectGuidance
      );
      const issueStatePath = path.join(consumerRoot, "issue-state");
      await writeFile(issueStatePath, "OPEN\n");
      await writeFile(
        ghPath,
        `#!/bin/sh
if [ "$1 $2" = "label list" ]; then
  printf '%s\\n' '[{"name":"needs-triage"},{"name":"needs-info"},{"name":"ready-for-agent"},{"name":"ready-for-human"},{"name":"wontfix"}]'
elif [ "$1 $2" = "issue list" ]; then
  if grep -q CLOSED "$ISSUE_STATE"; then printf '[]\\n'; else printf '%s\\n' '[{"id":"42","title":"Standalone","createdAt":"2026-01-01T00:00:00Z","parentId":null}]'; fi
elif [ "$1" = "api" ]; then
  printf '[]\\n'
elif [ "$1 $2" = "issue view" ]; then
  if printf '%s\\n' "$*" | grep -q -- '--json state'; then
    cat "$ISSUE_STATE"
  else
    printf '%s\\n' '{"parent":null,"blockedBy":{"nodes":[]},"blocking":{"nodes":[]}}'
  fi
elif [ "$1 $2" = "issue close" ]; then
  printf 'CLOSED\\n' > "$ISSUE_STATE"
else
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi
`
      );
      await chmod(ghPath, 0o755);
      const dockerPath = path.join(binRoot, "docker");
      await writeFile(
        dockerPath,
        '#!/bin/sh\nif [ "$1 $2" = "image inspect" ]; then exit 0; fi\nexit 1\n'
      );
      await chmod(dockerPath, 0o755);
      const hookPath = await installFakeSandcastleBoundary(consumerRoot);
      const capturePath = path.join(consumerRoot, "fake-sandcastle-capture");
      const recoverySymlinkTarget = path.join(
        consumerRoot,
        "recovery-symlink-target"
      );
      await writeFile(recoverySymlinkTarget, "do not overwrite\n");
      const environment = {
        ...process.env,
        FAKE_SANDCASTLE_CAPTURE: capturePath,
        ISSUE_STATE: issueStatePath,
        NODE_OPTIONS: `--import=${hookPath}`,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
        RECOVERY_SYMLINK_TARGET: recoverySymlinkTarget,
      };
      const agentEnvironmentPath = path.join(
        consumerRoot,
        ".sandcastle",
        ".env"
      );
      await writeFile(
        agentEnvironmentPath,
        "GH_TOKEN=test-token\nDATABASE_PASSWORD=secret\n"
      );
      await assert.rejects(
        run(shim, [], { cwd: consumerRoot, env: environment }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /unsupported agent environment key DATABASE_PASSWORD/);
          assert.match(error.stderr, /Only GH_TOKEN is supported/);
          return true;
        }
      );
      assert.equal((await readFile(issueStatePath, "utf8")).trim(), "OPEN");
      await assert.rejects(access(capturePath));
      await writeFile(agentEnvironmentPath, "GH_TOKEN=test-token\n");

      const recoveryWorktreeRoot = path.join(
        consumerRoot,
        ".sandcastle",
        "worktrees"
      );
      const redirectedWorktreePath = path.join(
        recoveryWorktreeRoot,
        "sandcastle-merger-verify-issue-42"
      );
      const outsideRecoveryRoot = path.join(consumerRoot, "outside-recovery");
      await mkdir(recoveryWorktreeRoot, { recursive: true });
      await mkdir(outsideRecoveryRoot);
      await symlink(outsideRecoveryRoot, redirectedWorktreePath);
      const recoveryMarkerPath = path.join(
        consumerRoot,
        ".sandcastle",
        "merger-recovery.json"
      );
      await writeFile(
        recoveryMarkerPath,
        JSON.stringify({
          baseBranch: "main",
          reviewedBranch: "sandcastle/issue-42",
          verificationWorktreePath: redirectedWorktreePath,
        })
      );
      await assert.rejects(
        run(shim, [], { cwd: consumerRoot, env: environment }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(
            `${error.stdout}\n${error.stderr}`,
            /Recovery worktree must be a real directory/
          );
          return true;
        }
      );
      assert.equal((await readFile(issueStatePath, "utf8")).trim(), "OPEN");
      await assert.rejects(access(capturePath));
      await access(recoveryMarkerPath);
      await rm(redirectedWorktreePath);
      await rm(outsideRecoveryRoot, { recursive: true });
      await rm(recoveryMarkerPath);

      const runLockPath = path.join(consumerRoot, ".sandcastle", "run.lock");
      const existingLock = '{"pid":99999999,"startedAt":"2026-01-01T00:00:00.000Z"}\n';
      await writeFile(runLockPath, existingLock);
      await assert.rejects(
        run(shim, [], { cwd: consumerRoot, env: environment }),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /Another Sandcastle workflow run already owns/);
          assert.match(error.stderr, /confirmed-stale lock/);
          return true;
        }
      );
      assert.equal(await readFile(runLockPath, "utf8"), existingLock);
      assert.equal((await readFile(issueStatePath, "utf8")).trim(), "OPEN");
      await assert.rejects(access(capturePath));
      await rm(runLockPath);

      const packageFingerprint = await fingerprintInstalledPackage(consumerRoot);
      const result = await run(shim, [], {
        cwd: consumerRoot,
        env: environment,
      });

      await assert.rejects(access(runLockPath));
      assert.equal(await readFile(recoverySymlinkTarget, "utf8"), "do not overwrite\n");
      assert.match(result.stdout, /Selected standalone issue #42/);
      assert.match(result.stdout, /Standalone merge complete/);
      assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
      assert.equal((await readFile(issueStatePath, "utf8")).trim(), "CLOSED");
      assert.equal(
        await fingerprintInstalledPackage(consumerRoot),
        packageFingerprint
      );
      const captures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const implementer = captures.find((entry) =>
        entry.name?.includes("implementer")
      );
      assert.equal(implementer.promptArgs.PROJECT_GUIDANCE, projectGuidance);
      assert.match(
        implementer.promptFile,
        /dist\/defaults\/prompts\/standalone-implement-prompt\.md$/
      );
      assert.equal(implementer.promptFile.includes(".sandcastle"), false);
      const expected = manager.startsWith("npm")
        ? {
            INSTALL_COMMAND: "npm ci",
            TYPECHECK_COMMAND: "npm run typecheck",
            TEST_COMMAND: "npm test",
          }
        : {
            INSTALL_COMMAND: "pnpm install --frozen-lockfile",
            TYPECHECK_COMMAND: "pnpm typecheck",
            TEST_COMMAND: "pnpm test",
          };
      assert.deepEqual(
        {
          INSTALL_COMMAND: implementer.promptArgs.INSTALL_COMMAND,
          TYPECHECK_COMMAND: implementer.promptArgs.TYPECHECK_COMMAND,
          TEST_COMMAND: implementer.promptArgs.TEST_COMMAND,
        },
        expected
      );
      const sandbox = captures.find((entry) => entry.type === "sandbox");
      assert.equal(
        sandbox.hooks.sandbox.onSandboxReady.at(-1).command,
        expected.INSTALL_COMMAND
      );
      const phases = captures.filter((entry) => entry.type === "phase");
      assert.equal(phases.every((entry) => entry.logMode === 0o600), true);
      assert.equal(phases.every((entry) => entry.verbose === true), true);
      assert.equal(
        (await stat(path.join(consumerRoot, ".sandcastle"))).mode & 0o777,
        0o700
      );
      assert.equal(
        (await stat(path.join(consumerRoot, ".sandcastle", "logs"))).mode &
          0o777,
        0o700
      );
      const merger = captures.find((entry) => entry.name?.includes("merger"));
      assert.equal(merger.recoveryMode, 0o600);
      assert.equal(merger.recoveryState.baseBranch, "main");
      assert.equal(merger.recoveryState.reviewedBranch, "sandcastle/issue-42");
      assert.match(
        merger.recoveryState.verificationWorktreePath,
        /\.sandcastle\/worktrees\/sandcastle-merger-verify-issue-42$/
      );
      assert.match(
        merger.promptArgs.VERIFICATION_WORKTREE_PATH,
        /^\/home\/agent\/workspace\/\.sandcastle\/worktrees\//
      );
      assert.equal(
        merger.promptArgs.VERIFICATION_WORKTREE_PATH.includes(consumerRoot),
        false
      );
      await assert.rejects(
        access(path.join(consumerRoot, ".sandcastle", "merger-recovery.json"))
      );
      assert.deepEqual(
        await readdir(
          path.join(consumerRoot, ".sandcastle", "node-modules-overlays")
        ),
        []
      );
    });
  }

  it("executes one native spec child without agent-side work selection", async () => {
    const { consumerRoot, shim, binRoot, ghPath } = await prepareDryRunConsumer(
      "pnpm-spec-child"
    );
    await writeFile(
      path.join(consumerRoot, ".sandcastle", ".env"),
      "GH_TOKEN=test-token\n"
    );
    const issueStatePath = path.join(consumerRoot, "issue-state");
    await writeFile(issueStatePath, "OPEN\n");
    await writeFile(
      ghPath,
      `#!/bin/sh
if [ "$1 $2" = "label list" ]; then
  printf '%s\\n' '[{"name":"needs-triage"},{"name":"needs-info"},{"name":"ready-for-agent"},{"name":"ready-for-human"},{"name":"wontfix"}]'
elif [ "$1 $2" = "issue list" ]; then
  printf '%s\\n' '[{"id":"100","title":"Spec","createdAt":"2026-01-01T00:00:00Z","parentId":null},{"id":"101","title":"Child","createdAt":"2026-01-01T00:01:00Z","parentId":"100"}]'
elif [ "$1" = "api" ]; then
  if printf '%s\\n' "$2" | grep -q '/issues/100/sub_issues'; then
    printf '%s\\n' '[{"number":101,"title":"Child","state":"open","labels":[{"name":"ready-for-agent"}]}]'
  else
    printf '[]\\n'
  fi
elif [ "$1 $2" = "issue view" ]; then
  if printf '%s\\n' "$*" | grep -q -- '--json state'; then
    cat "$ISSUE_STATE"
  elif [ "$3" = "101" ]; then
    printf '%s\\n' '{"parent":{"number":100},"blockedBy":{"nodes":[]},"blocking":{"nodes":[{"number":100}]}}'
  else
    printf '%s\\n' '{"parent":null,"blockedBy":{"nodes":[{"number":101}]},"blocking":{"nodes":[]}}'
  fi
elif [ "$1 $2" = "issue close" ]; then
  printf 'CLOSED\\n' > "$ISSUE_STATE"
else
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi
`
    );
    await chmod(ghPath, 0o755);
    const dockerPath = path.join(binRoot, "docker");
    await writeFile(
      dockerPath,
      '#!/bin/sh\nif [ "$1 $2" = "image inspect" ]; then exit 0; fi\nexit 1\n'
    );
    await chmod(dockerPath, 0o755);
    const hookPath = await installFakeSandcastleBoundary(consumerRoot);
    const capturePath = path.join(consumerRoot, "fake-sandcastle-capture");

    const result = await run(shim, [], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        FAKE_SANDCASTLE_CAPTURE: capturePath,
        ISSUE_STATE: issueStatePath,
        NODE_OPTIONS: `--import=${hookPath}`,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.match(result.stdout, /Selected issue #101: Child/);
    assert.match(result.stdout, /Merge complete/);
    assert.equal((await readFile(issueStatePath, "utf8")).trim(), "CLOSED");
    const captures = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const implementer = captures.find((entry) =>
      entry.name?.startsWith("implementer:")
    );
    assert.equal(implementer.promptArgs.ISSUE_ID, "101");
    assert.equal(implementer.promptArgs.SPEC_ISSUE_ID, "100");
  });

  it("runs final review only after every direct child is closed", async () => {
    const { consumerRoot, shim, binRoot, ghPath } = await prepareDryRunConsumer(
      "pnpm-final-review"
    );
    await writeFile(
      path.join(consumerRoot, ".sandcastle", ".env"),
      "GH_TOKEN=test-token\n"
    );
    const issueStatePath = path.join(consumerRoot, "spec-state");
    await writeFile(issueStatePath, "OPEN\n");
    await writeFile(
      ghPath,
      `#!/bin/sh
if [ "$1 $2" = "label list" ]; then
  printf '%s\\n' '[{"name":"needs-triage"},{"name":"needs-info"},{"name":"ready-for-agent"},{"name":"ready-for-human"},{"name":"wontfix"}]'
elif [ "$1 $2" = "issue list" ]; then
  printf '%s\\n' '[{"id":"100","title":"Spec","createdAt":"2026-01-01T00:00:00Z","parentId":null}]'
elif [ "$1" = "api" ]; then
  if printf '%s\\n' "$2" | grep -q '/issues/100/sub_issues'; then
    printf '%s\\n' '[{"number":101,"title":"Child","state":"closed","labels":[]}]'
  else
    printf '[]\\n'
  fi
elif [ "$1 $2" = "issue view" ]; then
  if printf '%s\\n' "$*" | grep -q -- '--json state'; then
    cat "$ISSUE_STATE"
  elif [ "$3" = "101" ]; then
    printf '%s\\n' '{"parent":{"number":100},"blockedBy":{"nodes":[]},"blocking":{"nodes":[{"number":100}]}}'
  else
    printf '%s\\n' '{"parent":null,"blockedBy":{"nodes":[]},"blocking":{"nodes":[]}}'
  fi
elif [ "$1 $2" = "issue close" ]; then
  printf 'CLOSED\\n' > "$ISSUE_STATE"
else
  echo "unexpected gh arguments: $*" >&2
  exit 1
fi
`
    );
    await chmod(ghPath, 0o755);
    const dockerPath = path.join(binRoot, "docker");
    await writeFile(
      dockerPath,
      '#!/bin/sh\nif [ "$1 $2" = "image inspect" ]; then exit 0; fi\nexit 1\n'
    );
    await chmod(dockerPath, 0o755);
    const hookPath = await installFakeSandcastleBoundary(consumerRoot);
    const capturePath = path.join(consumerRoot, "fake-sandcastle-capture");

    const result = await run(shim, [], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        FAKE_SANDCASTLE_CAPTURE: capturePath,
        ISSUE_STATE: issueStatePath,
        NODE_OPTIONS: `--import=${hookPath}`,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.match(result.stdout, /Running final spec review/);
    assert.match(result.stdout, /Final spec review outcome: closed/);
    assert.match(result.stdout, /Spec #100 passed final review and closed/);
    assert.equal((await readFile(issueStatePath, "utf8")).trim(), "CLOSED");
    const captures = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const finalReview = captures.find((entry) =>
      entry.name?.includes("final-spec-reviewer")
    );
    assert.equal(finalReview.promptArgs.SPEC_ISSUE_ID, "100");
  });

  it("refuses to initialize through a symbolic project directory", async () => {
    const consumerRoot = await installConsumer("pnpm-symlink");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const outsideRoot = path.join(tempRoot, "outside-sandcastle");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, path.join(consumerRoot, ".sandcastle"));
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    await assert.rejects(run(shim, ["init"], { cwd: consumerRoot }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Refusing to initialize through symbolic Sandcastle directory/);
      return true;
    });
    assert.deepEqual(await readdir(outsideRoot), []);
  });

  it("refuses operational commands through a symbolic Sandcastle directory", async () => {
    const consumerRoot = await installConsumer("pnpm-runtime-symlink");
    await run("git", ["init", "--quiet"], { cwd: consumerRoot });
    const outsideRoot = path.join(tempRoot, "outside-runtime-sandcastle");
    await mkdir(outsideRoot);
    await symlink(outsideRoot, path.join(consumerRoot, ".sandcastle"));
    const shim = path.join(consumerRoot, "node_modules", ".bin", "sandcastle-workflow");

    await assert.rejects(
      run(shim, ["build-image"], { cwd: consumerRoot }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /Refusing to run through symbolic Sandcastle directory/
        );
        return true;
      }
    );
    assert.deepEqual(await readdir(outsideRoot), []);
  });

  it("rejects invalid usage before requiring a Git worktree", async () => {
    const consumerRoot = await installConsumer("pnpm-invalid");
    const entry = path.join(
      consumerRoot,
      "node_modules",
      "@vvatikiotis",
      "sandcastle-workflow",
      "dist",
      "cli.js"
    );

    await assert.rejects(
      run(process.execPath, [entry, "unknown-command"], { cwd: tempRoot }),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /Unknown command or invalid arguments/);
        assert.doesNotMatch(error.stderr, /Git worktree/);
        return true;
      }
    );
  });

  describe("preflight validation", () => {
    it("validates runner configuration strictly before planning", async () => {
      const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
        "pnpm-runner-config"
      );
      const configPath = path.join(consumerRoot, ".sandcastle", "sandcastle.env");
      const environment = {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      };
      const validConfig = `${validRunnerConfig}\n`;
      const cases = [
        {
          contents: validConfig.replace(
            "IMPLEMENTER_MODEL=test-model",
            "IMPLEMENTER_MODEL"
          ),
          diagnostic: /expected a KEY=value assignment/,
        },
        {
          contents: `${validConfig}IMPLEMENTER_MODEL=duplicate\n`,
          diagnostic: /duplicate configuration key IMPLEMENTER_MODEL/,
        },
        {
          contents: `${validConfig}UNKNOWN_SETTING=value\n`,
          diagnostic: /unknown configuration key UNKNOWN_SETTING/,
        },
        {
          contents: validConfig.replace(
            "IMPLEMENTER_EFFORT=low",
            "IMPLEMENTER_EFFORT="
          ),
          diagnostic: /IMPLEMENTER_EFFORT must not be empty/,
        },
        {
          contents: validConfig.replace("MERGER_MODEL=test-model\n", ""),
          diagnostic: /missing required configuration: MERGER_MODEL/,
        },
      ];

      for (const { contents, diagnostic } of cases) {
        await writeFile(configPath, contents);
        const error = await runExpectingFailure(shim, ["--dry-run"], {
          cwd: consumerRoot,
          env: environment,
        });
        assert.equal(error.code, 1);
        assert.match(error.stderr, diagnostic);
        assert.doesNotMatch(error.stdout, /=== Sandcastle dry run ===/);
      }

      await rm(configPath);
      const missing = await runExpectingFailure(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: environment,
      });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /sandcastle\.env is required/);
    });

    it("requires usable agent credentials only for runs that launch agents and never prints them", async () => {
      const { consumerRoot, shim, environment } = await prepareWorkflowConsumer(
        "pnpm-agent-credentials",
        { readyIssueLists: [[]] }
      );
      const agentEnvironmentPath = path.join(consumerRoot, ".sandcastle", ".env");
      const secrets = /file-secret|host-secret|first-secret|second-secret/;
      const hostEnvironment = { ...environment };
      delete hostEnvironment.GH_TOKEN;

      await rm(agentEnvironmentPath);
      const dryRun = await run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: hostEnvironment,
      });
      assert.match(dryRun.stdout, /SANDCASTLE RUN: COMPLETED/);
      const missing = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: hostEnvironment,
      });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /\.sandcastle\/\.env is required before launching agents/);

      const rejected = [
        { contents: "GH_TOKEN\n", diagnostic: /expected a KEY=value assignment/ },
        {
          contents: "GH_TOKEN=first-secret\nGH_TOKEN=second-secret\n",
          diagnostic: /duplicate environment key GH_TOKEN/,
        },
        { contents: "# No credential declared.\n", diagnostic: /must declare GH_TOKEN/ },
        { contents: "GH_TOKEN=\n", diagnostic: /no usable credential was provided/ },
        { contents: 'GH_TOKEN="   "\n', diagnostic: /no usable credential was provided/ },
      ];
      for (const { contents, diagnostic } of rejected) {
        await writeFile(agentEnvironmentPath, contents);
        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: hostEnvironment,
        });
        assert.equal(error.code, 1);
        assert.match(error.stderr, diagnostic);
        assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, secrets);
      }

      await writeFile(agentEnvironmentPath, "GH_TOKEN=file-secret\n");
      const fromFile = await run(shim, [], {
        cwd: consumerRoot,
        env: hostEnvironment,
      });
      await writeFile(agentEnvironmentPath, "GH_TOKEN=\n");
      const fromHost = await run(shim, [], {
        cwd: consumerRoot,
        env: { ...hostEnvironment, GH_TOKEN: "host-secret" },
      });
      for (const result of [fromFile, fromHost]) {
        assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, secrets);
      }
    });

    it("requires effective Git ignore protection for runtime state and trackable workflow files", async () => {
      const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
        "pnpm-ignore-protection"
      );
      const environment = {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      };
      const dryRun = () =>
        run(shim, ["--dry-run"], { cwd: consumerRoot, env: environment });
      const dryRunFailure = () =>
        runExpectingFailure(shim, ["--dry-run"], {
          cwd: consumerRoot,
          env: environment,
        });
      const sandcastleIgnorePath = path.join(consumerRoot, ".sandcastle", ".gitignore");
      const rootIgnorePath = path.join(consumerRoot, ".gitignore");
      const initializedIgnore = await readFile(sandcastleIgnorePath, "utf8");
      const runtimePaths = [
        ".sandcastle/.env",
        ".sandcastle/sandcastle.env",
        ".sandcastle/logs/",
        ".sandcastle/worktrees/",
        ".sandcastle/node-modules-overlays/",
        ".sandcastle/merger-recovery.json",
        ".sandcastle/run.lock",
      ];

      await writeFile(
        sandcastleIgnorePath,
        initializedIgnore.replace(/^worktrees\/\n/m, "")
      );
      const unprotected = await dryRunFailure();
      assert.equal(unprotected.code, 1);
      assert.match(
        unprotected.stderr,
        /Git ignore protection is required for \.sandcastle\/worktrees\//
      );

      await writeFile(sandcastleIgnorePath, initializedIgnore);
      await writeFile(rootIgnorePath, "node_modules/\n.sandcastle/implement-prompt.md\n");
      const hidden = await dryRunFailure();
      assert.equal(hidden.code, 1);
      assert.match(
        hidden.stderr,
        /Workflow file \.sandcastle\/implement-prompt\.md must remain trackable/
      );

      await writeFile(sandcastleIgnorePath, "# Rules live in the root ignore file.\n");
      await writeFile(rootIgnorePath, ["node_modules/", ...runtimePaths, ""].join("\n"));
      // Planning refuses a dirty base checkout, so commit the accepted rules.
      await run("git", ["commit", "--quiet", "-am", "move ignore rules"], { cwd: consumerRoot });
      const otherSource = await dryRun();
      assert.match(otherSource.stdout, /SANDCASTLE RUN: COMPLETED/);

      await writeFile(sandcastleIgnorePath, initializedIgnore);
      await writeFile(rootIgnorePath, "node_modules/\n");
      await writeFile(path.join(consumerRoot, ".sandcastle", ".env"), "GH_TOKEN=\n");
      await run("git", ["add", "--force", ".sandcastle/.env"], { cwd: consumerRoot });
      const tracked = await dryRunFailure();
      assert.equal(tracked.code, 1);
      assert.match(
        tracked.stderr,
        /Git ignore rules cannot protect tracked Sandcastle paths: \.sandcastle\/\.env/
      );
    });
  });

  describe("standalone selection", () => {
    // One ready Specification with a single child, plus one Standalone Issue,
    // makes the runner ask the operator which Work Path to follow.
    const bothWorkPaths = {
      readyIssueLists: [
        [
          { id: "10", title: "Spec 10", createdAt: "2026-01-01T00:00:10Z", parentId: null },
          { id: "11", title: "Child 11", createdAt: "2026-01-01T00:00:11Z", parentId: "10" },
          standaloneIssue("42"),
        ],
      ],
      subIssues: {
        10: [{ number: 11, title: "Child 11", state: "open", labels: [{ name: "ready-for-agent" }] }],
      },
      parents: { 11: "10" },
      blocking: { 11: ["10"] },
    };

    // Runs a dry run in a pseudo-terminal from `script`, so the CLI sees an
    // interactive stdin. Each input is typed only after the next work-path
    // question is printed, because a line typed early is lost. The terminal
    // merges stdout and stderr. A hard kill turns a missed question into a
    // failure instead of a hang.
    async function dryRunInTerminal(manager, inputs) {
      const { consumerRoot, shim, environment } = await prepareWorkflowConsumer(
        manager,
        bothWorkPaths
      );
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const scriptArgs =
        process.platform === "darwin"
          ? ["-q", "/dev/null", shim, "--dry-run"]
          : ["-qec", `${quote(shim)} --dry-run`, "/dev/null"];
      const question = "[spec/standalone] ";
      return new Promise((resolve, reject) => {
        let output = "";
        let typed = 0;
        const child = execFile(
          "script",
          scriptArgs,
          { cwd: consumerRoot, env: environment, encoding: "utf8" },
          (error) => {
            clearTimeout(killTimer);
            if (error?.code === "ENOENT") {
              reject(
                new Error(
                  "The interactive work-path tests need the `script` command to provide a pseudo-terminal.",
                  { cause: error }
                )
              );
              return;
            }
            resolve({
              code: error ? error.code : 0,
              signal: error ? error.signal : null,
              output,
            });
          }
        );
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const asked = output.split(question).length - 1;
          while (typed < asked && typed < inputs.length) {
            child.stdin.write(inputs[typed]);
            typed += 1;
          }
        });
      });
    }

    // Runs the CLI with a piped stdin that stays open and never answers, so a
    // run that waits for a work-path answer is killed and fails instead of
    // hanging the suite.
    async function runWithoutTerminal(manager, args) {
      const prepared = await prepareWorkflowConsumer(manager, bothWorkPaths);
      const { consumerRoot, shim, environment } = prepared;
      const result = await new Promise((resolve) => {
        const child = execFile(
          shim,
          args,
          { cwd: consumerRoot, env: environment, encoding: "utf8" },
          (error, stdout, stderr) => {
            clearTimeout(killTimer);
            resolve({
              code: error ? error.code : 0,
              signal: error ? error.signal : null,
              stdout,
              stderr,
            });
          }
        );
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      });
      return { ...prepared, result };
    }

    it("exits with status 2 when a dry run needs a work path choice without a terminal", async () => {
      const { result } = await runWithoutTerminal("pnpm-work-path-no-tty-dry-run", ["--dry-run"]);

      assert.equal(result.signal, null, "the dry run hung waiting for a work-path answer");
      assert.equal(result.code, 2);
      assert.match(result.stderr, /Both ready spec work and standalone issues are available/);
      assert.match(result.stderr, /choosing a work path needs an interactive terminal/);
      assert.match(result.stdout, /SANDCASTLE RUN: STOPPED/);
    });

    it("exits with status 2 before starting agents when a run needs a work path choice without a terminal", async () => {
      const { result, capturePath, fixturePath } = await runWithoutTerminal(
        "pnpm-work-path-no-tty-run",
        []
      );

      assert.equal(result.signal, null, "the run hung waiting for a work-path answer");
      assert.equal(result.code, 2);
      assert.match(result.stderr, /choosing a work path needs an interactive terminal/);
      assert.deepEqual(await readCapturedPhases(capturePath), []);
      assert.deepEqual(await readClosedIssues(fixturePath), []);
    });

    it("asks for the spec or standalone work path and follows the standalone answer", async () => {
      const result = await dryRunInTerminal("pnpm-work-path-standalone", ["standalone\n"]);

      assert.equal(result.signal, null, "the dry run hung waiting for a work-path answer");
      assert.equal(result.code, 0);
      assert.match(result.output, /Follow the spec path or the standalone path\? \[spec\/standalone\]/);
      assert.match(result.output, /Selected standalone path\. Would implement standalone issue #42 next\./);
      assert.doesNotMatch(result.output, /orphan/i);
    });

    it("rejects orphan as a work path answer", async () => {
      const result = await dryRunInTerminal("pnpm-work-path-orphan", ["orphan\n", "spec\n"]);

      assert.equal(result.signal, null, "the dry run hung waiting for a work-path answer");
      assert.equal(result.code, 0);
      assert.match(result.output, /Please enter "spec" or "standalone"\./);
      assert.doesNotMatch(result.output, /Selected standalone path/);
    });

    it("exits with status 2 when the terminal closes stdin at the work path question", async () => {
      const result = await dryRunInTerminal("pnpm-work-path-ctrl-d", ["\x04"]);

      assert.equal(result.signal, null, "the dry run hung after stdin closed");
      assert.equal(result.code, 2);
      assert.match(result.output, /choosing a work path needs an interactive terminal/);
      assert.match(result.output, /SANDCASTLE RUN: STOPPED/);
    });

    it("aborts with status 130 when Ctrl-C is pressed at the work path question", async () => {
      const result = await dryRunInTerminal("pnpm-work-path-ctrl-c", ["\x03"]);

      assert.equal(result.signal, null, "the dry run hung after Ctrl-C");
      assert.equal(result.code, 130);
      assert.match(result.output, /SANDCASTLE RUN: ABORTED/);
      assert.match(result.output, /Received SIGINT\./);
    });

    it("stops when a stale standalone selection disappears during replanning", async () => {
      const { consumerRoot, shim, environment, capturePath } =
        await prepareWorkflowConsumer("pnpm-stale-standalone", {
          readyIssueLists: [[standaloneIssue("42")], []],
        });
      // One iteration is spent on the stale selection; replanning needs a second.
      await writeFile(
        path.join(consumerRoot, ".sandcastle", "sandcastle.env"),
        `${validRunnerConfig.replace("MAX_ITERATIONS=1", "MAX_ITERATIONS=2")}\n`
      );

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: environment,
      });

      assert.equal(error.code, 3);
      assert.match(error.stdout, /SANDCASTLE RUN: STOPPED/);
      assert.match(error.stdout, /stale selections were replanned/);
      assert.deepEqual(await readCapturedPhases(capturePath), []);
    });

    it("shows a blocked standalone issue as waiting and plans the next unblocked one", async () => {
      const { consumerRoot, shim, environment } = await prepareWorkflowConsumer(
        "pnpm-blocked-dry-run",
        {
          readyIssueLists: [[standaloneIssue("42"), standaloneIssue("43")]],
          blockers: { 42: ["7"] },
        }
      );

      const result = await run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: environment,
      });

      assert.match(result.stdout, /#42\b.*waiting.*#7\b/);
      assert.match(result.stdout, /Would implement standalone issue #43 next/);
    });

    it("skips a blocked standalone issue and implements the next unblocked one", async () => {
      const { consumerRoot, shim, environment, capturePath, fixturePath } =
        await prepareWorkflowConsumer("pnpm-blocked-skip", {
          readyIssueLists: [[standaloneIssue("42"), standaloneIssue("43")]],
          blockers: { 42: ["7"] },
        });

      // MAX_ITERATIONS=1 ends the run after #43, so only its output matters.
      const result = await run(shim, [], {
        cwd: consumerRoot,
        env: environment,
      }).catch((error) => error);

      assert.match(result.stdout, /Selected standalone issue #43/);
      assert.doesNotMatch(result.stdout, /Selected standalone issue #42/);
      // A blocked issue is never selected, so it cannot become a stale selection.
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /stale/i);
      assert.deepEqual(await readClosedIssues(fixturePath), ["43"]);
      assert.deepEqual(await readCapturedPhases(capturePath), [
        "standalone-implementer",
        "standalone-reviewer",
        "standalone-merger",
      ]);
    });

    it("stops with status 3 and lists open blockers when every standalone issue is blocked", async () => {
      const { consumerRoot, shim, environment, capturePath, fixturePath } =
        await prepareWorkflowConsumer("pnpm-blocked-all", {
          readyIssueLists: [[standaloneIssue("42")]],
          blockers: { 42: ["7", "8"] },
          closed: ["8"],
        });

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: environment,
      });

      assert.equal(error.code, 3);
      assert.match(error.stdout, /SANDCASTLE RUN: STOPPED/);
      assert.match(`${error.stdout}\n${error.stderr}`, /#42\b.*#7\b/);
      assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /#8\b/);
      assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /stale/i);
      assert.deepEqual(await readCapturedPhases(capturePath), []);
      assert.deepEqual(await readClosedIssues(fixturePath), []);
    });
  });

  describe("optional consumer guidance", () => {
    it("reports missing coding standards and agent instructions without stopping", async () => {
      const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
        "pnpm-optional-guidance"
      );
      const environment = {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      };
      // Planning refuses a dirty base checkout, so commit each guidance change.
      await run("git", ["rm", "--quiet", "CODING_STANDARDS.md"], { cwd: consumerRoot });
      await run("git", ["commit", "--quiet", "-m", "drop guidance"], { cwd: consumerRoot });

      const missingBoth = await run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: environment,
      });
      assert.match(missingBoth.stdout, /SANDCASTLE RUN: COMPLETED/);
      assert.match(
        missingBoth.stdout,
        /No CODING_STANDARDS\.md found.*general good practice/
      );
      assert.match(missingBoth.stdout, /No AGENTS\.md found/);

      await writeFile(path.join(consumerRoot, "CODING_STANDARDS.md"), "# Standards\n");
      await writeFile(path.join(consumerRoot, "AGENTS.md"), "# Agents\n");
      await run("git", ["add", "CODING_STANDARDS.md", "AGENTS.md"], { cwd: consumerRoot });
      await run("git", ["commit", "--quiet", "-m", "add guidance"], { cwd: consumerRoot });
      const presentBoth = await run(shim, ["--dry-run"], {
        cwd: consumerRoot,
        env: environment,
      });
      assert.match(presentBoth.stdout, /SANDCASTLE RUN: COMPLETED/);
      assert.doesNotMatch(presentBoth.stdout, /No CODING_STANDARDS\.md found/);
      assert.doesNotMatch(presentBoth.stdout, /No AGENTS\.md found/);
    });
  });

  describe("Dockerfile guard", () => {
    for (const { role, stopsBefore } of [
      { role: "implementer", stopsBefore: "reviewer" },
      { role: "reviewer", stopsBefore: "merger" },
    ]) {
      it(`aborts when the ${role} changes a Dockerfile`, async () => {
        const { consumerRoot, shim, environment, capturePath, fixturePath } =
          await prepareWorkflowConsumer(`pnpm-dockerfile-${role}`, {
            readyIssueLists: [[standaloneIssue("42")]],
          });

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: { ...environment, FAKE_AGENT_FILE_CHANGE: `${role}:tools/Dockerfile` },
        });

        const banner = `ABORTING RUN: ${role} for issue #42 changed Dockerfile(s): tools/Dockerfile.`;
        assert.equal(error.code, 1);
        assert.ok(`${error.stdout}\n${error.stderr}`.includes(banner));
        const logs = await readLogs(consumerRoot);
        assert.ok(
          logs.some(({ name, contents }) => name.includes(role) && contents.includes(banner))
        );
        assert.equal((await readCapturedPhases(capturePath)).includes(stopsBefore), false);
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }

    it("fast-forwards the base and closes the issue after merger verification fixes", async () => {
      const { consumerRoot, shim, environment, fixturePath } =
        await prepareWorkflowConsumer("pnpm-merger-fix", {
          readyIssueLists: [[standaloneIssue("42")]],
        });

      await run(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_AGENT_FILE_CHANGE: "merger:src/fix.js" },
      });

      const { stdout: baseFiles } = await run("git", ["ls-tree", "-r", "--name-only", "main"], {
        cwd: consumerRoot,
      });
      assert.ok(baseFiles.split("\n").includes("src/fix.js"));
      assert.deepEqual(await readClosedIssues(fixturePath), ["42"]);
    });

    it("aborts before the base moves when the merger changes a Dockerfile", async () => {
      const { consumerRoot, shim, environment, fixturePath } =
        await prepareWorkflowConsumer("pnpm-dockerfile-merger", {
          readyIssueLists: [[standaloneIssue("42")]],
        });
      const { stdout: baseBefore } = await run("git", ["rev-parse", "main"], {
        cwd: consumerRoot,
      });

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_AGENT_FILE_CHANGE: "merger:Dockerfile" },
      });

      const banner = "ABORTING RUN: merger for issue #42 changed Dockerfile(s): Dockerfile.";
      assert.equal(error.code, 1);
      assert.ok(`${error.stdout}\n${error.stderr}`.includes(banner));
      const logs = await readLogs(consumerRoot);
      assert.ok(
        logs.some(({ name, contents }) => name.includes("merger") && contents.includes(banner))
      );
      const { stdout: baseAfter } = await run("git", ["rev-parse", "main"], {
        cwd: consumerRoot,
      });
      assert.equal(baseAfter, baseBefore);
      assert.deepEqual(await readClosedIssues(fixturePath), []);
    });
  });
});
