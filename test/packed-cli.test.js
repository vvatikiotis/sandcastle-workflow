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
const packageVersion = "0.2.2";
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
  readFileSync,
  statSync,
  symlinkSync,
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
      });
      if (runOptions.name.includes("implementer")) {
        addCommit(options.cwd, options.branch, "sandcastle(implementer): #42: fake implementation");
        if (process.env.RECOVERY_SYMLINK_TARGET) {
          symlinkSync(
            process.env.RECOVERY_SYMLINK_TARGET,
            options.cwd + "/.sandcastle/merger-recovery.json"
          );
        }
        return { stdout: "<phase-outcome>implemented</phase-outcome>\\n<promise>COMPLETE</promise>" };
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
  execFileSync("git", ["merge", "--ff-only", options.promptArgs.BRANCH], { cwd: options.cwd });
  execFileSync("gh", ["issue", "close", options.promptArgs.ISSUE_ID], { cwd: options.cwd });
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

      const installedPackageRoot = await realpath(path.dirname(path.dirname(entry)));
      assert.equal(installedPackageRoot.startsWith(packageRoot), false);
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
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.match(result.stdout, /Docker image: sandcastle:pnpm-docker-v0\.2\.2/);
    assert.match(result.stdout, /Dockerfile: .*dist\/defaults\/docker\/Dockerfile \(built-in\)/);
    assert.match(
      result.stdout,
      /Build arguments: AGENT_UID=\d+, AGENT_GID=\d+/
    );
    const dockerArguments = (await readFile(capturePath, "utf8")).trim().split("\n");
    const fileIndex = dockerArguments.indexOf("--file");
    const tagIndex = dockerArguments.indexOf("--tag");
    assert.equal(dockerArguments[tagIndex + 1], "sandcastle:pnpm-docker-v0.2.2");
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
        assert.match(error.stderr, /Dockerfile override resolves outside/);
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
      return true;
    });

    manifest.packageManager = "pnpm@10.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(runDry(), (error) => {
      assert.match(error.stderr, /supports pnpm 11/);
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
        assert.match(
          `${error.stdout}\n${error.stderr}`,
          /more than 100 open ready-for-agent issues/
        );
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

  it("accepts phase-specific project guidance without replacing the built-in prompt", async () => {
    const { consumerRoot, shim, binRoot } = await prepareDryRunConsumer(
      "pnpm-prompt-guidance"
    );
    const guidancePath = path.join(
      consumerRoot,
      ".sandcastle",
      "standalone-implement-prompt.md"
    );
    await writeFile(guidancePath, "Run the project-specific acceptance check.\n");

    const result = await run(shim, ["--dry-run"], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.match(
      result.stdout,
      /Prompt standalone-implement-prompt\.md: built-in .*dist\/defaults\/prompts\/standalone-implement-prompt\.md/
    );
    assert.match(
      result.stdout,
      /Project guidance standalone-implement-prompt\.md: .*\.sandcastle\/standalone-implement-prompt\.md/
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
});
