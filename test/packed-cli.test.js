import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@vvatikiotis/sandcastle-workflow";
const packageVersion = "0.1.0";

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
