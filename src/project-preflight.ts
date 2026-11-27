import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { getErrorCode } from "./error-code.ts";
import { promptFilenames } from "./prompt-resolution.ts";
import type { Exec } from "./run-context.ts";

const rawExecFile = promisify(execFileCallback);

export async function discoverProjectRoot(): Promise<string> {
  try {
    const { stdout } = await rawExecFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const root = stdout.trim();
    if (root !== "") {
      return path.resolve(root);
    }
  } catch (error) {
    throw new Error(
      `Sandcastle must be run inside a Git worktree. Git could not discover the repository root from ${process.cwd()}.`,
      { cause: error },
    );
  }

  throw new Error(
    `Sandcastle must be run inside a Git worktree. Git returned an empty repository root for ${process.cwd()}.`,
  );
}

export async function requireProjectSandcastleDirectory(
  projectRoot: string,
): Promise<void> {
  const sandcastleRoot = path.join(projectRoot, ".sandcastle");
  let metadata;

  try {
    metadata = await lstat(sandcastleRoot);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    throw new Error(
      `Could not inspect Sandcastle directory ${sandcastleRoot}.`,
      {
        cause: error,
      },
    );
  }

  if (metadata.isSymbolicLink()) {
    throw new Error(
      `Refusing to run through symbolic Sandcastle directory ${sandcastleRoot}.`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Sandcastle path ${sandcastleRoot} is not a directory.`);
  }
}

export async function validateGitHubRepository(
  execFile: Exec,
  packageVersion: string,
): Promise<void> {
  const { stdout: remoteUrlOutput } = await execFile("git", [
    "remote",
    "get-url",
    "origin",
  ]);
  const remoteUrl = remoteUrlOutput.trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)[^/]+\/[^/]+(?:\.git)?$/.test(
      remoteUrl,
    )
  ) {
    throw new Error(
      `Sandcastle version ${packageVersion} supports only GitHub.com origin remotes. Found: ${remoteUrl || "none"}.`,
    );
  }

  const { stdout: labelsOutput } = await execFile("gh", [
    "label",
    "list",
    "--limit",
    "100",
    "--json",
    "name",
  ]);
  const labels = z
    .array(z.object({ name: z.string() }))
    .parse(JSON.parse(labelsOutput));
  const availableLabels = new Set(labels.map((label) => label.name));
  const requiredLabels = [
    "needs-triage",
    "needs-info",
    "ready-for-agent",
    "ready-for-human",
    "wontfix",
  ];
  const missingLabels = requiredLabels.filter(
    (label) => !availableLabels.has(label),
  );
  if (missingLabels.length > 0) {
    throw new Error(
      `The GitHub repository is missing required triage labels: ${missingLabels.join(", ")}.`,
    );
  }
}

async function isEffectivelyIgnored(
  execFile: Exec,
  projectRelativePath: string,
): Promise<boolean> {
  try {
    await execFile("git", [
      "check-ignore",
      "--quiet",
      "--no-index",
      "--",
      projectRelativePath,
    ]);
    return true;
  } catch (error) {
    if (getErrorCode(error) === 1) {
      return false;
    }
    throw new Error(
      `Could not check effective Git ignore behavior for ${projectRelativePath}.`,
      { cause: error },
    );
  }
}

export async function validateEffectiveIgnoreBehavior(
  execFile: Exec,
): Promise<void> {
  const protectedPaths = [
    ".sandcastle/.env",
    ".sandcastle/sandcastle.env",
    ".sandcastle/logs/",
    ".sandcastle/worktrees/",
    ".sandcastle/node-modules-overlays/",
    ".sandcastle/run.lock",
  ];
  const { stdout: trackedProtectedPathsOutput } = await execFile("git", [
    "ls-files",
    "-z",
    "--",
    ...protectedPaths,
  ]);
  const trackedProtectedPaths = trackedProtectedPathsOutput
    .split("\0")
    .filter(Boolean);
  if (trackedProtectedPaths.length > 0) {
    throw new Error(
      `Git ignore rules cannot protect tracked Sandcastle paths: ${trackedProtectedPaths.join(", ")}. Remove them from the Git index without deleting the local files before launching agents.`,
    );
  }

  for (const protectedPath of protectedPaths) {
    if (!(await isEffectivelyIgnored(execFile, protectedPath))) {
      throw new Error(
        `Git ignore protection is required for ${protectedPath}. Add an effective ignore rule before launching agents.`,
      );
    }
  }

  const trackablePaths = [
    ...promptFilenames.map((filename) => `.sandcastle/${filename}`),
    ".sandcastle/sandcastle.env.example",
    ".sandcastle/.env.example",
    ".sandcastle/.gitignore",
  ];

  for (const trackablePath of trackablePaths) {
    if (await isEffectivelyIgnored(execFile, trackablePath)) {
      throw new Error(
        `Workflow file ${trackablePath} must remain trackable. Remove the effective ignore rule that hides it.`,
      );
    }
  }
}
