import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveReleaseVersion,
  updateConsumerVersion,
} from "./release-support.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
}

function printUsage() {
  console.log(`Usage: pnpm release <patch|minor|major|x.y.z>

Qualifies the release, creates the artifact and checksum, commits the release,
and creates a local version tag. It never pushes or publishes.`);
}

const [requestedVersion, ...extraArguments] = process.argv.slice(2);
if (requestedVersion === "--help" || requestedVersion === "-h") {
  printUsage();
  process.exit(0);
}
if (!requestedVersion || extraArguments.length > 0) {
  printUsage();
  process.exitCode = 1;
} else {
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status.trim()) {
    throw new Error("Release requires a clean Git working tree.");
  }

  const packagePath = path.join(projectRoot, "package.json");
  const consumerPath = path.join(projectRoot, "CONSUMER.md");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const currentVersion = packageJson.version;
  const nextVersion = resolveReleaseVersion(currentVersion, requestedVersion);
  const tag = `v${nextVersion}`;

  const existingTag = run("git", ["tag", "--list", tag], { capture: true });
  if (existingTag.trim()) {
    throw new Error(`Git tag ${tag} already exists.`);
  }

  packageJson.version = nextVersion;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(
    consumerPath,
    updateConsumerVersion(
      readFileSync(consumerPath, "utf8"),
      currentVersion,
      nextVersion,
    ),
  );

  run("pnpm", ["typecheck"]);
  run("pnpm", ["test"]);
  run("pnpm", ["run", "test:docker"]);
  run("pnpm", ["pack", "--dry-run"]);
  run("pnpm", ["run", "pack:artifact"]);

  const artifactRelativePath = `artifacts/vvatikiotis-sandcastle-workflow-${nextVersion}.tgz`;
  const artifactPath = path.join(projectRoot, artifactRelativePath);
  const checksumRelativePath = `${artifactRelativePath}.sha256`;
  const checksum = createHash("sha256")
    .update(readFileSync(artifactPath))
    .digest("hex");
  writeFileSync(
    path.join(projectRoot, checksumRelativePath),
    `${checksum}  ${artifactRelativePath}\n`,
  );

  run("git", [
    "add",
    "--",
    "package.json",
    "CONSUMER.md",
    artifactRelativePath,
    checksumRelativePath,
  ]);
  run("git", ["diff", "--cached", "--check"]);
  run("git", ["diff", "--cached", "--name-status"]);
  run("git", ["commit", "-m", `release: package ${tag}`]);
  run("git", ["tag", tag]);

  console.log(`Released ${tag} locally.`);
  console.log(`Artifact: ${artifactRelativePath}`);
  console.log(`SHA-256: ${checksum}`);
}
