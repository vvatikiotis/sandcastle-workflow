import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
const packageVersion = "0.1.0";
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
        packageManager: manager === "npm" ? "npm@10.9.2" : "pnpm@11.10.0",
        devDependencies: {
          [packageName]: `file:vendor/${path.basename(tarballPath)}`,
        },
      },
      null,
      2
    )}\n`
  );

  if (manager === "npm") {
    await run("npx", ["--yes", "npm@10.9.2", "install", "--ignore-scripts"], {
      cwd: consumerRoot,
    });
  } else {
    await run("pnpm", ["install", "--ignore-scripts"], { cwd: consumerRoot });
  }

  return consumerRoot;
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

    for (const required of [
      "package/package.json",
      "package/README.md",
      "package/dist/cli.js",
      "package/dist/defaults/docker/Dockerfile",
      "package/dist/defaults/prompts/implement-prompt.md",
      "package/skills/github-ticket-relationships/SKILL.md",
    ]) {
      assert.ok(entries.includes(required), `missing packed entry ${required}`);
    }

    assert.equal(entries.some((entry) => entry.startsWith("package/src/")), false);
    assert.equal(entries.some((entry) => entry.startsWith("package/test/")), false);

    const { stdout: manifestText } = await run("tar", [
      "-xOf",
      tarballPath,
      "package/package.json",
    ]);
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.bin, { "sandcastle-workflow": "dist/cli.js" });
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
    await access(path.join(sandcastleRoot, ".gitignore"));
    await access(path.join(sandcastleRoot, ".env.example"));
    await assert.rejects(access(path.join(sandcastleRoot, "sandcastle.env")));
    await assert.rejects(access(path.join(sandcastleRoot, ".env")));

    await writeFile(examplePath, "project-owned\n");
    const second = await run(shim, ["init"], { cwd: consumerRoot });
    assert.match(second.stdout, new RegExp(`Preserved ${examplePath}`));
    assert.equal(await readFile(examplePath, "utf8"), "project-owned\n");
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

    assert.match(result.stdout, /Docker image: sandcastle:pnpm-docker-v0\.1\.0/);
    assert.match(result.stdout, /Dockerfile: .*dist\/defaults\/docker\/Dockerfile \(built-in\)/);
    const dockerArguments = (await readFile(capturePath, "utf8")).trim().split("\n");
    const fileIndex = dockerArguments.indexOf("--file");
    const tagIndex = dockerArguments.indexOf("--tag");
    assert.equal(dockerArguments[tagIndex + 1], "sandcastle:pnpm-docker-v0.1.0");
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
