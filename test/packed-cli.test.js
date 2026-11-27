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
  "IMPLEMENTER_AGENT=codex",
  "IMPLEMENTER_MODEL=test-model",
  "IMPLEMENTER_EFFORT=low",
  "REVIEWER_AGENT=codex",
  "REVIEWER_MODEL=test-model",
  "REVIEWER_EFFORT=low",
  "REPORTER_AGENT=codex",
  "REPORTER_MODEL=test-model",
  "REPORTER_EFFORT=low",
  "FINAL_SPEC_REVIEWER_AGENT=codex",
  "FINAL_SPEC_REVIEWER_MODEL=test-model",
  "FINAL_SPEC_REVIEWER_EFFORT=low",
  "MAX_ITERATIONS=1",
].join("\n");

// The valid runner configuration with the given roles, keyed by key prefix
// such as IMPLEMENTER, switched to another agent.
function runnerConfigWithAgents(agents) {
  let config = validRunnerConfig;
  for (const [prefix, agent] of Object.entries(agents)) {
    config = config.replace(`${prefix}_AGENT=codex`, `${prefix}_AGENT=${agent}`);
  }
  return `${config}\n`;
}

const allRolesOnClaudeCode = {
  IMPLEMENTER: "claude-code",
  REVIEWER: "claude-code",
  REPORTER: "claude-code",
  FINAL_SPEC_REVIEWER: "claude-code",
};

let tempRoot;
let tarballPath;

// A host home directory holding the chosen agent logins. The runner reads
// agent logins beneath the home directory, so workflow runs point HOME here.
async function createAgentHome({ codex = false, claude = false } = {}) {
  const home = await mkdtemp(path.join(tempRoot, "home-"));
  if (codex) {
    await mkdir(path.join(home, ".codex"));
    await writeFile(path.join(home, ".codex", "auth.json"), '{"fake":"codex"}\n');
  }
  if (claude) {
    await mkdir(path.join(home, ".claude"));
    await writeFile(path.join(home, ".claude", ".credentials.json"), '{"fake":"claude"}\n');
  }
  return home;
}

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

  await copyFile(
    path.join(packageRoot, "test", "fake-sandcastle.mjs"),
    fakeModulePath
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
  : { closed: [], comments: [], listCalls: 0 };
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
} else if (command === "issue" && action === "comment") {
  const bodyFile = args[args.indexOf("--body-file") + 1];
  state.comments.push({ issue: String(target), body: readFileSync(bodyFile, "utf8") });
  save();
} else if (command === "issue" && action === "edit") {
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
    HOME: await createAgentHome({ codex: true }),
    NODE_OPTIONS: `--import=${hookPath}`,
    PATH: `${binRoot}:${process.env.PATH ?? ""}`,
  };
  delete environment.CLAUDE_CODE_OAUTH_TOKEN;
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

async function readComments(fixturePath) {
  try {
    return JSON.parse(await readFile(`${fixturePath}.state`, "utf8")).comments;
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
      "package/dist/defaults/prompts/report-prompt.md",
      "package/dist/defaults/prompts/review-prompt.md",
      "package/dist/defaults/prompts/standalone-implement-prompt.md",
      "package/dist/defaults/prompts/standalone-report-prompt.md",
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
      "/run.lock",
    ]) {
      assert.equal(entries.some((entry) => entry.includes(forbidden)), false);
    }

    for (const promptName of [
      "implement-prompt.md",
      "report-prompt.md",
      "standalone-implement-prompt.md",
      "standalone-report-prompt.md",
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
      if (promptName.includes("report")) {
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
    const runnerExample = await readFile(examplePath, "utf8");
    // Every key comes with a comment that gives an example value.
    const assertDocumented = (contents, key, allowed) => {
      assert.match(contents, new RegExp(`^${key}=$`, "m"), `${key} is not listed`);
      assert.match(
        contents,
        new RegExp(`^# .*${allowed}.*Example: ${key}=\\S+.*\\n${key}=$`, "m"),
        `${key} has no comment with its allowed values and an example`
      );
    };
    for (const prefix of ["IMPLEMENTER", "REVIEWER", "REPORTER", "FINAL_SPEC_REVIEWER"]) {
      assertDocumented(runnerExample, `${prefix}_AGENT`, "codex or claude-code");
      assertDocumented(runnerExample, `${prefix}_MODEL`, "model");
      assertDocumented(runnerExample, `${prefix}_EFFORT`, "low, medium, high, xhigh, or max");
    }
    assertDocumented(runnerExample, "MAX_ITERATIONS", "positive integer");
    assert.match(runnerExample, /^# .*image.*\n# .*Example: DOCKER_IMAGE=\S+\n# DOCKER_IMAGE=$/m);
    const agentEnvironmentExample = await readFile(
      path.join(sandcastleRoot, ".env.example"),
      "utf8"
    );
    assertDocumented(agentEnvironmentExample, "GH_TOKEN", "");
    assertDocumented(agentEnvironmentExample, "CLAUDE_CODE_OAUTH_TOKEN", "");
    assert.match(agentEnvironmentExample, /claude setup-token/);
    assert.match(agentEnvironmentExample, /macOS/);
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
      const hookMarkerPath = path.join(consumerRoot, "hook-marker");
      for (const hook of ["pre-rebase", "post-rewrite", "post-checkout", "post-merge"]) {
        const hookPath = path.join(consumerRoot, ".git", "hooks", hook);
        await writeFile(hookPath, `#!/bin/sh\necho ${hook} >> "${hookMarkerPath}"\n`);
        await chmod(hookPath, 0o755);
      }
      const environment = {
        ...process.env,
        FAKE_SANDCASTLE_CAPTURE: capturePath,
        HOME: await createAgentHome({ codex: true }),
        ISSUE_STATE: issueStatePath,
        NODE_OPTIONS: `--import=${hookPath}`,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
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
          assert.match(
            error.stderr,
            /Only GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are supported/
          );
          return true;
        }
      );
      assert.equal((await readFile(issueStatePath, "utf8")).trim(), "OPEN");
      await assert.rejects(access(capturePath));
      await writeFile(agentEnvironmentPath, "GH_TOKEN=test-token\n");

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
      assert.match(result.stdout, /Selected standalone issue #42/);
      assert.match(result.stdout, /Integration complete for standalone issue #42\./);
      assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
      assert.match(
        result.stdout,
        /Reason: Reached the 1-iteration limit after integrating standalone issue #42\./
      );
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
      // One issue sandbox runs both agents and Integration; nothing runs in
      // head mode, and the Reporter does not start.
      assert.deepEqual(
        captures.filter((entry) => entry.type === "sandbox").map((entry) => entry.branch),
        ["sandcastle/issue-42"]
      );
      assert.equal(captures.some((entry) => entry.type === "head-run"), false);
      assert.deepEqual(
        phases.map((entry) => entry.name.split(":")[0]),
        ["implementer", "reviewer"]
      );
      const execs = captures
        .filter((entry) => entry.type === "exec")
        .map((entry) => entry.command);
      assert.ok(
        execs.some((command) => /^git -c core\.hooksPath=\/dev\/null rebase /.test(command)),
        execs.join("\n")
      );
      for (const command of Object.values(expected)) {
        assert.ok(execs.includes(command), `${command} was not run: ${execs.join("\n")}`);
      }
      const { stdout: baseFiles } = await run("git", ["ls-tree", "-r", "--name-only", "main"], {
        cwd: consumerRoot,
      });
      assert.ok(baseFiles.split("\n").includes("src/issue-42.js"));
      const { stdout: branches } = await run("git", ["branch", "--list", "sandcastle/*"], {
        cwd: consumerRoot,
      });
      assert.equal(branches.trim(), "");
      assert.deepEqual(
        await readdir(path.join(consumerRoot, ".sandcastle", "worktrees")),
        []
      );
      await assert.rejects(access(hookMarkerPath));
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
        HOME: await createAgentHome({ codex: true }),
        ISSUE_STATE: issueStatePath,
        NODE_OPTIONS: `--import=${hookPath}`,
        PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      },
    });

    assert.match(result.stdout, /Selected child issue #101: Child/);
    assert.match(result.stdout, /Integration complete for child issue #101\./);
    assert.match(
      result.stdout,
      /Reason: Reached the 1-iteration limit after integrating child issue #101\./
    );
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
        HOME: await createAgentHome({ codex: true }),
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
          contents: validConfig.replace("REPORTER_MODEL=test-model\n", ""),
          diagnostic: /missing required configuration: REPORTER_MODEL/,
        },
        {
          contents: validConfig.replace("IMPLEMENTER_AGENT=codex\n", ""),
          diagnostic: /missing required configuration: IMPLEMENTER_AGENT\./,
        },
        {
          contents: validConfig.replace("REVIEWER_AGENT=codex", "REVIEWER_AGENT="),
          diagnostic: /sandcastle\.env:4: REVIEWER_AGENT must not be empty/,
        },
        {
          contents: validConfig.replace("REPORTER_AGENT=codex", "REPORTER_AGENT=claude"),
          diagnostic:
            /sandcastle\.env:7: REPORTER_AGENT must be one of codex, claude-code\./,
        },
        {
          contents: validConfig
            .replace("FINAL_SPEC_REVIEWER_AGENT=codex", "FINAL_SPEC_REVIEWER_AGENT=claude-code")
            .replace("FINAL_SPEC_REVIEWER_EFFORT=low", "FINAL_SPEC_REVIEWER_EFFORT=minimal"),
          diagnostic:
            /sandcastle\.env:12: FINAL_SPEC_REVIEWER_EFFORT must be one of low, medium, high, xhigh, max when FINAL_SPEC_REVIEWER_AGENT is claude-code\./,
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

      // Codex effort stays unchecked; every Claude Code effort is accepted.
      const accepted = [
        validConfig.replace("IMPLEMENTER_EFFORT=low", "IMPLEMENTER_EFFORT=minimal"),
        ...["low", "medium", "high", "xhigh", "max"].map((effort) =>
          runnerConfigWithAgents({ REVIEWER: "claude-code" }).replace(
            "REVIEWER_EFFORT=low",
            `REVIEWER_EFFORT=${effort}`
          )
        ),
      ];
      for (const contents of accepted) {
        await writeFile(configPath, contents);
        const result = await run(shim, ["--dry-run"], {
          cwd: consumerRoot,
          env: environment,
        });
        assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
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

  describe("agent choice", () => {
    const oneStandaloneIssue = { readyIssueLists: [[standaloneIssue("42")]] };

    async function readCaptures(capturePath) {
      return (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    }

    // Prepares a consumer whose roles run the given agents and whose host
    // home holds the given logins.
    async function prepareAgentConsumer(manager, { agents = {}, logins }) {
      const prepared = await prepareWorkflowConsumer(manager, oneStandaloneIssue);
      await writeFile(
        path.join(prepared.consumerRoot, ".sandcastle", "sandcastle.env"),
        runnerConfigWithAgents(agents)
      );
      const environment = { ...prepared.environment, HOME: await createAgentHome(logins) };
      return { ...prepared, environment };
    }

    it("runs each role with its configured agent, model, and effort", async () => {
      const { consumerRoot, shim, environment, capturePath } = await prepareAgentConsumer(
        "pnpm-agent-mixed",
        { agents: { IMPLEMENTER: "claude-code" }, logins: { codex: true, claude: true } }
      );
      const configPath = path.join(consumerRoot, ".sandcastle", "sandcastle.env");
      await writeFile(
        configPath,
        (await readFile(configPath, "utf8"))
          .replace("IMPLEMENTER_MODEL=test-model", "IMPLEMENTER_MODEL=claude-test-model")
          .replace("IMPLEMENTER_EFFORT=low", "IMPLEMENTER_EFFORT=xhigh")
      );

      const result = await run(shim, [], { cwd: consumerRoot, env: environment });

      assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
      const captures = await readCaptures(capturePath);
      const agents = Object.fromEntries(
        captures
          .filter((entry) => entry.type === "phase")
          .map((entry) => [entry.name.split(":")[0], entry.agent])
      );
      assert.deepEqual(agents, {
        implementer: {
          provider: "claude-code",
          model: "claude-test-model",
          options: { effort: "xhigh" },
        },
        reviewer: { provider: "codex", model: "test-model", options: { effort: "low" } },
      });
      // Both agents share the issue sandbox, so it carries both logins.
      const sandbox = captures.find((entry) => entry.type === "sandbox");
      assert.deepEqual(
        sandbox.mounts
          .filter((mount) => mount.readonly)
          .map((mount) => mount.sandboxPath)
          .sort(),
        ["/mnt/host-claude", "/mnt/host-codex"]
      );
      const hooks = sandbox.hooks.sandbox.onSandboxReady.map((hook) => hook.command);
      assert.equal(hooks.length, 3);
      assert.ok(hooks.some((hook) => /cp "\/mnt\/host-codex\/auth\.json"/.test(hook)));
      assert.ok(
        hooks.some((hook) =>
          /cp "\/mnt\/host-claude\/\.credentials\.json" "\/home\/agent\/\.claude\/\.credentials\.json"/.test(hook)
        )
      );
      assert.equal(hooks.at(-1), "pnpm install --frozen-lockfile");
    });

    it("runs a Codex-only config without ~/.claude and never forwards the Claude Code token", async () => {
      const { consumerRoot, shim, environment, capturePath } = await prepareAgentConsumer(
        "pnpm-agent-codex-only",
        { logins: { codex: true } }
      );

      const result = await run(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, CLAUDE_CODE_OAUTH_TOKEN: "unused-token" },
      });

      assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
      const sandbox = (await readCaptures(capturePath)).find((entry) => entry.type === "sandbox");
      assert.deepEqual(
        sandbox.mounts.filter((mount) => mount.readonly).map((mount) => mount.hostPath),
        [path.join(environment.HOME, ".codex")]
      );
      assert.equal(sandbox.env.CODEX_HOME, "/home/agent/.codex");
      assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in sandbox.env, false);
      assert.equal(
        sandbox.hooks.sandbox.onSandboxReady.some((hook) => hook.command.includes(".claude")),
        false
      );
    });

    it("runs a Claude-only config without ~/.codex", async () => {
      const { consumerRoot, shim, environment, capturePath } = await prepareAgentConsumer(
        "pnpm-agent-claude-only",
        { agents: allRolesOnClaudeCode, logins: { claude: true } }
      );

      const result = await run(shim, [], { cwd: consumerRoot, env: environment });

      assert.match(result.stdout, /SANDCASTLE RUN: COMPLETED/);
      const captures = await readCaptures(capturePath);
      assert.equal(
        captures
          .filter((entry) => entry.type === "phase")
          .every((entry) => entry.agent.provider === "claude-code"),
        true
      );
      const sandbox = captures.find((entry) => entry.type === "sandbox");
      assert.deepEqual(
        sandbox.mounts.filter((mount) => mount.readonly),
        [
          {
            hostPath: path.join(environment.HOME, ".claude"),
            sandboxPath: "/mnt/host-claude",
            readonly: true,
          },
        ]
      );
      assert.equal("CODEX_HOME" in sandbox.env, false);
      assert.equal(
        sandbox.hooks.sandbox.onSandboxReady.some((hook) => hook.command.includes("codex")),
        false
      );
    });

    it("stops before any sandbox starts when an agent in use has no login, except in a dry run", async () => {
      const { consumerRoot, shim, environment, capturePath, fixturePath } =
        await prepareAgentConsumer("pnpm-agent-missing-login", {
          agents: { REVIEWER: "claude-code", REPORTER: "claude-code" },
          logins: {},
        });

      const dryRun = await run(shim, ["--dry-run"], { cwd: consumerRoot, env: environment });
      assert.match(dryRun.stdout, /SANDCASTLE RUN: COMPLETED/);

      const bothMissing = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: environment,
      });
      assert.equal(bothMissing.code, 1);
      assert.match(
        bothMissing.stderr,
        /Codex \(codex\) has no login for the Implementer and Final Spec Reviewer: .*\.codex\/auth\.json is not a readable file\. Run `codex login`/
      );
      assert.match(
        bothMissing.stderr,
        /Claude Code \(claude-code\) has no login for the Reviewer and Reporter: CLAUDE_CODE_OAUTH_TOKEN is not set .*\.claude\/\.credentials\.json is not a readable file\. Run `claude setup-token`.*on macOS/
      );

      await mkdir(path.join(environment.HOME, ".codex"));
      await writeFile(path.join(environment.HOME, ".codex", "auth.json"), "{}\n");
      const claudeMissing = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: environment,
      });
      assert.equal(claudeMissing.code, 1);
      assert.match(claudeMissing.stderr, /Claude Code \(claude-code\) has no login/);
      assert.doesNotMatch(claudeMissing.stderr, /Codex \(codex\) has no login/);

      // No sandbox started, so the fake recorded nothing.
      await assert.rejects(access(capturePath));
      assert.deepEqual(await readClosedIssues(fixturePath), []);
    });

    it("prefers CLAUDE_CODE_OAUTH_TOKEN over the ~/.claude login, from the file or else the host", async () => {
      const { consumerRoot, shim, environment, capturePath } = await prepareAgentConsumer(
        "pnpm-agent-token",
        { agents: allRolesOnClaudeCode, logins: { claude: true } }
      );
      const agentEnvironmentPath = path.join(consumerRoot, ".sandcastle", ".env");

      await writeFile(agentEnvironmentPath, "GH_TOKEN=test-token\nCLAUDE_CODE_OAUTH_TOKEN=claude-file-secret\n");
      const fromFile = await run(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, CLAUDE_CODE_OAUTH_TOKEN: "claude-host-secret" },
      });
      assert.match(fromFile.stdout, /SANDCASTLE RUN: COMPLETED/);
      const fileSandbox = (await readCaptures(capturePath)).find((entry) => entry.type === "sandbox");
      assert.equal(fileSandbox.env.CLAUDE_CODE_OAUTH_TOKEN, "claude-file-secret");
      assert.equal(fileSandbox.mounts.some((mount) => mount.readonly), false);
      assert.deepEqual(
        fileSandbox.hooks.sandbox.onSandboxReady.map((hook) => hook.command),
        ["pnpm install --frozen-lockfile"]
      );

      // Without ~/.claude, a host token alone is a login.
      const hostOnly = await prepareAgentConsumer("pnpm-agent-host-token", {
        agents: allRolesOnClaudeCode,
        logins: {},
      });
      await writeFile(
        path.join(hostOnly.consumerRoot, ".sandcastle", ".env"),
        "GH_TOKEN=test-token\nCLAUDE_CODE_OAUTH_TOKEN=\n"
      );
      const fromHost = await run(hostOnly.shim, [], {
        cwd: hostOnly.consumerRoot,
        env: { ...hostOnly.environment, CLAUDE_CODE_OAUTH_TOKEN: "claude-host-secret" },
      });
      assert.match(fromHost.stdout, /SANDCASTLE RUN: COMPLETED/);
      const hostSandbox = (await readCaptures(hostOnly.capturePath)).find(
        (entry) => entry.type === "sandbox"
      );
      assert.equal(hostSandbox.env.CLAUDE_CODE_OAUTH_TOKEN, "claude-host-secret");
      for (const result of [fromFile, fromHost]) {
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /claude-file-secret|claude-host-secret/);
      }
    });

    for (const { role, agent, agentName, command, agents, login } of [
      {
        role: "Implementer",
        agent: "claude-code",
        agentName: "Claude Code",
        command: "claude",
        agents: { IMPLEMENTER: "claude-code" },
        login: /claude setup-token/,
      },
      {
        role: "Reviewer",
        agent: "codex",
        agentName: "Codex",
        command: "codex",
        agents: {},
        login: /codex login/,
      },
    ]) {
      it(`ends the run with status 1 when ${agentName} cannot start for the ${role}`, async () => {
        const { consumerRoot, shim, environment, fixturePath } = await prepareAgentConsumer(
          `pnpm-agent-start-${agent}`,
          { agents, logins: { codex: true, claude: true } }
        );

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: {
            ...environment,
            FAKE_AGENT_START_FAILURE: `${role.toLowerCase()}:${command}`,
          },
        });

        assert.equal(error.code, 1);
        const escape = (text) => text.replace(/[()]/g, "\\$&");
        assert.match(
          error.stderr,
          new RegExp(`The ${role} could not run ${escape(`${agentName} (${agent})`)}\\. Check that the Docker image provides the \`${command}\` command`)
        );
        assert.match(error.stderr, login);
        assert.match(error.stderr, new RegExp(`Cause: ${agent} exited with code 127`));
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }
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
        "implementer",
        "reviewer",
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

  describe("leftover issue branch", () => {
    it("runs the implementer when a leftover branch has no commits of its own and the base moved on", async () => {
      const { consumerRoot, shim, environment, capturePath } =
        await prepareWorkflowConsumer("pnpm-leftover-behind", {
          readyIssueLists: [[standaloneIssue("42")]],
        });
      // An earlier run created the issue branch but committed nothing on it.
      await run("git", ["branch", "sandcastle/issue-42"], { cwd: consumerRoot });
      await run("git", ["commit", "--quiet", "--allow-empty", "-m", "base moves on"], {
        cwd: consumerRoot,
      });

      const result = await run(shim, [], { cwd: consumerRoot, env: environment }).catch(
        (error) => error
      );

      assert.doesNotMatch(result.stdout, /Reusing committed implementation/);
      assert.equal((await readCapturedPhases(capturePath))[0], "implementer");
    });

    it("runs the spec implementer when a leftover child branch has no commits of its own and the base moved on", async () => {
      const { consumerRoot, shim, environment, capturePath } =
        await prepareWorkflowConsumer("pnpm-leftover-behind-spec", {
          readyIssueLists: [
            [
              { id: "10", title: "Spec 10", createdAt: "2026-01-01T00:00:10Z", parentId: null },
              { id: "11", title: "Child 11", createdAt: "2026-01-01T00:00:11Z", parentId: "10" },
            ],
          ],
          subIssues: {
            10: [{ number: 11, title: "Child 11", state: "open", labels: [{ name: "ready-for-agent" }] }],
          },
          parents: { 11: "10" },
          blockers: { 10: ["11"] },
          blocking: { 11: ["10"] },
        });
      await run("git", ["branch", "sandcastle/issue-11"], { cwd: consumerRoot });
      await run("git", ["commit", "--quiet", "--allow-empty", "-m", "base moves on"], {
        cwd: consumerRoot,
      });

      const result = await run(shim, [], { cwd: consumerRoot, env: environment }).catch(
        (error) => error
      );

      assert.match(result.stdout, /Selected child issue #11/);
      assert.doesNotMatch(result.stdout, /Reusing committed implementation/);
      assert.equal((await readCapturedPhases(capturePath))[0], "implementer");
    });
  });

  describe("reused issue branch behind the base", () => {
    // An earlier run committed an implementation on the issue branch; the base
    // optionally moves on afterwards.
    async function prepareReusedBranch(manager, fixture, issueId, { baseMoves }) {
      const prepared = await prepareWorkflowConsumer(manager, fixture);
      const { consumerRoot } = prepared;
      await run("git", ["switch", "--quiet", "-c", `sandcastle/issue-${issueId}`], {
        cwd: consumerRoot,
      });
      await run("git", ["commit", "--quiet", "--allow-empty", "-m", "earlier implementation"], {
        cwd: consumerRoot,
      });
      await run("git", ["switch", "--quiet", "main"], { cwd: consumerRoot });
      if (baseMoves) {
        await run("git", ["commit", "--quiet", "--allow-empty", "-m", "base moves on"], {
          cwd: consumerRoot,
        });
      }
      const { stdout } = await run("git", ["rev-parse", "main"], { cwd: consumerRoot });
      return { ...prepared, baseCommit: stdout.trim() };
    }

    const specFixture = {
      readyIssueLists: [
        [
          { id: "10", title: "Spec 10", createdAt: "2026-01-01T00:00:10Z", parentId: null },
          { id: "11", title: "Child 11", createdAt: "2026-01-01T00:00:11Z", parentId: "10" },
        ],
      ],
      subIssues: {
        10: [{ number: 11, title: "Child 11", state: "open", labels: [{ name: "ready-for-agent" }] }],
      },
      parents: { 11: "10" },
      blockers: { 10: ["11"] },
      blocking: { 11: ["10"] },
    };

    for (const { workPath, fixture, issueId } of [
      { workPath: "standalone", fixture: { readyIssueLists: [[standaloneIssue("42")]] }, issueId: "42" },
      { workPath: "spec", fixture: specFixture, issueId: "11" },
    ]) {
      it(`reports that Integration will rebase a reused ${workPath} branch that is behind the base`, async () => {
        const { consumerRoot, shim, environment, baseCommit } = await prepareReusedBranch(
          `pnpm-reused-behind-${workPath}`,
          fixture,
          issueId,
          { baseMoves: true }
        );

        const result = await run(shim, [], { cwd: consumerRoot, env: environment }).catch(
          (error) => error
        );

        assert.ok(
          result.stdout.includes(
            `Info: sandcastle/issue-${issueId} is behind main at ${baseCommit}; Integration will rebase it onto main.`
          ),
          result.stdout
        );
      });
    }

    it("does not report a rebase for a reused branch that is up to date with the base", async () => {
      const { consumerRoot, shim, environment } = await prepareReusedBranch(
        "pnpm-reused-current",
        { readyIssueLists: [[standaloneIssue("42")]] },
        "42",
        { baseMoves: false }
      );

      const result = await run(shim, [], { cwd: consumerRoot, env: environment });

      assert.match(result.stdout, /Reusing committed implementation/);
      assert.doesNotMatch(result.stdout, /is behind main/);
    });
  });

  describe("Dockerfile guard", () => {
    for (const { role, stopsBefore } of [
      { role: "implementer", stopsBefore: "reviewer" },
      { role: "reviewer", stopsBefore: "reporter" },
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
  });

  describe("Integration", () => {
    // An earlier run left a committed implementation on the issue branch that
    // changes shared.txt; the base then changed shared.txt differently.
    async function prepareConflict(manager) {
      const prepared = await prepareWorkflowConsumer(manager, {
        readyIssueLists: [[standaloneIssue("42")]],
      });
      const { consumerRoot } = prepared;
      const git = (...args) => run("git", args, { cwd: consumerRoot });
      await writeFile(path.join(consumerRoot, "shared.txt"), "original\n");
      await git("add", "shared.txt");
      await git("commit", "--quiet", "-m", "add shared file");
      await git("switch", "--quiet", "-c", "sandcastle/issue-42");
      await writeFile(path.join(consumerRoot, "shared.txt"), "from the branch\n");
      await git("commit", "--quiet", "-am", "sandcastle(implementer): #42: change shared file");
      await git("switch", "--quiet", "main");
      await writeFile(path.join(consumerRoot, "shared.txt"), "from the base\n");
      await git("commit", "--quiet", "-am", "change shared file on the base");
      const branchCommit = (await git("rev-parse", "sandcastle/issue-42")).stdout.trim();
      const baseCommit = (await git("rev-parse", "main")).stdout.trim();
      return { ...prepared, git, branchCommit, baseCommit };
    }

    const reporterGuidance = "Name the owning team in every option.\n";

    for (const manager of ["npm-conflict", "pnpm-conflict"]) {
      it(`reports a rebase conflict and keeps the branch in a ${manager.split("-")[0]} consumer`, async () => {
        const { consumerRoot, shim, environment, capturePath, fixturePath, git, branchCommit, baseCommit } =
          await prepareConflict(manager);
        await writeFile(
          path.join(consumerRoot, ".sandcastle", "standalone-report-prompt.md"),
          reporterGuidance
        );

        const error = await runExpectingFailure(shim, [], { cwd: consumerRoot, env: environment });

        assert.equal(error.code, 3, error.stdout);
        assert.deepEqual(await readCapturedPhases(capturePath), ["reviewer", "reporter"]);
        const reporter = (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .find((entry) => entry.name?.startsWith("reporter"));
        assert.equal(reporter.promptArgs.FAILURE_KIND, "rebase conflict");
        assert.equal(reporter.promptArgs.REVIEWED_COMMIT, branchCommit);
        assert.equal(reporter.promptArgs.BASE_COMMIT, baseCommit);
        assert.match(reporter.promptArgs.FAILURE_DETAIL, /conflicts in: shared\.txt/);
        assert.match(reporter.promptFile, /dist\/defaults\/prompts\/standalone-report-prompt\.md$/);
        assert.equal(reporter.promptArgs.PROJECT_GUIDANCE, reporterGuidance);

        // The report reaches the log directory, the issue, and the terminal.
        const reportLog = (await readLogs(consumerRoot)).find(({ name }) =>
          name.includes("integration-report")
        );
        assert.ok(reportLog, "no Integration Report log");
        assert.match(reportLog.contents, /Integration failed: rebase conflict/);
        assert.match(reportLog.contents, /conflicts in: shared\.txt/);
        assert.match(reportLog.contents, /Option 1: resolve the conflict by hand/);
        assert.ok(reportLog.contents.includes(`git rebase ${baseCommit}`));
        assert.deepEqual(await readComments(fixturePath), [
          { issue: "42", body: reportLog.contents },
        ]);
        assert.ok(error.stdout.includes("Option 1: resolve the conflict by hand"));
        assert.match(error.stdout, /SANDCASTLE RUN: STOPPED/);

        // The rebase was aborted: the branch is unchanged and no worktree is left.
        assert.equal((await git("rev-parse", "sandcastle/issue-42")).stdout.trim(), branchCommit);
        assert.equal((await git("rev-parse", "main")).stdout.trim(), baseCommit);
        assert.deepEqual(await readdir(path.join(consumerRoot, ".sandcastle", "worktrees")), []);
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }

    // An earlier run left a reviewed implementation in branch.txt; the base
    // then gained base.txt, so the rebase creates a new commit.
    async function prepareBranchBehindBase(manager) {
      const prepared = await prepareWorkflowConsumer(manager, {
        readyIssueLists: [[standaloneIssue("42")]],
      });
      const { consumerRoot } = prepared;
      const git = (...args) => run("git", args, { cwd: consumerRoot });
      await git("switch", "--quiet", "-c", "sandcastle/issue-42");
      await writeFile(path.join(consumerRoot, "branch.txt"), "branch\n");
      await git("add", "branch.txt");
      await git("commit", "--quiet", "-m", "sandcastle(reviewer): #42: reviewed implementation");
      await git("switch", "--quiet", "main");
      await writeFile(path.join(consumerRoot, "base.txt"), "base\n");
      await git("add", "base.txt");
      await git("commit", "--quiet", "-m", "base moves on");
      const branchCommit = (await git("rev-parse", "sandcastle/issue-42")).stdout.trim();
      const baseCommit = (await git("rev-parse", "main")).stdout.trim();
      return { ...prepared, git, branchCommit, baseCommit };
    }

    async function readExecs(capturePath) {
      return (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "exec")
        .map((entry) => entry.command);
    }

    for (const manager of ["npm-verify-fail", "pnpm-verify-fail"]) {
      it(`reports failed verification and keeps the reviewed branch in a ${manager.split("-")[0]} consumer`, async () => {
        const { consumerRoot, shim, environment, capturePath, fixturePath, git, branchCommit, baseCommit } =
          await prepareBranchBehindBase(manager);

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: { ...environment, FAKE_VERIFY_FAIL: "typecheck" },
        });

        assert.equal(error.code, 3, error.stdout);
        assert.deepEqual(await readCapturedPhases(capturePath), ["reporter"]);
        const execs = await readExecs(capturePath);
        assert.equal(execs.some((command) => /^(npm|pnpm) test\b/.test(command)), false);
        const reportLog = (await readLogs(consumerRoot)).find(({ name }) =>
          name.includes("integration-report")
        );
        assert.match(reportLog.contents, /Integration failed: failed verification/);
        assert.match(reportLog.contents, /typecheck step/);
        assert.match(reportLog.contents, /src\/broken\.js:3/);
        assert.equal((await readComments(fixturePath)).length, 1);
        assert.ok(error.stdout.includes("Option 1: resolve the conflict by hand"));
        // The branch never moved to the rebased commit.
        assert.equal((await git("rev-parse", "sandcastle/issue-42")).stdout.trim(), branchCommit);
        assert.equal((await git("rev-parse", "main")).stdout.trim(), baseCommit);
        assert.deepEqual(await readdir(path.join(consumerRoot, ".sandcastle", "worktrees")), []);
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }

    it("restores the branch when verification leaves a tracked file changed", async () => {
      const { consumerRoot, shim, environment, git, branchCommit } =
        await prepareBranchBehindBase("pnpm-verify-dirty");

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_TEST_WRITES: "base.txt" },
      });

      assert.equal(error.code, 3, error.stdout);
      assert.match(error.stdout, /left uncommitted changes in the issue worktree/);
      assert.equal((await git("rev-parse", "sandcastle/issue-42")).stdout.trim(), branchCommit);
      assert.deepEqual(await readdir(path.join(consumerRoot, ".sandcastle", "worktrees")), []);
    });

    for (const { action, env, diagnostic } of [
      {
        action: "commits",
        env: { FAKE_REPORTER_ACTION: "commit" },
        diagnostic: /the Reporter for standalone issue #42 changed the issue worktree/,
      },
      {
        action: "changes the worktree",
        env: { FAKE_REPORTER_ACTION: "dirty" },
        diagnostic: /the Reporter for standalone issue #42 changed the issue worktree/,
      },
      {
        action: "moves a ref",
        env: { FAKE_AGENT_UPDATE_REF: "reporter:refs/heads/elsewhere" },
        diagnostic: /guarded refs changed during the reporter phase[\s\S]*git update-ref -d refs\/heads\/elsewhere/,
      },
    ]) {
      it(`aborts with status 1 when the Reporter ${action}`, async () => {
        const { consumerRoot, shim, environment, fixturePath, git, baseCommit } =
          await prepareBranchBehindBase(`pnpm-reporter-${action.replaceAll(" ", "-")}`);

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: { ...environment, FAKE_VERIFY_FAIL: "test", ...env },
        });

        assert.equal(error.code, 1, error.stdout);
        assert.match(error.stderr, diagnostic);
        assert.equal((await git("rev-parse", "main")).stdout.trim(), baseCommit);
        assert.deepEqual(await readComments(fixturePath), []);
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }

    it("rebases and verifies again when the base moves before the fast-forward", async () => {
      const { consumerRoot, shim, environment, capturePath, fixturePath, git } =
        await prepareWorkflowConsumer("pnpm-base-moves-once", {
          readyIssueLists: [[standaloneIssue("42")]],
        });

      const result = await run(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_MOVE_BASE_ON_TEST: "1" },
      });

      assert.match(result.stdout, /Integration complete for standalone issue #42/);
      assert.match(result.stderr, /main moved during Integration.*attempt 2 of 3/);
      const tests = (await readExecs(capturePath)).filter((command) => command === "pnpm test");
      assert.equal(tests.length, 2);
      const { stdout: log } = await run("git", ["log", "--format=%s", "main"], { cwd: consumerRoot });
      assert.match(log, /fake implementation\nbase moves on\n/);
      assert.deepEqual(await readClosedIssues(fixturePath), ["42"]);
    });

    it("keeps the reviewed commit when a retry after a moved base conflicts", async () => {
      const { consumerRoot, shim, environment, capturePath, git, branchCommit } =
        await prepareBranchBehindBase("pnpm-retry-conflict");

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: {
          ...environment,
          FAKE_MOVE_BASE_ON_TEST: "1",
          FAKE_BASE_MOVE_FILE: "branch.txt:from the base",
        },
      });

      assert.equal(error.code, 3, error.stdout);
      assert.deepEqual(await readCapturedPhases(capturePath), ["reporter"]);
      assert.equal((await git("rev-parse", "sandcastle/issue-42")).stdout.trim(), branchCommit);
      const reportLog = (await readLogs(consumerRoot)).find(({ name }) =>
        name.includes("integration-report")
      );
      assert.ok(reportLog.contents.includes(`unchanged at \`${branchCommit}\``));
    });

    it("leaves the reviewed commit on the branch after the attempts run out", async () => {
      const { consumerRoot, shim, environment, git, branchCommit } =
        await prepareBranchBehindBase("pnpm-retry-exhausted-branch");

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_MOVE_BASE_ON_TEST: "100" },
      });

      assert.equal(error.code, 3, error.stdout);
      assert.equal((await git("rev-parse", "sandcastle/issue-42")).stdout.trim(), branchCommit);
    });

    for (const manager of ["npm-base-keeps-moving", "pnpm-base-keeps-moving"]) {
      it(`stops with status 3 after three verified rebases when the base keeps moving in a ${manager.split("-")[0]} consumer`, async () => {
        const { consumerRoot, shim, environment, capturePath, fixturePath } =
          await prepareWorkflowConsumer(manager, {
            readyIssueLists: [[standaloneIssue("42")]],
          });

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: { ...environment, FAKE_MOVE_BASE_ON_TEST: "100" },
        });

        assert.equal(error.code, 3, error.stdout);
        assert.match(error.stderr, /gave up after 3 attempts/);
        const tests = (await readExecs(capturePath)).filter((command) =>
          /^(npm|pnpm) test$/.test(command)
        );
        assert.equal(tests.length, 3);
        assert.deepEqual(await readCapturedPhases(capturePath), ["implementer", "reviewer"]);
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }
  });

  describe("ref guard", () => {
    for (const manager of ["npm-ref-guard", "pnpm-ref-guard"]) {
      it(`aborts with restore commands when the implementer creates a branch in a ${manager.split("-")[0]} consumer`, async () => {
        const { consumerRoot, shim, environment, capturePath, fixturePath } =
          await prepareWorkflowConsumer(manager, {
            readyIssueLists: [[standaloneIssue("42")]],
          });

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: { ...environment, FAKE_AGENT_UPDATE_REF: "implementer:refs/heads/other" },
        });

        assert.equal(error.code, 1, error.stdout);
        assert.match(error.stderr, /guarded refs changed during the implementer phase/);
        assert.match(error.stderr, /refs\/heads\/other: \(absent\) → [0-9a-f]{40}/);
        assert.match(error.stderr, /git update-ref -d refs\/heads\/other/);
        // Nothing is restored automatically.
        await run("git", ["rev-parse", "--verify", "refs/heads/other"], { cwd: consumerRoot });
        assert.deepEqual(await readCapturedPhases(capturePath), ["implementer"]);
        assert.deepEqual(await readClosedIssues(fixturePath), []);
      });
    }

    it("prints the old commit for a moved tag", async () => {
      const { consumerRoot, shim, environment } = await prepareWorkflowConsumer(
        "pnpm-ref-guard-tag",
        { readyIssueLists: [[standaloneIssue("42")]] }
      );
      await run("git", ["tag", "v1"], { cwd: consumerRoot });
      const { stdout: tagCommit } = await run("git", ["rev-parse", "v1"], { cwd: consumerRoot });

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_AGENT_UPDATE_REF: "reviewer:refs/tags/v1" },
      });

      assert.equal(error.code, 1, error.stdout);
      assert.match(error.stderr, /during the reviewer phase/);
      assert.ok(error.stderr.includes(`git update-ref refs/tags/v1 ${tagCommit.trim()}`));
    });

    it("ignores remote-tracking refs", async () => {
      const { consumerRoot, shim, environment, fixturePath } = await prepareWorkflowConsumer(
        "pnpm-ref-guard-remote",
        { readyIssueLists: [[standaloneIssue("42")]] }
      );

      const result = await run(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_AGENT_UPDATE_REF: "implementer:refs/remotes/origin/feature" },
      });

      assert.match(result.stdout, /Integration complete for standalone issue #42/);
      assert.deepEqual(await readClosedIssues(fixturePath), ["42"]);
    });
  });

  describe("final spec review", () => {
    // Spec 100 has one closed child, so the run goes straight to final review.
    const finalReviewFixture = {
      readyIssueLists: [
        [{ id: "100", title: "Spec", createdAt: "2026-01-01T00:00:00Z", parentId: null }],
      ],
      subIssues: { 100: [{ number: 101, title: "Child", state: "closed", labels: [] }] },
      parents: { 101: "100" },
      blocking: { 101: ["100"] },
      closed: ["101"],
    };

    async function readSandboxBranches(capturePath) {
      return (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "sandbox")
        .map((entry) => entry.branch);
    }

    for (const manager of ["npm-final-review-branch", "pnpm-final-review-branch"]) {
      it(`reviews on a temporary branch that is deleted afterwards in a ${manager.split("-")[0]} consumer`, async () => {
        const { consumerRoot, shim, environment, capturePath, fixturePath } =
          await prepareWorkflowConsumer(manager, finalReviewFixture);

        const result = await run(shim, [], { cwd: consumerRoot, env: environment });

        assert.match(result.stdout, /Spec #100 passed final review and closed/);
        assert.deepEqual(await readSandboxBranches(capturePath), ["sandcastle/final-spec-100"]);
        const captures = (await readFile(capturePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(captures.some((entry) => entry.type === "head-run"), false);
        const sandbox = captures.find((entry) => entry.type === "sandbox");
        assert.equal(
          sandbox.hooks.sandbox.onSandboxReady.at(-1).command,
          manager.startsWith("npm") ? "npm ci" : "pnpm install --frozen-lockfile"
        );
        const { stdout: branches } = await run("git", ["branch", "--list", "sandcastle/*"], {
          cwd: consumerRoot,
        });
        assert.equal(branches.trim(), "");
        assert.deepEqual(await readdir(path.join(consumerRoot, ".sandcastle", "worktrees")), []);
        assert.deepEqual(await readClosedIssues(fixturePath), ["100"]);
      });
    }

    it("aborts with status 1 when the final spec reviewer commits, and the commit never reaches the base", async () => {
      const { consumerRoot, shim, environment, fixturePath } = await prepareWorkflowConsumer(
        "pnpm-final-review-commit",
        finalReviewFixture
      );
      const { stdout: baseBefore } = await run("git", ["rev-parse", "main"], { cwd: consumerRoot });

      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_AGENT_FILE_CHANGE: "final-spec-reviewer:src/late.js" },
      });

      assert.equal(error.code, 1, error.stdout);
      assert.match(error.stderr, /final spec reviewer for spec #100 committed on sandcastle\/final-spec-100/);
      const { stdout: baseAfter } = await run("git", ["rev-parse", "main"], { cwd: consumerRoot });
      assert.equal(baseAfter, baseBefore);
      const { stdout: baseFiles } = await run("git", ["ls-tree", "-r", "--name-only", "main"], {
        cwd: consumerRoot,
      });
      assert.equal(baseFiles.split("\n").includes("src/late.js"), false);
      assert.deepEqual(await readdir(path.join(consumerRoot, ".sandcastle", "worktrees")), []);
      // The run fails even though the reviewer closed the spec.
      assert.deepEqual(await readClosedIssues(fixturePath), ["100"]);
    });

    for (const outcome of ["open", "not-ready", "stopped"]) {
      it(`stops with status 3 when the final spec reviewer reports ${outcome}`, async () => {
        const { consumerRoot, shim, environment, fixturePath } = await prepareWorkflowConsumer(
          `pnpm-final-review-${outcome}`,
          finalReviewFixture
        );

        const error = await runExpectingFailure(shim, [], {
          cwd: consumerRoot,
          env: { ...environment, FAKE_FINAL_REVIEW_OUTCOME: outcome },
        });

        assert.equal(error.code, 3, error.stdout);
        assert.ok(error.stderr.includes(`Final spec reviewer for spec #100 outcome: ${outcome}. Reason: fake ${outcome}`));
        assert.deepEqual(await readClosedIssues(fixturePath), []);
        const { stdout: branches } = await run("git", ["branch", "--list", "sandcastle/*"], {
          cwd: consumerRoot,
        });
        assert.equal(branches.trim(), "");
      });
    }

    it("fails when GitHub disagrees with the reported closure", async () => {
      const { consumerRoot, shim, environment } = await prepareWorkflowConsumer(
        "pnpm-final-review-mismatch",
        finalReviewFixture
      );
      // The reviewer reports closure but never closes the spec.
      const error = await runExpectingFailure(shim, [], {
        cwd: consumerRoot,
        env: { ...environment, FAKE_FINAL_REVIEW_OUTCOME: "closed", FAKE_FINAL_REVIEW_SKIP_CLOSE: "1" },
      });

      assert.equal(error.code, 1, error.stdout);
      assert.match(error.stderr, /Final reviewer reported closure, but spec issue #100 remains open/);
    });
  });
});
