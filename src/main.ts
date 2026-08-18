// Sequential selector → implementer → reviewer → merger workflow
//
// This template drives a sequential workflow per issue:
//   Selector:    reads GitHub native sub-issues and selects the earliest ready
//                spec path or the standalone/orphan path chosen for the run.
//   Implementer: works on the issue branch, commits the changes, and signals
//                completion.
//   Reviewer:    reviews the branch diff and either approves it or makes
//                corrections directly on the branch.
//   Merger:      merges the reviewed branch back to the current branch and
//                closes the issue after a successful merge.
//
// The implementer and reviewer share a single sandbox created via
// createSandbox(), so they work on the same explicit branch.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration and stopping early once the backlog is exhausted. This keeps the
// workflow fully sequential.
//
// Public entry point: sandcastle-workflow

import * as sandcastle from "@ai-hero/sandcastle";
import chalk from "chalk";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

import {
  createRunCompletionReporter,
  formatDiagnostic,
  type RunEndStatus,
} from "./run-completion.ts";
import {
  classifyPlanningError,
  getNoStandaloneIssuesStatus,
  InvalidIssueGraphError,
} from "./workflow-completion.ts";
import {
  getBlockedReadyChildren,
  getEligibleChildren,
  getIssueStatus,
  selectRunSpec,
  selectSpecCandidates,
  selectStandaloneCandidates,
  validateSpecGraph,
  type ReadyIssue,
  type SpecCandidate,
  type SpecChild,
} from "./spec-selection.ts";
import {
  shouldJumpToMergerAfterReuseForSpec,
  shouldJumpToMergerAfterReuseForStandalone,
} from "./recovery-routing.ts";
import { formatAgentStartMessage } from "./agent-run-status.ts";
import {
  formatPhaseFailure,
  reportPhaseFailure,
  runAgentPhase,
  type AgentPhaseResult,
} from "./phase-diagnostics.ts";
import {
  cleanupStaleNodeModulesOverlays,
  createNodeModulesOverlay,
  removeNodeModulesOverlay,
  withNodeModulesOverlay,
  type NodeModulesOverlay,
} from "./node-modules-overlay.ts";
import {
  requireProjectCodingStandards,
  resolvePromptFiles,
} from "./prompt-resolution.ts";
import { isWithinDirectory } from "./file-resolution.ts";
import { initializeProject, reportInitialization } from "./initialization.ts";
import { cleanupVerificationWorktree } from "./verification-worktree-cleanup.ts";
import { getVerificationWorktreePaths } from "./verification-worktree-paths.ts";
import { resolveDockerfile, resolveDockerImageName } from "./docker-image.ts";
import { resolvePackageManager } from "./package-manager.ts";
import { acquireRunLock, type RunLock } from "./run-lock.ts";

type CliMode = "run" | "init" | "build-image" | "dry-run" | "help" | "version";

const usage = `Usage: sandcastle-workflow [command]

Commands:
  init         Create project-local examples and ignore rules
  build-image  Build the configured Docker image

Options:
  --dry-run    Inspect eligible work without launching agents
  --help, -h   Show this help
  --version, -v
               Show the package version`;

function parseCliMode(args: readonly string[]): CliMode | undefined {
  if (args.length === 0) {
    return "run";
  }
  if (args.length !== 1) {
    return undefined;
  }

  switch (args[0]) {
    case "init":
    case "build-image":
      return args[0];
    case "--dry-run":
      return "dry-run";
    case "--help":
    case "-h":
      return "help";
    case "--version":
    case "-v":
      return "version";
    default:
      return undefined;
  }
}

async function readPackageVersion(): Promise<string> {
  const manifestText = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const manifest: unknown = JSON.parse(manifestText);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    manifest.version === ""
  ) {
    throw new Error("The installed package metadata has no valid version.");
  }
  return manifest.version;
}

const command = parseCliMode(process.argv.slice(2));
if (command === undefined) {
  process.stderr.write(`Unknown command or invalid arguments.\n\n${usage}\n`);
  process.exit(2);
}

if (command === "help") {
  console.log(usage);
  process.exit(0);
}

const packageVersion = await readPackageVersion();
if (command === "version") {
  console.log(packageVersion);
  process.exit(0);
}

console.log(`Sandcastle Workflow v${packageVersion}\n`);

//
// region Run completion reporting
//

let runEndStatus: RunEndStatus | undefined;
const runCompletion = createRunCompletionReporter(() => runEndStatus);
runCompletion.installProcessHandlers();

const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);
const rawExecFile = promisify(execFileCallback);

function formatConsoleMessage(values: readonly unknown[]): string {
  return values.map(formatDiagnostic).join(" ");
}

console.warn = (...values) =>
  originalConsoleWarn(chalk.yellow(formatConsoleMessage(values)));
console.error = (...values) =>
  originalConsoleError(chalk.red(formatConsoleMessage(values)));

//
// endregion Run completion reporting
//

//
// region CLI and project bootstrap
//

async function discoverProjectRoot(): Promise<string> {
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

const projectRoot = await discoverProjectRoot();
const workflowRoot = path.dirname(fileURLToPath(import.meta.url));
const isDryRun = command === "dry-run";

if (command === "init") {
  const result = await initializeProject(projectRoot);
  reportInitialization(
    result,
    projectRoot,
    projectPath(
      "node_modules",
      "@vvatikiotis",
      "sandcastle-workflow",
      "skills",
      "github-ticket-relationships",
    ),
  );
  runCompletion.setStatus({
    kind: "completed",
    reason: `Initialized project-local Sandcastle configuration at ${projectRoot}.`,
  });
  await runCompletion.printSummary();
  process.exit(0);
}

function projectPath(...segments: string[]): string {
  return path.join(projectRoot, ...segments);
}

async function requireProjectSandcastleDirectory(): Promise<void> {
  const sandcastleRoot = projectPath(".sandcastle");
  let metadata;

  try {
    metadata = await lstat(sandcastleRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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

await requireProjectSandcastleDirectory();

function execFile(file: string, args: readonly string[]) {
  return rawExecFile(file, [...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

const packageManager = await resolvePackageManager(projectRoot);
const verificationPromptArgs = {
  INSTALL_COMMAND: packageManager.commands.install.join(" "),
  TYPECHECK_COMMAND: packageManager.commands.typecheck.join(" "),
  TEST_COMMAND: packageManager.commands.test.join(" "),
};

//
// endregion CLI and project bootstrap
//

//
// region Configuration
//

//
// region Runner configuration
//

const runnerConfigPath = projectPath(".sandcastle", "sandcastle.env");
const runnerConfigKeys = [
  "IMPLEMENTER_MODEL",
  "IMPLEMENTER_EFFORT",
  "REVIEWER_MODEL",
  "REVIEWER_EFFORT",
  "MERGER_MODEL",
  "MERGER_EFFORT",
  "FINAL_SPEC_REVIEWER_MODEL",
  "FINAL_SPEC_REVIEWER_EFFORT",
  "MAX_ITERATIONS",
] as const;
const optionalRunnerConfigKeys = ["DOCKER_IMAGE"] as const;

type RunnerConfigKey = (typeof runnerConfigKeys)[number];
type OptionalRunnerConfigKey = (typeof optionalRunnerConfigKeys)[number];
type RunnerConfig = Record<RunnerConfigKey, string> &
  Partial<Record<OptionalRunnerConfigKey, string>>;

function parseConfigValue(
  value: string,
  lineNumber: number,
  configPath: string,
): string {
  const firstCharacter = value[0];

  if (firstCharacter !== '"' && firstCharacter !== "'") {
    return value;
  }

  if (value.length < 2 || value.at(-1) !== firstCharacter) {
    throw new Error(`${configPath}:${lineNumber}: unterminated quoted value.`);
  }

  const unquoted = value.slice(1, -1);
  if (firstCharacter === '"') {
    return unquoted.replace(/\\([nrt\\])/g, (_match, character: string) => {
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        "\\": "\\",
      };
      return escapes[character] ?? character;
    });
  }

  return unquoted;
}

async function loadRunnerConfig(): Promise<RunnerConfig> {
  let contents: string;

  try {
    contents = await readFile(runnerConfigPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${runnerConfigPath} is required. Run "sandcastle-workflow init", then copy .sandcastle/sandcastle.env.example to .sandcastle/sandcastle.env and choose every runner value.`,
      );
    }
    throw error;
  }

  const allowedKeys = new Set<string>([
    ...runnerConfigKeys,
    ...optionalRunnerConfigKeys,
  ]);
  const values = new Map<RunnerConfigKey | OptionalRunnerConfigKey, string>();

  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const trimmedLine = line.trim();

    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(
        `${runnerConfigPath}:${lineNumber}: expected a KEY=value assignment.`,
      );
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (!allowedKeys.has(key)) {
      throw new Error(
        `${runnerConfigPath}:${lineNumber}: unknown configuration key ${key}.`,
      );
    }

    const runnerConfigKey = key as RunnerConfigKey | OptionalRunnerConfigKey;
    if (values.has(runnerConfigKey)) {
      throw new Error(
        `${runnerConfigPath}:${lineNumber}: duplicate configuration key ${key}.`,
      );
    }

    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    const value = parseConfigValue(rawValue, lineNumber, runnerConfigPath);
    if (value === "") {
      throw new Error(
        `${runnerConfigPath}:${lineNumber}: ${key} must not be empty.`,
      );
    }

    values.set(runnerConfigKey, value);
  }

  const missingKeys = runnerConfigKeys.filter((key) => !values.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `${runnerConfigPath} is missing required configuration: ${missingKeys.join(", ")}.`,
    );
  }

  return Object.fromEntries(values) as RunnerConfig;
}

const runnerConfig = await loadRunnerConfig();

//
// endregion Runner configuration
//

//
// region Docker configuration
//

const dockerImageName = resolveDockerImageName(
  runnerConfig.DOCKER_IMAGE,
  projectRoot,
  packageVersion,
);
const dockerfile = await resolveDockerfile({ projectRoot, workflowRoot });

//
// endregion Docker configuration
//

//
// endregion Configuration
//

//
// region Build-image command
//

if (command === "build-image") {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;

  console.log(`Docker image: ${dockerImageName}`);
  console.log(`Dockerfile: ${dockerfile.path} (${dockerfile.source})`);
  console.log(`Build context: ${dockerfile.context}`);
  console.log(`Build arguments: AGENT_UID=${uid}, AGENT_GID=${gid}`);
  await execFile("docker", [
    "build",
    "--build-arg",
    `AGENT_UID=${uid}`,
    "--build-arg",
    `AGENT_GID=${gid}`,
    "--file",
    dockerfile.path,
    "--tag",
    dockerImageName,
    dockerfile.context,
  ]);
  runCompletion.setStatus({
    kind: "completed",
    reason: `Built Docker image ${dockerImageName}.`,
  });
  await runCompletion.printSummary();
  process.exit(0);
}

//
// endregion Build-image command
//

//
// region Project preflight
//

//
// region GitHub preflight
//

async function validateGitHubRepository(): Promise<void> {
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
      `Sandcastle version 0.3.6 supports only GitHub.com origin remotes. Found: ${remoteUrl || "none"}.`,
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

await validateGitHubRepository();

//
// endregion GitHub preflight
//

//
// region Agent and prompt preflight
//

const maxIterations = Number(runnerConfig.MAX_ITERATIONS);
if (
  !/^\d+$/.test(runnerConfig.MAX_ITERATIONS) ||
  !Number.isSafeInteger(maxIterations) ||
  maxIterations < 1
) {
  throw new Error(
    `${runnerConfigPath}: MAX_ITERATIONS must be a positive integer.`,
  );
}

// Review these model and effort choices together when optimizing run costs.
const AGENT_CONFIG = {
  implementer: {
    model: runnerConfig.IMPLEMENTER_MODEL,
    effort: runnerConfig.IMPLEMENTER_EFFORT,
  },
  reviewer: {
    model: runnerConfig.REVIEWER_MODEL,
    effort: runnerConfig.REVIEWER_EFFORT,
  },
  merger: {
    model: runnerConfig.MERGER_MODEL,
    effort: runnerConfig.MERGER_EFFORT,
  },
  finalSpecReviewer: {
    model: runnerConfig.FINAL_SPEC_REVIEWER_MODEL,
    effort: runnerConfig.FINAL_SPEC_REVIEWER_EFFORT,
  },
} as const;

await requireProjectCodingStandards(projectRoot);
const promptFiles = await resolvePromptFiles({ projectRoot, workflowRoot });
for (const selection of promptFiles.selections) {
  console.log(`Prompt ${selection.filename}: built-in ${selection.path}`);
  if (selection.guidancePath !== undefined) {
    console.log(
      `Project guidance ${selection.filename}: ${selection.guidancePath}`,
    );
  }
}

const agentEnvironmentPath = projectPath(".sandcastle", ".env");

async function loadAgentEnvironment(): Promise<Record<string, string>> {
  let contents: string;

  try {
    contents = await readFile(agentEnvironmentPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${agentEnvironmentPath} is required before launching agents. Copy .sandcastle/.env.example to .sandcastle/.env and set GH_TOKEN, or leave GH_TOKEN empty to use the documented host-environment fallback.`,
      );
    }
    throw error;
  }

  const values = new Map<string, string>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const trimmedLine = line.trim();
    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (separatorIndex <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `${agentEnvironmentPath}:${lineNumber}: expected a KEY=value assignment.`,
      );
    }
    if (key !== "GH_TOKEN") {
      throw new Error(
        `${agentEnvironmentPath}:${lineNumber}: unsupported agent environment key ${key}. Only GH_TOKEN is supported; remove ${key} before running Sandcastle.`,
      );
    }
    if (values.has(key)) {
      throw new Error(
        `${agentEnvironmentPath}:${lineNumber}: duplicate environment key ${key}.`,
      );
    }

    values.set(
      key,
      parseConfigValue(
        trimmedLine.slice(separatorIndex + 1).trim(),
        lineNumber,
        agentEnvironmentPath,
      ),
    );
  }

  if (!values.has("GH_TOKEN")) {
    throw new Error(
      `${agentEnvironmentPath} must declare GH_TOKEN. Copy the declaration from .sandcastle/.env.example.`,
    );
  }

  const fileGhToken = values.get("GH_TOKEN") ?? "";
  const hostGhToken = process.env.GH_TOKEN ?? "";
  let ghToken: string | undefined;
  if (fileGhToken.trim() !== "") {
    ghToken = fileGhToken;
  } else if (hostGhToken.trim() !== "") {
    ghToken = hostGhToken;
  }
  if (ghToken === undefined) {
    throw new Error(
      `${agentEnvironmentPath} declares GH_TOKEN, but no usable credential was provided in the file or host environment.`,
    );
  }
  values.set("GH_TOKEN", ghToken);

  return { GH_TOKEN: ghToken };
}

const agentEnvironment = isDryRun ? {} : await loadAgentEnvironment();

//
// endregion Agent and prompt preflight
//

//
// region Git ignore preflight
//

async function isEffectivelyIgnored(
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
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    ) {
      return false;
    }
    throw new Error(
      `Could not check effective Git ignore behavior for ${projectRelativePath}.`,
      { cause: error },
    );
  }
}

async function validateEffectiveIgnoreBehavior(): Promise<void> {
  const protectedPaths = [
    ".sandcastle/.env",
    ".sandcastle/sandcastle.env",
    ".sandcastle/logs/",
    ".sandcastle/worktrees/",
    ".sandcastle/node-modules-overlays/",
    ".sandcastle/merger-recovery.json",
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
    if (!(await isEffectivelyIgnored(protectedPath))) {
      throw new Error(
        `Git ignore protection is required for ${protectedPath}. Add an effective ignore rule before launching agents.`,
      );
    }
  }

  const trackablePaths = [
    ".sandcastle/implement-prompt.md",
    ".sandcastle/review-prompt.md",
    ".sandcastle/merge-prompt.md",
    ".sandcastle/standalone-implement-prompt.md",
    ".sandcastle/standalone-review-prompt.md",
    ".sandcastle/standalone-merge-prompt.md",
    ".sandcastle/final-spec-prompt.md",
    ".sandcastle/sandcastle.env.example",
    ".sandcastle/.env.example",
    ".sandcastle/.gitignore",
  ];

  for (const trackablePath of trackablePaths) {
    if (await isEffectivelyIgnored(trackablePath)) {
      throw new Error(
        `Workflow file ${trackablePath} must remain trackable. Remove the effective ignore rule that hides it.`,
      );
    }
  }
}

await validateEffectiveIgnoreBehavior();

//
// endregion Git ignore preflight
//

//
// endregion Project preflight
//

//
// region Runtime and Sandcastle setup
//

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue.
const MAX_ITERATIONS = maxIterations;

// https://www.eddyvinck.com/blog/how-to-set-up-sandcastle-with-codex/
const hostCodexHome = path.join(os.homedir(), ".codex");
const sandboxCodexMount = "/mnt/host-codex";
const sandboxCodexHome = "/home/agent/.codex";

// Sandboxes need the host Codex credentials, but must not mutate them.
const authHook = {
  command: [
    `mkdir -p "${sandboxCodexHome}"`,
    `test -f "${sandboxCodexMount}/auth.json"`,
    `cp "${sandboxCodexMount}/auth.json" "${sandboxCodexHome}/auth.json"`,
    `if [ -f "${sandboxCodexMount}/config.toml" ]; then cp "${sandboxCodexMount}/config.toml" "${sandboxCodexHome}/config.toml"; fi`,
  ].join(" && "),
};

// Hooks run inside the sandbox before the agent starts each iteration.
const dependencyHooks = {
  sandbox: {
    onSandboxReady: [
      authHook,
      { command: packageManager.commands.install.join(" ") },
    ],
  },
};

const authOnlyHooks = {
  sandbox: {
    onSandboxReady: [authHook],
  },
};

const mounts = [
  {
    hostPath: hostCodexHome,
    sandboxPath: sandboxCodexMount,
    readonly: true,
  },
];
const nodeModulesOverlayRoot = projectPath(
  ".sandcastle",
  "node-modules-overlays",
);

function getSandboxMounts(overlay: NodeModulesOverlay) {
  return [...mounts, overlay.mount];
}

async function withSandboxNodeModulesOverlay<T>(
  sandboxPath: string,
  operation: (overlay: NodeModulesOverlay) => Promise<T>,
): Promise<T> {
  return withNodeModulesOverlay(
    { rootDirectory: nodeModulesOverlayRoot, sandboxPath },
    operation,
  );
}

type SandboxLifecycleResult<T> =
  | { kind: "success"; value: T }
  | { kind: "failure"; error: unknown };

async function closeSandboxWithNodeModulesOverlay<T>(
  sandbox: { close: () => Promise<T> },
  overlay: NodeModulesOverlay,
): Promise<T> {
  let closeResult: SandboxLifecycleResult<T>;

  try {
    closeResult = { kind: "success", value: await sandbox.close() };
  } catch (error) {
    closeResult = { kind: "failure", error };
  }

  let cleanupResult: SandboxLifecycleResult<void>;
  try {
    await removeNodeModulesOverlay(overlay);
    cleanupResult = { kind: "success", value: undefined };
  } catch (error) {
    cleanupResult = { kind: "failure", error };
  }

  if (closeResult.kind === "failure" && cleanupResult.kind === "failure") {
    throw new AggregateError(
      [closeResult.error, cleanupResult.error],
      "Sandbox closure and node_modules overlay cleanup both failed.",
    );
  }
  if (closeResult.kind === "failure") {
    throw closeResult.error;
  }
  if (cleanupResult.kind === "failure") {
    throw cleanupResult.error;
  }

  return closeResult.value;
}

const env = {
  ...agentEnvironment,
  CODEX_HOME: sandboxCodexHome,
  CI: "true",
  PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
};

let dockerImageAvailable = false;

async function requireDockerImage(): Promise<void> {
  if (dockerImageAvailable) {
    return;
  }

  try {
    await execFile("docker", ["image", "inspect", dockerImageName]);
  } catch (error) {
    throw new Error(
      `Docker image '${dockerImageName}' is not available. Build it explicitly with "sandcastle-workflow build-image", then rerun the workflow.`,
      { cause: error },
    );
  }

  dockerImageAvailable = true;
}

//
// endregion Runtime and Sandcastle setup
//

//
// region Agent phase support
//

type ImplementerOutcome = "implemented" | "needs-info" | "stopped";
type ReviewerOutcome = "approved" | "needs-info" | "stopped";
type MergerOutcome = "merged" | "needs-info" | "stopped";
type SandcastleCodexEffort = NonNullable<
  Parameters<typeof sandcastle.codex>[1]
>["effort"];

function createConfiguredAgent(config: {
  model: string;
  effort: string;
}): ReturnType<typeof sandcastle.codex> {
  // Sandcastle forwards effort to Codex at runtime, but its type lists only
  // currently known values. Let the provider validate future model/effort pairs.
  return sandcastle.codex(config.model, {
    effort: config.effort as SandcastleCodexEffort,
  });
}

function createRunName(
  agentType: string,
  modelName: string,
  reasoningLevel: string,
): string {
  return chalk.blue(`${agentType}: ${modelName}, ${reasoningLevel}`);
}

function announceAgentStart(runName: string, branch: string): void {
  console.log(formatAgentStartMessage(runName, branch, new Date()));
}

function formatTimestamp(date = new Date()): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");

  return (
    [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join(
      "",
    ) +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-${pad3(date.getMilliseconds())}`
  );
}

async function requirePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Sandcastle private state path ${directoryPath} must be a real directory.`,
    );
  }
  await chmod(directoryPath, 0o700);
}

async function createLogPath(
  scope: string,
  agentType: string,
): Promise<string> {
  const logDirectory = projectPath(".sandcastle", "logs");
  await requirePrivateDirectory(logDirectory);
  const logPath = path.join(
    logDirectory,
    `sandcastle-${scope}-${agentType}-${formatTimestamp()}-${process.pid}.log`,
  );
  const handle = await open(logPath, "wx", 0o600);
  await handle.close();
  return logPath;
}

//
// endregion Agent phase support
//

//
// region Git state and recovery
//

// Persists the base branch while merger mutates the bind-mounted checkout.
// A later run uses it to recover from process termination before planning.
const mergerRecoveryPath = projectPath(".sandcastle", "merger-recovery.json");

const mergerRecoverySchema = z.object({
  baseBranch: z.string().min(1),
  reviewedBranch: z.string().min(1),
  verificationWorktreePath: z.string().min(1),
});

async function hasSafeWorkingTree(): Promise<boolean> {
  const { stdout } = await execFile("git", ["status", "--porcelain"]);
  const entries = stdout.split("\n").filter(Boolean);
  const untrackedEntries = entries.filter((entry) => entry.startsWith("??"));
  const trackedEntries = entries.filter((entry) => !entry.startsWith("??"));

  if (untrackedEntries.length > 0) {
    console.warn(
      `WARNING: ${untrackedEntries.length} untracked file(s) are present. Continuing.`,
    );
  }

  if (trackedEntries.length === 0) {
    return true;
  }

  console.warn(
    `WARNING: ${trackedEntries.length} tracked working-tree change(s) are present. Aborting before planning.`,
  );
  return false;
}

async function isRebaseInProgress(
  worktreePath = projectRoot,
): Promise<boolean> {
  const rebaseDirectories = await Promise.all(
    ["rebase-merge", "rebase-apply"].map(async (directory) => {
      const { stdout } = await execFile("git", [
        "-C",
        worktreePath,
        "rev-parse",
        "--git-path",
        directory,
      ]);
      return stdout.trim();
    }),
  );

  return rebaseDirectories.some((directory) => existsSync(directory));
}

async function abortRebase(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) {
    return true;
  }

  if (!(await isRebaseInProgress(worktreePath))) {
    return true;
  }

  try {
    await execFile("git", ["-C", worktreePath, "rebase", "--abort"]);
    return true;
  } catch (error) {
    console.warn(
      `WARNING: Could not abort the active rebase in ${worktreePath}. Preserving it for manual recovery. ${formatDiagnostic(error)}`,
    );
    return false;
  }
}

async function recoverBaseCheckout(baseBranch: string): Promise<boolean> {
  if (!(await abortRebase(projectRoot))) {
    return false;
  }

  const { stdout } = await execFile("git", ["status", "--porcelain"]);
  const trackedEntries = stdout
    .split("\n")
    .filter(Boolean)
    .filter((entry) => !entry.startsWith("??"));

  if (trackedEntries.length > 0) {
    console.warn(
      `WARNING: Merger recovery found ${trackedEntries.length} tracked working-tree change(s). Preserving the checkout for manual recovery.`,
    );
    return false;
  }

  try {
    await execFile("git", ["switch", baseBranch]);
    return true;
  } catch (error) {
    console.warn(
      `WARNING: Merger recovery could not switch back to base branch ${baseBranch}. Preserving the checkout for manual recovery. ${formatDiagnostic(error)}`,
    );
    return false;
  }
}

async function getCheckedOutBranch(): Promise<string> {
  const { stdout } = await execFile("git", ["branch", "--show-current"]);
  const branch = stdout.trim();

  if (!branch) {
    console.warn("WARNING: Git did not return the checked-out branch.");
    throw new Error("Git did not return the checked-out branch.");
  }

  return branch;
}

async function getBranchCommit(branch: string): Promise<string> {
  const { stdout } = await execFile("git", ["rev-parse", "--verify", branch]);
  const commit = stdout.trim();

  if (!commit) {
    console.warn(`WARNING: Git did not return a commit for branch ${branch}.`);
    throw new Error(`Git did not return a commit for branch ${branch}.`);
  }

  return commit;
}

async function getBranchHeadCommitSubject(branch: string): Promise<string> {
  const { stdout } = await execFile("git", [
    "log",
    "-1",
    "--pretty=%s",
    branch,
  ]);
  const subject = stdout.trim();

  if (!subject) {
    console.warn(`WARNING: Branch ${branch} has no commit subject in git log.`);
    throw new Error(`Branch ${branch} has no commit subject in git log.`);
  }

  return subject;
}

async function removeVerificationWorktree(
  verificationWorktreePath: string,
): Promise<boolean> {
  const result = await cleanupVerificationWorktree({
    repositoryPath: projectRoot,
    worktreePath: verificationWorktreePath,
  });
  if (result.outcome !== "preserved") {
    return true;
  }

  console.warn(
    `WARNING: Could not remove merger verification worktree. ${result.detail} Recovery marker: ${mergerRecoveryPath}. See .sandcastle/README.md for inspected manual recovery steps.`,
  );
  return false;
}

async function clearMergerRecoveryMarker(): Promise<void> {
  await rm(mergerRecoveryPath, { force: true });
}

async function resolveRegisteredRecoveryWorktree(
  verificationWorktreePath: string,
): Promise<string | undefined> {
  const worktreeRoot = projectPath(".sandcastle", "worktrees");
  const resolvedRoot = await realpath(worktreeRoot);
  if (resolvedRoot !== path.resolve(worktreeRoot)) {
    throw new Error(
      `Workflow worktree directory is redirected: ${worktreeRoot}.`,
    );
  }

  const requestedPath = path.resolve(verificationWorktreePath);
  if (
    !isWithinDirectory(resolvedRoot, requestedPath) ||
    !/^sandcastle-merger-verify-issue-\d+$/.test(path.basename(requestedPath))
  ) {
    throw new Error(
      `Recovery worktree is not an expected verification path: ${requestedPath}.`,
    );
  }

  let metadata;
  try {
    metadata = await lstat(requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Recovery worktree must be a real directory: ${requestedPath}.`,
    );
  }
  const resolvedPath = await realpath(requestedPath);
  if (resolvedPath !== requestedPath) {
    throw new Error(`Recovery worktree is redirected: ${requestedPath}.`);
  }

  const { stdout } = await execFile("git", [
    "-C",
    projectRoot,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const registered = stdout
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => path.resolve(entry.slice("worktree ".length)))
    .includes(resolvedPath);
  if (!registered) {
    throw new Error(
      `Git does not register the recovery worktree: ${resolvedPath}.`,
    );
  }

  return resolvedPath;
}

async function recoverMergerState(
  baseBranch: string,
  verificationWorktreePath: string,
): Promise<boolean> {
  try {
    const resolvedVerificationWorktreePath =
      await resolveRegisteredRecoveryWorktree(verificationWorktreePath);
    const verificationRebaseAborted =
      resolvedVerificationWorktreePath === undefined ||
      (await abortRebase(resolvedVerificationWorktreePath));
    const baseCheckoutRecovered = verificationRebaseAborted
      ? await recoverBaseCheckout(baseBranch)
      : false;
    const verificationWorktreeRemoved = verificationRebaseAborted
      ? await removeVerificationWorktree(verificationWorktreePath)
      : false;

    return baseCheckoutRecovered && verificationWorktreeRemoved;
  } catch (error) {
    console.warn(
      `WARNING: Could not recover merger state for ${verificationWorktreePath}. Preserving it and ${mergerRecoveryPath} for manual recovery. ${formatDiagnostic(error)}`,
    );
    return false;
  }
}

async function recoverAfterMergerValidationFailure(
  error: unknown,
  baseBranch: string,
  verificationWorktreePath: string,
): Promise<never> {
  const recovered = await recoverMergerState(
    baseBranch,
    verificationWorktreePath,
  );
  if (recovered) {
    try {
      await clearMergerRecoveryMarker();
    } catch (markerError) {
      process.exitCode = 1;
      throw new AggregateError(
        [error, markerError],
        "Merger validation failed and its recovery marker could not be cleared.",
      );
    }
    throw error;
  }

  process.exitCode = 1;
  throw new AggregateError(
    [
      error,
      new Error(
        `Merger validation recovery failed. Preserved ${mergerRecoveryPath}.`,
      ),
    ],
    "Merger validation and recovery both failed.",
  );
}

async function recoverInterruptedMerger(): Promise<boolean> {
  if (!existsSync(mergerRecoveryPath)) {
    return true;
  }

  try {
    const marker = mergerRecoverySchema.parse(
      JSON.parse(await readFile(mergerRecoveryPath, "utf8")),
    );
    console.warn(
      `WARNING: Recovering an interrupted merger for base branch ${marker.baseBranch}.`,
    );
    const recovered = await recoverMergerState(
      marker.baseBranch,
      marker.verificationWorktreePath,
    );

    if (recovered) {
      await clearMergerRecoveryMarker();
      console.warn(
        `WARNING: Interrupted merger recovery preserved reviewed branch ${marker.reviewedBranch}.`,
      );
      console.log("Interrupted merger recovery completed.");
    }

    return recovered;
  } catch (error) {
    console.warn(
      `WARNING: Interrupted merger recovery failed. Preserving the checkout and ${mergerRecoveryPath} for manual recovery. ${formatDiagnostic(error)}`,
    );
    return false;
  }
}

async function getBaseSnapshot(): Promise<{
  branch: string;
  commit: string;
}> {
  const { stdout } = await execFile("git", [
    "status",
    "--porcelain=v2",
    "--branch",
  ]);
  const lines = stdout.split("\n");
  const branch = lines
    .find((line) => line.startsWith("# branch.head "))
    ?.slice("# branch.head ".length);
  const commit = lines
    .find((line) => line.startsWith("# branch.oid "))
    ?.slice("# branch.oid ".length);

  if (!branch || branch === "(detached)" || !commit || commit === "(initial)") {
    throw new Error(
      "Sandcastle requires a named base branch with an existing HEAD commit.",
    );
  }

  return { branch, commit };
}

//
// endregion Git state and recovery
//

//
// region GitHub issue data and eligibility
//

async function getOpenReadyIssues(): Promise<ReadyIssue[]> {
  const { stdout } = await execFile("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    "ready-for-agent",
    "--limit",
    "101",
    "--json",
    "number,title,createdAt,parent",
    "--jq",
    "[.[] | {id: (.number | tostring), title, createdAt, parentId: (if .parent == null then null else (.parent.number | tostring) end)}]",
  ]);

  const readyIssues = z
    .array(
      z.object({
        id: z.string().regex(/^\d+$/),
        title: z.string(),
        createdAt: z.string().datetime({ offset: true }),
        parentId: z.string().regex(/^\d+$/).nullable(),
      }),
    )
    .parse(JSON.parse(stdout));
  if (readyIssues.length > 100) {
    throw new InvalidIssueGraphError(
      "Sandcastle found more than 100 open ready-for-agent issues. Reduce the eligible set to the documented version 0.3.6 limit before running the workflow.",
    );
  }
  return readyIssues;
}

async function getNativeSubIssueDetails(issueId: string): Promise<{
  parentId: string | null;
  blockerIds: string[];
  blockingIds: string[];
}> {
  const { stdout } = await execFile("gh", [
    "issue",
    "view",
    issueId,
    "--json",
    "parent,blockedBy,blocking",
  ]);
  const issue = z
    .object({
      parent: z.object({ number: z.number().int().positive() }).nullable(),
      blockedBy: z.object({
        nodes: z.array(z.object({ number: z.number().int().positive() })),
      }),
      blocking: z.object({
        nodes: z.array(z.object({ number: z.number().int().positive() })),
      }),
    })
    .parse(JSON.parse(stdout));

  return {
    parentId: issue.parent === null ? null : String(issue.parent.number),
    blockerIds: issue.blockedBy.nodes.map((blocker) => String(blocker.number)),
    blockingIds: issue.blocking.nodes.map((blocked) => String(blocked.number)),
  };
}

async function getNativeSubIssues(specIssueId: string): Promise<SpecChild[]> {
  const { stdout } = await execFile("gh", [
    "api",
    `repos/{owner}/{repo}/issues/${specIssueId}/sub_issues?per_page=100`,
  ]);
  const issues = z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        state: z.enum(["open", "closed"]),
        labels: z.array(z.object({ name: z.string() })),
      }),
    )
    .parse(JSON.parse(stdout));

  return await Promise.all(
    issues.map(async (issue) => {
      const details = await getNativeSubIssueDetails(String(issue.number));

      if (details.parentId !== specIssueId) {
        throw new InvalidIssueGraphError(
          `GitHub listed issue #${issue.number} under spec #${specIssueId}, but its parent is #${details.parentId ?? "none"}.`,
        );
      }

      return {
        id: String(issue.number),
        title: issue.title,
        status: getIssueStatus({
          state: issue.state.toUpperCase() as "OPEN" | "CLOSED",
          labels: issue.labels.map((label) => label.name),
        }),
        blockerIds: details.blockerIds,
        blocksParent: details.blockingIds.includes(specIssueId),
      };
    }),
  );
}

async function getWorkCandidates(): Promise<{
  candidates: SpecCandidate[];
  standaloneIssues: ReadyIssue[];
  errors: string[];
}> {
  const readyIssues = await getOpenReadyIssues();
  const childrenByParent = new Map<string, readonly SpecChild[]>();
  const nativeSubIssuesByIssue = new Map<string, readonly SpecChild[]>();

  const getCachedNativeSubIssues = async (
    issueId: string,
  ): Promise<readonly SpecChild[]> => {
    const cached = nativeSubIssuesByIssue.get(issueId);
    if (cached) {
      return cached;
    }

    const children = await getNativeSubIssues(issueId);
    nativeSubIssuesByIssue.set(issueId, children);
    return children;
  };

  for (const issue of readyIssues) {
    if (issue.parentId === null) {
      childrenByParent.set(issue.id, await getCachedNativeSubIssues(issue.id));
    }
  }

  const selection = selectSpecCandidates({ readyIssues, childrenByParent });
  const standaloneIssues = selectStandaloneCandidates({
    readyIssues,
    childrenByParent,
  });

  for (const candidate of selection.candidates) {
    selection.errors.push(...validateSpecGraph(candidate));

    for (const child of candidate.children) {
      if ((await getCachedNativeSubIssues(child.id)).length > 0) {
        selection.errors.push(
          `Spec #${candidate.id} has nested sub-issue #${child.id}; nested hierarchies are not supported.`,
        );
      }
    }
  }

  return { ...selection, standaloneIssues };
}

async function getSelectedIssueEligibilityError(
  specIssueId: string,
  issueId: string,
): Promise<string | undefined> {
  let workCandidates: Awaited<ReturnType<typeof getWorkCandidates>>;
  try {
    workCandidates = await getWorkCandidates();
  } catch (error) {
    if (error instanceof InvalidIssueGraphError) {
      return error.message;
    }
    throw error;
  }
  const { candidates, errors } = workCandidates;

  if (errors.length > 0) {
    return errors.join("; ");
  }

  const spec = candidates.find((candidate) => candidate.id === specIssueId);
  if (!spec) {
    return `Spec #${specIssueId} is no longer an open ready-for-agent native parent.`;
  }

  if (
    !getEligibleChildren(spec.children).some((child) => child.id === issueId)
  ) {
    return `Issue #${issueId} is no longer an eligible child of spec #${specIssueId}.`;
  }

  return undefined;
}

async function isIssueClosed(issueId: string): Promise<boolean> {
  const { stdout } = await execFile("gh", [
    "issue",
    "view",
    issueId,
    "--json",
    "state",
    "--jq",
    ".state",
  ]);
  const state = stdout.trim();

  if (state !== "CLOSED" && state !== "OPEN") {
    console.warn(`WARNING: GitHub returned an invalid issue state: ${stdout}`);
    throw new Error(`GitHub returned an invalid issue state: ${stdout}`);
  }

  return state === "CLOSED";
}

//
// endregion GitHub issue data and eligibility
//

//
// region Shared reviewed-branch workflow mechanics
//

async function shouldSkipReviewerAfterRerun(
  branch: string,
  issueId: string,
  workPath: WorkPath,
): Promise<boolean> {
  try {
    const commitSubject = await getBranchHeadCommitSubject(branch);
    return workPath === "spec"
      ? shouldJumpToMergerAfterReuseForSpec(commitSubject, issueId)
      : shouldJumpToMergerAfterReuseForStandalone(commitSubject, issueId);
  } catch (error) {
    console.warn(
      `WARNING: Could not inspect the latest commit on ${branch} for rerun routing. ${formatDiagnostic(error)}`,
    );
    return false;
  }
}

async function writeMergerRecoveryMarker(
  baseBranch: string,
  reviewedBranch: string,
  verificationWorktreePath: string,
): Promise<void> {
  const temporaryPath = `${mergerRecoveryPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({ baseBranch, reviewedBranch, verificationWorktreePath }),
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, mergerRecoveryPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error(
      `Could not write private merger recovery state ${mergerRecoveryPath}.`,
      { cause: error },
    );
  }
}

async function deleteReviewedBranch(branch: string): Promise<void> {
  await execFile("git", ["branch", "-d", branch]);
}

async function createMergerVerificationWorktree(
  verificationWorktreePath: string,
  branch: string,
): Promise<void> {
  await execFile("git", ["worktree", "add", verificationWorktreePath, branch]);
}

//
// endregion Shared reviewed-branch workflow mechanics
//

//
// region Final spec review phase
//

type FinalSpecOutcome = "closed" | "open" | "not-ready" | "stopped";

async function runFinalSpecReview(
  specIssueId: string,
): Promise<AgentPhaseResult<FinalSpecOutcome> & { logPath: string }> {
  await requireDockerImage();
  const branch = await getCheckedOutBranch();
  const logPath = await createLogPath(
    `spec-${specIssueId}-final-review`,
    "final-spec-reviewer",
  );
  const runName = createRunName(
    "final-spec-reviewer",
    AGENT_CONFIG.finalSpecReviewer.model,
    AGENT_CONFIG.finalSpecReviewer.effort,
  );
  announceAgentStart(runName, branch);

  const result = await runAgentPhase<FinalSpecOutcome>({
    phase: "Final spec reviewer",
    context: `spec #${specIssueId}`,
    logPath,
    allowedOutcomes: ["closed", "open", "not-ready", "stopped"],
    run: () =>
      withSandboxNodeModulesOverlay("node_modules", (overlay) =>
        sandcastle.run({
          name: runName,
          cwd: projectRoot,
          maxIterations: 1,
          agent: createConfiguredAgent(AGENT_CONFIG.finalSpecReviewer),
          sandbox: docker({
            imageName: dockerImageName,
            env,
            mounts: getSandboxMounts(overlay),
          }),
          hooks: dependencyHooks,
          branchStrategy: { type: "head" },
          promptFile: promptFiles.get("final-spec-prompt.md"),
          promptArgs: {
            PROJECT_GUIDANCE: promptFiles.getGuidance("final-spec-prompt.md"),
            SPEC_ISSUE_ID: specIssueId,
          },
          logging: { type: "file", path: logPath, verbose: true },
        }),
      ),
  });

  return { ...result, logPath };
}

//
// endregion Final spec review phase
//

//
// region Work selection and dry-run presentation
//

type WorkPath = "spec" | "standalone";

async function chooseWorkPath(): Promise<WorkPath> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (
        await readline.question(
          "Ready spec work and standalone issues are available. Follow the spec path or the standalone/orphan path? [spec/orphan] ",
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "spec") {
        return "spec";
      }
      if (answer === "orphan" || answer === "standalone") {
        return "standalone";
      }

      console.warn('Please enter "spec" or "orphan".');
    }
  } finally {
    readline.close();
  }
}

function printDryRun(
  specCandidates: readonly SpecCandidate[],
  standaloneIssues: readonly ReadyIssue[],
  errors: readonly string[],
  workPath?: WorkPath,
): void {
  console.log("\n=== Sandcastle dry run ===");
  console.log(
    "Dry run only. No agents will be started and no changes will be made.",
  );

  if (errors.length > 0) {
    console.log(
      chalk.red(`Would abort:\n${errors.map((error) => `- ${error}`).join("\n")}`),
    );
    return;
  }

  if (specCandidates.length === 0) {
    if (standaloneIssues.length === 0) {
      console.log("No open ready-for-agent issues found. Dry run complete.");
      return;
    }

    console.log(
      `Standalone issues: ${standaloneIssues.map((issue) => `#${issue.id} ${issue.title}`).join(", ")}.`,
    );
    console.log(
      `Would implement standalone issue #${standaloneIssues[0].id} next.`,
    );
    return;
  }

  console.log(`Spec candidates: ${specCandidates.length}.`);

  for (const candidate of specCandidates) {
    console.log(
      `\nSpec #${candidate.id}: ${candidate.title} (${candidate.createdAt})`,
    );

    for (const child of candidate.children) {
      console.log(`  - #${child.id} ${child.title} (${child.status})`);
    }
  }

  if (workPath === "standalone") {
    console.log(
      `\nSelected standalone/orphan path. Would implement standalone issue #${standaloneIssues[0].id} next.`,
    );
    return;
  }

  const selectedSpec = specCandidates[0];
  const readyChildren = getEligibleChildren(selectedSpec.children);
  const blockedReadyChildren = getBlockedReadyChildren(selectedSpec.children);
  const unresolvedChildren = selectedSpec.children.filter(
    (child) => child.status !== "closed" && child.status !== "ready-for-agent",
  );

  console.log(
    `\nSelected earliest spec: #${selectedSpec.id} ${selectedSpec.title}.`,
  );
  console.log(
    `Ordered ready-for-agent children: ${readyChildren.length === 0 ? "none" : readyChildren.map((child) => `#${child.id} ${child.title}`).join(", ")}.`,
  );

  if (unresolvedChildren.length > 0) {
    console.log(chalk.yellow("Would warn about unresolved children and stop."));
  } else if (readyChildren.length > 0) {
    console.log(`Would implement #${readyChildren[0].id} next.`);
  } else if (blockedReadyChildren.length > 0) {
    console.log(
      chalk.yellow(
        `Would stop: no ready child is unblocked (${blockedReadyChildren.map((child) => `#${child.id}`).join(", ")}).`,
      ),
    );
  } else {
    console.log("Would run final spec review.");
  }
}

//
// endregion Work selection and dry-run presentation
//

//
// region Standalone issue execution
//

type StandaloneOutcome = MergerOutcome | "stale-selection" | "aborted";
type StandaloneRunResult = {
  outcome: StandaloneOutcome;
  reason?: string;
};

async function getStandaloneEligibilityErrorDetail(
  issueId: string,
): Promise<string | undefined> {
  const issue = (await getOpenReadyIssues()).find(
    (candidate) => candidate.id === issueId,
  );

  if (!issue) {
    return `Standalone issue #${issueId} is no longer open and ready-for-agent.`;
  }

  if (issue.parentId !== null) {
    return `Standalone issue #${issueId} now has parent #${issue.parentId}.`;
  }

  const [children, details] = await Promise.all([
    getNativeSubIssues(issueId),
    getNativeSubIssueDetails(issueId),
  ]);
  if (children.length > 0) {
    return `Standalone issue #${issueId} now has native sub-issues.`;
  }

  const openBlockers = (
    await Promise.all(
      details.blockerIds.map(async (blockerId) =>
        (await isIssueClosed(blockerId)) ? undefined : blockerId,
      ),
    )
  ).filter((blockerId): blockerId is string => blockerId !== undefined);
  if (openBlockers.length > 0) {
    return `Standalone issue #${issueId} has open blockers: ${openBlockers.map((blockerId) => `#${blockerId}`).join(", ")}.`;
  }

  return undefined;
}

type StandaloneEligibilityError = {
  kind: "state-changed" | "invalid-graph";
  detail: string;
};

async function getStandaloneEligibilityError(
  issueId: string,
): Promise<StandaloneEligibilityError | undefined> {
  try {
    const detail = await getStandaloneEligibilityErrorDetail(issueId);
    return detail === undefined ? undefined : { kind: "state-changed", detail };
  } catch (error) {
    if (error instanceof InvalidIssueGraphError) {
      return { kind: "invalid-graph", detail: error.message };
    }
    throw error;
  }
}

async function runStandaloneIssue(
  issue: ReadyIssue,
): Promise<StandaloneRunResult> {
  const initialEligibilityError = await getStandaloneEligibilityError(issue.id);
  if (initialEligibilityError) {
    console.warn(
      `WARNING: Skipping standalone issue because GitHub issue state changed: ${initialEligibilityError.detail}`,
    );
    return {
      outcome:
        initialEligibilityError.kind === "invalid-graph"
          ? "stopped"
          : "stale-selection",
    };
  }

  await requireDockerImage();
  const branch = `sandcastle/issue-${issue.id}`;
  const baseSnapshot = await getBaseSnapshot();

  console.log(`Selected standalone issue #${issue.id}: ${issue.title}`);
  console.log(`Branch: ${branch}`);

  const overlay = await createNodeModulesOverlay({
    rootDirectory: nodeModulesOverlayRoot,
    sandboxPath: "node_modules",
  });
  let sandbox: Awaited<ReturnType<typeof sandcastle.createSandbox>> | undefined;
  let sandboxOperationError: unknown;
  let sandboxCloseResult:
    | Awaited<
        ReturnType<
          Awaited<ReturnType<typeof sandcastle.createSandbox>>["close"]
        >
      >
    | undefined;

  try {
    sandbox = await sandcastle.createSandbox({
      branch,
      cwd: projectRoot,
      sandbox: docker({
        imageName: dockerImageName,
        env,
        mounts: getSandboxMounts(overlay),
      }),
      hooks: dependencyHooks,
    });
    const activeSandbox = sandbox;
    const branchCommitBeforeImplementation = await getBranchCommit(branch);
    const reusingImplementation =
      branchCommitBeforeImplementation !== baseSnapshot.commit;
    let jumpToMerger = false;
    if (!reusingImplementation) {
      const runName = createRunName(
        "standalone-implementer",
        AGENT_CONFIG.implementer.model,
        AGENT_CONFIG.implementer.effort,
      );
      announceAgentStart(runName, branch);

      const logPath = await createLogPath(
        `issue-${issue.id}`,
        "standalone-implementer",
      );
      const implement = await runAgentPhase<ImplementerOutcome>({
        phase: "Standalone implementer",
        context: `issue #${issue.id}`,
        logPath,
        allowedOutcomes: ["implemented", "needs-info", "stopped"],
        run: () =>
          activeSandbox.run({
            name: runName,
            maxIterations: 1,
            agent: createConfiguredAgent(AGENT_CONFIG.implementer),
            promptFile: promptFiles.get("standalone-implement-prompt.md"),
            promptArgs: {
              ...verificationPromptArgs,
              ISSUE_ID: issue.id,
              PROJECT_GUIDANCE: promptFiles.getGuidance(
                "standalone-implement-prompt.md",
              ),
            },
            logging: { type: "file", path: logPath, verbose: true },
          }),
      });

      if (implement.outcome !== "implemented") {
        const reason = reportPhaseFailure({
          phase: `Standalone implementer for issue #${issue.id}`,
          outcome: implement.outcome,
          detail: implement.detail,
          logPath,
        });
        return { outcome: "stopped", reason };
      }

      if (
        (await getBranchCommit(branch)) === branchCommitBeforeImplementation
      ) {
        throw new Error(
          "Standalone implementer reported success without creating a commit.",
        );
      }
    } else {
      console.log(
        `Reusing committed standalone implementation on ${branch}; checking whether to continue review or jump to merger.`,
      );
      jumpToMerger = await shouldSkipReviewerAfterRerun(
        branch,
        issue.id,
        "standalone",
      );
      if (jumpToMerger) {
        console.log(
          `Last commit appears to be from Sandcastle reviewer for #${issue.id}; skipping standalone reviewer and jumping to merger.`,
        );
      } else {
        console.log(
          `Last commit for ${branch} does not indicate a completed standalone review for #${issue.id}; continuing to reviewer.`,
        );
      }
    }

    const eligibilityError = await getStandaloneEligibilityError(issue.id);
    if (eligibilityError) {
      console.warn(
        `WARNING: Skipping standalone review because GitHub issue state changed: ${eligibilityError.detail}`,
      );
      return { outcome: "stopped" };
    }

    if (!jumpToMerger) {
      const reviewLogPath = await createLogPath(
        `issue-${issue.id}`,
        "standalone-reviewer",
      );
      const runName = createRunName(
        "standalone-reviewer",
        AGENT_CONFIG.reviewer.model,
        AGENT_CONFIG.reviewer.effort,
      );
      announceAgentStart(runName, branch);

      const review = await runAgentPhase<ReviewerOutcome>({
        phase: "Standalone reviewer",
        context: `issue #${issue.id}`,
        logPath: reviewLogPath,
        allowedOutcomes: ["approved", "needs-info", "stopped"],
        run: () =>
          activeSandbox.run({
            name: runName,
            maxIterations: 1,
            agent: createConfiguredAgent(AGENT_CONFIG.reviewer),
            promptFile: promptFiles.get("standalone-review-prompt.md"),
            promptArgs: {
              ...verificationPromptArgs,
              BASE_COMMIT: baseSnapshot.commit,
              BRANCH: branch,
              ISSUE_ID: issue.id,
              PROJECT_GUIDANCE: promptFiles.getGuidance(
                "standalone-review-prompt.md",
              ),
            },
            logging: { type: "file", path: reviewLogPath, verbose: true },
          }),
      });

      if (review.outcome !== "approved") {
        const reason = reportPhaseFailure({
          phase: `Standalone reviewer for issue #${issue.id}`,
          outcome: review.outcome,
          detail: review.detail,
          logPath: reviewLogPath,
        });
        return { outcome: "stopped", reason };
      }
    }
  } catch (error) {
    sandboxOperationError = error;
    throw error;
  } finally {
    try {
      sandboxCloseResult =
        sandbox === undefined
          ? (await removeNodeModulesOverlay(overlay), undefined)
          : await closeSandboxWithNodeModulesOverlay(sandbox, overlay);
    } catch (error) {
      if (sandboxOperationError !== undefined) {
        throw new AggregateError(
          [sandboxOperationError, error],
          "Sandbox operation and closure both failed.",
        );
      }
      throw error;
    }
  }

  if (sandboxCloseResult?.preservedWorktreePath) {
    console.warn(
      `WARNING: Sandcastle preserved a dirty standalone worktree at ${sandboxCloseResult.preservedWorktreePath}.`,
    );
    process.exitCode = 1;
    return { outcome: "aborted" };
  }

  if (!(await hasSafeWorkingTree())) {
    process.exitCode = 1;
    return { outcome: "aborted" };
  }

  const mergerEligibilityError = await getStandaloneEligibilityError(issue.id);
  if (mergerEligibilityError) {
    console.warn(
      `WARNING: Skipping standalone merge because GitHub issue state changed: ${mergerEligibilityError.detail}`,
    );
    return { outcome: "stopped" };
  }

  const verificationWorktreePaths = getVerificationWorktreePaths(
    projectRoot,
    issue.id,
  );
  const verificationWorktreePath = verificationWorktreePaths.hostPath;
  await writeMergerRecoveryMarker(
    baseSnapshot.branch,
    branch,
    verificationWorktreePath,
  );

  try {
    await createMergerVerificationWorktree(verificationWorktreePath, branch);
  } catch (error) {
    const recovered = await recoverMergerState(
      baseSnapshot.branch,
      verificationWorktreePath,
    );
    if (recovered) {
      try {
        await clearMergerRecoveryMarker();
      } catch (markerError) {
        process.exitCode = 1;
        throw new AggregateError(
          [error, markerError],
          "Merger setup failed and its recovery marker could not be cleared.",
        );
      }
      throw error;
    }

    process.exitCode = 1;
    throw new AggregateError(
      [
        error,
        new Error(
          `Merger setup recovery failed. Preserved ${mergerRecoveryPath}.`,
        ),
      ],
      "Merger setup and recovery both failed.",
    );
  }

  let mergerOutcome: MergerOutcome = "stopped";
  let mergerDetail: string | undefined;
  let mergerFailureReason: string | undefined;
  let mergerSucceeded = false;
  let mergerRecoveryFailed = false;
  let mergerOperationError: unknown;
  const mergerLogPath = await createLogPath(
    `issue-${issue.id}`,
    "standalone-merger",
  );

  try {
    const runName = createRunName(
      "standalone-merger",
      AGENT_CONFIG.merger.model,
      AGENT_CONFIG.merger.effort,
    );
    announceAgentStart(runName, baseSnapshot.branch);

    const merge = await runAgentPhase<MergerOutcome>({
      phase: "Standalone merger",
      context: `issue #${issue.id}`,
      logPath: mergerLogPath,
      allowedOutcomes: ["merged", "needs-info", "stopped"],
      run: () =>
        withSandboxNodeModulesOverlay(
          path.posix.join(
            verificationWorktreePaths.sandboxPath,
            "node_modules",
          ),
          (overlay) =>
            sandcastle.run({
              name: runName,
              cwd: projectRoot,
              maxIterations: 1,
              agent: createConfiguredAgent(AGENT_CONFIG.merger),
              sandbox: docker({
                imageName: dockerImageName,
                env,
                mounts: getSandboxMounts(overlay),
              }),
              hooks: authOnlyHooks,
              branchStrategy: { type: "head" },
              promptFile: promptFiles.get("standalone-merge-prompt.md"),
              promptArgs: {
                ...verificationPromptArgs,
                BASE_BRANCH: baseSnapshot.branch,
                BASE_COMMIT: baseSnapshot.commit,
                BRANCH: branch,
                ISSUE_ID: issue.id,
                PROJECT_GUIDANCE: promptFiles.getGuidance(
                  "standalone-merge-prompt.md",
                ),
                VERIFICATION_WORKTREE_PATH:
                  verificationWorktreePaths.sandboxPath,
              },
              logging: { type: "file", path: mergerLogPath, verbose: true },
            }),
        ),
    });

    mergerOutcome = merge.outcome;
    mergerDetail = merge.detail;
    mergerSucceeded = mergerOutcome === "merged";
    if (!mergerSucceeded) {
      mergerFailureReason = reportPhaseFailure({
        phase: `Standalone merger for issue #${issue.id}`,
        outcome: mergerOutcome,
        detail: mergerDetail,
        logPath: mergerLogPath,
      });
      if (
        mergerDetail &&
        /base branch moved|base guard failed/i.test(mergerDetail)
      ) {
        console.warn(
          "The base branch may have changed because of a manual commit, cleanup/config commit, another Sandcastle process, or an automated hook or scheduled job.",
        );
      }
    }
  } catch (error) {
    mergerOperationError = error;
    throw error;
  } finally {
    if (!mergerSucceeded) {
      const recovered = await recoverMergerState(
        baseSnapshot.branch,
        verificationWorktreePath,
      );
      if (recovered) {
        try {
          await clearMergerRecoveryMarker();
        } catch (markerError) {
          mergerRecoveryFailed = true;
          process.exitCode = 1;
          if (mergerOperationError !== undefined) {
            throw new AggregateError(
              [mergerOperationError, markerError],
              "Standalone merger phase succeeded in recovery, but its marker could not be cleared.",
            );
          }
          console.warn(
            `WARNING: Standalone merger recovery marker could not be cleared. Preserved ${mergerRecoveryPath}. ${formatDiagnostic(markerError)}`,
          );
        }
      } else {
        mergerRecoveryFailed = true;
        process.exitCode = 1;
        if (mergerOperationError !== undefined) {
          throw new AggregateError(
            [
              mergerOperationError,
              new Error(
                `Standalone merger recovery failed. Preserved ${mergerRecoveryPath}.`,
              ),
            ],
            "Standalone merger phase and recovery both failed.",
          );
        }
      }
    }
  }

  if (mergerOutcome !== "merged") {
    const phaseFailure =
      mergerFailureReason ??
      formatPhaseFailure({
        phase: `Standalone merger for issue #${issue.id}`,
        outcome: mergerOutcome,
        detail: mergerDetail,
        logPath: mergerLogPath,
      });
    return mergerRecoveryFailed
      ? {
          outcome: "aborted",
          reason: `Standalone merger recovery failed after outcome ${mergerOutcome}. Original phase result: ${phaseFailure}`,
        }
      : { outcome: mergerOutcome, reason: phaseFailure };
  }

  if (!(await removeVerificationWorktree(verificationWorktreePath))) {
    console.warn(
      `WARNING: Standalone issue #${issue.id} may already be integrated and closed, but host cleanup failed. The runner will not roll back the merge or reopen the issue.`,
    );
    process.exitCode = 1;
    return {
      outcome: "aborted",
      reason: `Standalone issue #${issue.id} integration completed, but host verification-worktree cleanup failed.`,
    };
  }

  try {
    const [baseCommit, issueCommit, checkedOutBranch, issueClosed] =
      await Promise.all([
        getBranchCommit(baseSnapshot.branch),
        getBranchCommit(branch),
        getCheckedOutBranch(),
        isIssueClosed(issue.id),
      ]);

    if (baseCommit !== issueCommit) {
      throw new Error(
        `Standalone merger reported success, but ${baseSnapshot.branch} does not match ${branch}.`,
      );
    }
    if (checkedOutBranch !== baseSnapshot.branch) {
      throw new Error(
        `Standalone merger left ${checkedOutBranch} checked out instead of ${baseSnapshot.branch}.`,
      );
    }
    if (!issueClosed) {
      throw new Error(
        `Standalone merger reported success, but issue #${issue.id} remains open.`,
      );
    }
  } catch (error) {
    await recoverAfterMergerValidationFailure(
      error,
      baseSnapshot.branch,
      verificationWorktreePath,
    );
  }

  console.log("\nStandalone merge complete.");
  return { outcome: "merged" };
}

//
// endregion Standalone issue execution
//

//
// region Main iteration loop
//

// NOTE:
// 1. ready-for-agent includes parent specs and executable child issues
// 2. implementer should not close the issue but comment on the work done
// 3. reviewer is the quality gate
// 4. merge is the completion gate and closes the issue after success
let runSpecIssueId: string | undefined;
let workPath: WorkPath | undefined;
let skippedStaleStandaloneSelection = false;
let runLock: RunLock | undefined;

if (!isDryRun) {
  await requirePrivateDirectory(projectPath(".sandcastle"));
  await requirePrivateDirectory(projectPath(".sandcastle", "worktrees"));
  await requirePrivateDirectory(
    projectPath(".sandcastle", "node-modules-overlays"),
  );
  runLock = await acquireRunLock(projectPath(".sandcastle", "run.lock"));
  const staleOverlayCleanup = await cleanupStaleNodeModulesOverlays(
    nodeModulesOverlayRoot,
  );
  if (staleOverlayCleanup.preserved.length > 0) {
    console.warn(
      `WARNING: Preserved ${staleOverlayCleanup.preserved.length} node_modules overlay(s) with live, malformed, or unverifiable ownership.`,
    );
  }
}

const recoverySucceeded = isDryRun || (await recoverInterruptedMerger());
if (recoverySucceeded) {
  if (isDryRun) {
    console.log(`\n\nMax iterations: ${MAX_ITERATIONS}`);
  }

  iterationLoop: for (
    let iteration = 1;
    iteration <= MAX_ITERATIONS;
    iteration++
  ) {
    if (!(await hasSafeWorkingTree())) {
      runEndStatus = {
        kind: "aborted",
        reason: "The base checkout has tracked working-tree changes.",
      };
      process.exitCode = 1;
      break;
    }

    if (!isDryRun) {
      console.log(
        chalk.blue(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`),
      );
    }

    let workCandidates: Awaited<ReturnType<typeof getWorkCandidates>>;
    try {
      workCandidates = await getWorkCandidates();
    } catch (error) {
      const planningStatus = classifyPlanningError(error);
      if (!planningStatus) {
        throw error;
      }
      console.warn(`WARNING: ${formatDiagnostic(error)}`);
      runEndStatus = planningStatus;
      break;
    }
    const {
      candidates: specCandidates,
      standaloneIssues,
      errors,
    } = workCandidates;

    if (isDryRun) {
      if (
        errors.length === 0 &&
        specCandidates.length > 0 &&
        standaloneIssues.length > 0
      ) {
        workPath = await chooseWorkPath();
      }
      printDryRun(specCandidates, standaloneIssues, errors, workPath);
      runEndStatus =
        errors.length === 0
          ? {
              kind: "completed",
              reason: "Dry run completed without starting any agents.",
            }
          : {
              kind: "stopped",
              reason:
                "Dry run found invalid GitHub native sub-issue relationships.",
            };
      break;
    }

    if (errors.length > 0) {
      console.warn(
        `WARNING: Sandcastle could not validate native sub-issues:\n${errors.map((error) => `- ${error}`).join("\n")}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: "GitHub native sub-issue validation failed.",
      };
      break;
    }

    if (
      workPath === undefined &&
      specCandidates.length > 0 &&
      standaloneIssues.length > 0
    ) {
      workPath = await chooseWorkPath();
    }

    //
    // region Standalone workflow
    //

    if (
      workPath === "standalone" ||
      (workPath !== "spec" && specCandidates.length === 0)
    ) {
      if (standaloneIssues.length === 0) {
        runEndStatus = getNoStandaloneIssuesStatus({
          skippedStaleSelection: skippedStaleStandaloneSelection,
          standalonePathSelected: workPath === "standalone",
        });
        if (runEndStatus.kind === "stopped") {
          console.warn(`WARNING: ${runEndStatus.reason}`);
        } else {
          console.log(runEndStatus.reason);
        }
        break;
      }

      for (const standaloneIssue of standaloneIssues) {
        const standaloneResult = await runStandaloneIssue(standaloneIssue);
        const standaloneOutcome = standaloneResult.outcome;
        if (standaloneOutcome === "stale-selection") {
          skippedStaleStandaloneSelection = true;
          console.warn(
            "WARNING: Standalone selection was stale. Trying the next candidate.",
          );
          continue;
        }
        if (standaloneOutcome !== "merged") {
          console.warn(
            `Standalone issue outcome: ${standaloneOutcome}. Stopping.`,
          );
          runEndStatus = {
            kind:
              standaloneOutcome === "aborted" || process.exitCode === 1
                ? "aborted"
                : "stopped",
            reason:
              standaloneResult.reason ??
              (standaloneOutcome === "aborted"
                ? `Standalone issue #${standaloneIssue.id} failed a safety check.`
                : process.exitCode === 1
                  ? `Standalone issue #${standaloneIssue.id} could not recover its merger checkout.`
                  : `Standalone issue #${standaloneIssue.id} ended with ${standaloneOutcome}.`),
          };
          break iterationLoop;
        }

        const standaloneBranch = `sandcastle/issue-${standaloneIssue.id}`;
        try {
          await deleteReviewedBranch(standaloneBranch);
        } catch (error) {
          console.warn(
            `WARNING: Standalone issue #${standaloneIssue.id} merged and closed, but reviewed branch ${standaloneBranch} could not be deleted.`,
          );
          console.error(error);
          runEndStatus = {
            kind: "aborted",
            reason: `Standalone issue #${standaloneIssue.id} merged, but its reviewed branch could not be deleted.`,
          };
          process.exitCode = 1;
          break iterationLoop;
        }

        await clearMergerRecoveryMarker();
        console.log("Standalone issue complete.");
        continue iterationLoop;
      }

      console.warn(
        "WARNING: All standalone candidates were stale. Replanning.",
      );
      continue iterationLoop;
    }

    //
    // endregion Standalone workflow
    //

    //
    // region Spec workflow
    //
    // The spec-child workflow is intentionally explicit and independent from
    // the standalone workflow. See README.md for the workflow contract.

    if (workPath === "spec" && specCandidates.length === 0) {
      const reason = "No open ready-for-agent spec issues were found.";
      console.log(reason);
      runEndStatus = { kind: "completed", reason };
      break;
    }

    const selectingFirstSpec = runSpecIssueId === undefined;
    const selectedSpec = selectRunSpec(specCandidates, runSpecIssueId);

    if (!selectedSpec) {
      console.warn(
        `WARNING: Selected spec #${runSpecIssueId} is no longer an open ready-for-agent native parent. Stopping without selecting another spec.`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: `Selected spec #${runSpecIssueId} is no longer eligible.`,
      };
      break;
    }

    runSpecIssueId ??= selectedSpec.id;

    if (selectingFirstSpec && specCandidates.length > 1) {
      console.warn(
        `WARNING: ${specCandidates.length} open spec issues were found. Processing earliest spec #${selectedSpec.id}; other specs and their children are ignored.`,
      );
    }

    const unresolvedChildren = selectedSpec.children.filter(
      (child) =>
        child.status !== "closed" && child.status !== "ready-for-agent",
    );

    if (unresolvedChildren.length > 0) {
      console.warn(
        `WARNING: Spec #${selectedSpec.id} has unresolved child issues. Final review will not run:\n${unresolvedChildren.map((child) => `- #${child.id} ${child.title} (${child.status})`).join("\n")}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: `Spec #${selectedSpec.id} has unresolved child issues.`,
      };
      break;
    }

    const readyChildren = getEligibleChildren(selectedSpec.children);
    const blockedReadyChildren = getBlockedReadyChildren(selectedSpec.children);
    const plannedIssue = readyChildren[0];

    if (!plannedIssue && blockedReadyChildren.length > 0) {
      console.warn(
        `WARNING: Spec #${selectedSpec.id} has no unblocked ready child issues:\n${blockedReadyChildren
          .map(
            (child) =>
              `- #${child.id} blocked by ${child.blockerIds
                .filter(
                  (blockerId) =>
                    selectedSpec.children.find(
                      (candidate) => candidate.id === blockerId,
                    )?.status !== "closed",
                )
                .map((blockerId) => `#${blockerId}`)
                .join(", ")}`,
          )
          .join("\n")}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: `Spec #${selectedSpec.id} has no unblocked ready child issues.`,
      };
      break;
    }

    if (!plannedIssue) {
      if (!(await hasSafeWorkingTree())) {
        runEndStatus = {
          kind: "aborted",
          reason: "The base checkout has tracked working-tree changes.",
        };
        process.exitCode = 1;
        break;
      }

      console.log(
        `Spec #${selectedSpec.id} has no open ready-for-agent child issues. Running final spec review.`,
      );
      const finalSpecReview = await runFinalSpecReview(selectedSpec.id);
      const finalSpecOutcome = finalSpecReview.outcome;
      const finalSpecFailureReason =
        finalSpecOutcome === "closed"
          ? undefined
          : reportPhaseFailure({
              phase: `Final spec reviewer for spec #${selectedSpec.id}`,
              outcome: finalSpecOutcome,
              detail: finalSpecReview.detail,
              logPath: finalSpecReview.logPath,
            });

      const specIssueClosed = await isIssueClosed(selectedSpec.id);

      if (finalSpecOutcome === "closed" && !specIssueClosed) {
        console.warn(
          `WARNING: Final reviewer reported closure, but spec issue #${selectedSpec.id} remains open.`,
        );
        throw new Error(
          `Final reviewer reported closure, but spec issue #${selectedSpec.id} remains open.`,
        );
      }

      if (finalSpecOutcome !== "closed" && specIssueClosed) {
        console.warn(
          `WARNING: Final reviewer reported ${finalSpecOutcome}, but spec issue #${selectedSpec.id} is closed.`,
        );
        throw new Error(
          `Final reviewer reported ${finalSpecOutcome}, but spec issue #${selectedSpec.id} is closed.`,
        );
      }

      if (finalSpecOutcome === "closed") {
        console.log(`Final spec review outcome: ${finalSpecOutcome}.`);
        runEndStatus = {
          kind: "completed",
          reason: `Spec #${selectedSpec.id} passed final review and closed.`,
        };
      } else {
        runEndStatus = {
          kind: "stopped",
          reason:
            finalSpecFailureReason ??
            formatPhaseFailure({
              phase: `Final spec reviewer for spec #${selectedSpec.id}`,
              outcome: finalSpecOutcome,
              detail: finalSpecReview.detail,
              logPath: finalSpecReview.logPath,
            }),
        };
      }
      break;
    }

    const branch = `sandcastle/issue-${plannedIssue.id}`;
    await requireDockerImage();
    const baseSnapshot = await getBaseSnapshot();

    console.log(`Selected issue #${plannedIssue.id}: ${plannedIssue.title}`);
    console.log(`Branch: ${branch}`);

    // Create a single sandbox that both the implementer and reviewer share.
    // This gives both agents a real, named branch that persists across phases.
    const overlay = await createNodeModulesOverlay({
      rootDirectory: nodeModulesOverlayRoot,
      sandboxPath: "node_modules",
    });
    let sandbox:
      | Awaited<ReturnType<typeof sandcastle.createSandbox>>
      | undefined;
    let sandboxOperationError: unknown;
    let sandboxCloseResult:
      | Awaited<
          ReturnType<
            Awaited<ReturnType<typeof sandcastle.createSandbox>>["close"]
          >
        >
      | undefined;

    try {
      sandbox = await sandcastle.createSandbox({
        branch,
        cwd: projectRoot,
        sandbox: docker({
          imageName: dockerImageName,
          env,
          mounts: getSandboxMounts(overlay),
        }),
        hooks: dependencyHooks,
      });
      const activeSandbox = sandbox;
      const branchCommitBeforeImplementation = await getBranchCommit(branch);
      const reusingImplementation =
        branchCommitBeforeImplementation !== baseSnapshot.commit;
      let jumpToMerger = false;
      if (reusingImplementation) {
        console.log(
          `Reusing committed implementation on ${branch}; checking whether to continue review or jump to merger.`,
        );
        jumpToMerger = await shouldSkipReviewerAfterRerun(
          branch,
          plannedIssue.id,
          "spec",
        );
        if (jumpToMerger) {
          console.log(
            `Last commit appears to be from Sandcastle reviewer for #${plannedIssue.id}; skipping reviewer and jumping to merger.`,
          );
        } else {
          console.log(
            `Last commit for ${branch} does not indicate a completed spec review for #${plannedIssue.id}; continuing to reviewer.`,
          );
        }
      } else {
        // ---------------------------------------------------------------------
        // Phase 1: Implement
        // ---------------------------------------------------------------------
        const runName = createRunName(
          "implementer",
          AGENT_CONFIG.implementer.model,
          AGENT_CONFIG.implementer.effort,
        );
        announceAgentStart(runName, branch);

        const logPath = await createLogPath(
          `issue-${plannedIssue.id}`,
          "implementer",
        );
        const implement = await runAgentPhase<ImplementerOutcome>({
          phase: "Implementer",
          context: `issue #${plannedIssue.id}`,
          logPath,
          allowedOutcomes: ["implemented", "needs-info", "stopped"],
          run: () =>
            activeSandbox.run({
              name: runName,
              maxIterations: 1,
              agent: createConfiguredAgent(AGENT_CONFIG.implementer),
              promptFile: promptFiles.get("implement-prompt.md"),
              promptArgs: {
                ...verificationPromptArgs,
                ISSUE_ID: plannedIssue.id,
                PROJECT_GUIDANCE: promptFiles.getGuidance(
                  "implement-prompt.md",
                ),
                SPEC_ISSUE_ID: selectedSpec.id,
              },
              logging: { type: "file", path: logPath, verbose: true },
            }),
        });

        if (implement.outcome !== "implemented") {
          const reason = reportPhaseFailure({
            phase: `Implementer for issue #${plannedIssue.id}`,
            outcome: implement.outcome,
            detail: implement.detail,
            logPath,
          });
          runEndStatus = { kind: "stopped", reason };
          break;
        }

        const branchCommitAfterImplementation = await getBranchCommit(branch);
        if (
          branchCommitAfterImplementation === branchCommitBeforeImplementation
        ) {
          throw new Error(
            "Implementer reported success without creating a commit.",
          );
        }

        console.log(`\nImplementation complete on branch: ${branch}`);
      }

      const reviewEligibilityError = await getSelectedIssueEligibilityError(
        selectedSpec.id,
        plannedIssue.id,
      );
      if (reviewEligibilityError) {
        console.warn(
          `WARNING: Skipping review because GitHub issue relationships changed: ${reviewEligibilityError}`,
        );
        runEndStatus = {
          kind: "stopped",
          reason: "GitHub issue relationships changed before review.",
        };
        break;
      }

      // -----------------------------------------------------------------------
      // Phase 2: Review
      //
      // The reviewer inspects the diff of the branch produced by
      // Phase 1. It uses the {{BRANCH}} prompt argument to inspect the right
      // branch, and either approves or makes corrections directly on the branch.
      // -----------------------------------------------------------------------
      if (!jumpToMerger) {
        const reviewLogPath = await createLogPath(
          `issue-${plannedIssue.id}`,
          "reviewer",
        );
        const runName = createRunName(
          "reviewer",
          AGENT_CONFIG.reviewer.model,
          AGENT_CONFIG.reviewer.effort,
        );
        announceAgentStart(runName, branch);

        const review = await runAgentPhase<ReviewerOutcome>({
          phase: "Reviewer",
          context: `issue #${plannedIssue.id}`,
          logPath: reviewLogPath,
          allowedOutcomes: ["approved", "needs-info", "stopped"],
          run: () =>
            activeSandbox.run({
              name: runName,
              maxIterations: 1,
              agent: createConfiguredAgent(AGENT_CONFIG.reviewer),
              promptFile: promptFiles.get("review-prompt.md"),
              promptArgs: {
                ...verificationPromptArgs,
                BASE_COMMIT: baseSnapshot.commit,
                BRANCH: branch,
                ISSUE_ID: plannedIssue.id,
                PROJECT_GUIDANCE: promptFiles.getGuidance("review-prompt.md"),
                SPEC_ISSUE_ID: selectedSpec.id,
              },
              logging: { type: "file", path: reviewLogPath, verbose: true },
            }),
        });

        if (review.outcome !== "approved") {
          const reason = reportPhaseFailure({
            phase: `Reviewer for issue #${plannedIssue.id}`,
            outcome: review.outcome,
            detail: review.detail,
            logPath: reviewLogPath,
          });
          runEndStatus = { kind: "stopped", reason };
          break;
        }

        console.log("\nReview complete.");
      }
    } catch (error) {
      sandboxOperationError = error;
      throw error;
    } finally {
      try {
        sandboxCloseResult =
          sandbox === undefined
            ? (await removeNodeModulesOverlay(overlay), undefined)
            : await closeSandboxWithNodeModulesOverlay(sandbox, overlay);
      } catch (error) {
        if (sandboxOperationError !== undefined) {
          throw new AggregateError(
            [sandboxOperationError, error],
            "Sandbox operation and closure both failed.",
          );
        }
        throw error;
      }
    }

    if (sandboxCloseResult?.preservedWorktreePath) {
      console.warn(
        `WARNING: Sandcastle preserved a dirty issue worktree at ${sandboxCloseResult.preservedWorktreePath}. Stopping before merge.`,
      );
      runEndStatus = {
        kind: "aborted",
        reason: "Sandcastle preserved a dirty issue worktree before merge.",
      };
      process.exitCode = 1;
      break;
    }

    if (!(await hasSafeWorkingTree())) {
      runEndStatus = {
        kind: "aborted",
        reason: "The base checkout has tracked working-tree changes.",
      };
      process.exitCode = 1;
      break;
    }

    const mergerEligibilityError = await getSelectedIssueEligibilityError(
      selectedSpec.id,
      plannedIssue.id,
    );
    if (mergerEligibilityError) {
      console.warn(
        `WARNING: Skipping merge because GitHub issue relationships changed: ${mergerEligibilityError}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: "GitHub issue relationships changed before merge.",
      };
      break;
    }

    const verificationWorktreePaths = getVerificationWorktreePaths(
      projectRoot,
      plannedIssue.id,
    );
    const verificationWorktreePath = verificationWorktreePaths.hostPath;
    await writeMergerRecoveryMarker(
      baseSnapshot.branch,
      branch,
      verificationWorktreePath,
    );

    try {
      await createMergerVerificationWorktree(verificationWorktreePath, branch);
    } catch (error) {
      const recovered = await recoverMergerState(
        baseSnapshot.branch,
        verificationWorktreePath,
      );
      if (recovered) {
        try {
          await clearMergerRecoveryMarker();
        } catch (markerError) {
          process.exitCode = 1;
          throw new AggregateError(
            [error, markerError],
            "Merger setup failed and its recovery marker could not be cleared.",
          );
        }
        throw error;
      }

      process.exitCode = 1;
      throw new AggregateError(
        [
          error,
          new Error(
            `Merger setup recovery failed. Preserved ${mergerRecoveryPath}.`,
          ),
        ],
        "Merger setup and recovery both failed.",
      );
    }

    let mergerOutcome: MergerOutcome = "stopped";
    let mergerDetail: string | undefined;
    let mergerFailureReason: string | undefined;
    let mergerSucceeded = false;
    let mergerRecoveryFailed = false;
    let mergerOperationError: unknown;
    const mergerLogPath = await createLogPath(
      `issue-${plannedIssue.id}`,
      "merger",
    );

    try {
      const runName = createRunName(
        "merger",
        AGENT_CONFIG.merger.model,
        AGENT_CONFIG.merger.effort,
      );
      announceAgentStart(runName, baseSnapshot.branch);

      const merge = await runAgentPhase<MergerOutcome>({
        phase: "Merger",
        context: `issue #${plannedIssue.id}`,
        logPath: mergerLogPath,
        allowedOutcomes: ["merged", "needs-info", "stopped"],
        run: () =>
          withSandboxNodeModulesOverlay(
            path.posix.join(
              verificationWorktreePaths.sandboxPath,
              "node_modules",
            ),
            (overlay) =>
              sandcastle.run({
                name: runName,
                cwd: projectRoot,
                maxIterations: 1,
                agent: createConfiguredAgent(AGENT_CONFIG.merger),
                sandbox: docker({
                  imageName: dockerImageName,
                  env,
                  mounts: getSandboxMounts(overlay),
                }),
                hooks: authOnlyHooks,
                branchStrategy: { type: "head" },
                promptFile: promptFiles.get("merge-prompt.md"),
                promptArgs: {
                  ...verificationPromptArgs,
                  BASE_BRANCH: baseSnapshot.branch,
                  BASE_COMMIT: baseSnapshot.commit,
                  BRANCH: branch,
                  ISSUE_ID: plannedIssue.id,
                  PROJECT_GUIDANCE: promptFiles.getGuidance("merge-prompt.md"),
                  SPEC_ISSUE_ID: selectedSpec.id,
                  VERIFICATION_WORKTREE_PATH:
                    verificationWorktreePaths.sandboxPath,
                },
                logging: { type: "file", path: mergerLogPath, verbose: true },
              }),
          ),
      });

      mergerOutcome = merge.outcome;
      mergerDetail = merge.detail;
      mergerSucceeded = mergerOutcome === "merged";
      if (!mergerSucceeded) {
        mergerFailureReason = reportPhaseFailure({
          phase: `Merger for issue #${plannedIssue.id}`,
          outcome: mergerOutcome,
          detail: mergerDetail,
          logPath: mergerLogPath,
        });
        if (
          mergerDetail &&
          /base branch moved|base guard failed/i.test(mergerDetail)
        ) {
          console.warn(
            "The base branch may have changed because of a manual commit, cleanup/config commit, another Sandcastle process, or an automated hook or scheduled job.",
          );
        }
      }
    } catch (error) {
      mergerOperationError = error;
      throw error;
    } finally {
      if (!mergerSucceeded) {
        const recovered = await recoverMergerState(
          baseSnapshot.branch,
          verificationWorktreePath,
        );

        if (recovered) {
          try {
            await clearMergerRecoveryMarker();
          } catch (markerError) {
            mergerRecoveryFailed = true;
            process.exitCode = 1;
            if (mergerOperationError !== undefined) {
              throw new AggregateError(
                [mergerOperationError, markerError],
                "Merger phase succeeded in recovery, but its marker could not be cleared.",
              );
            }
            console.warn(
              `WARNING: Merger recovery marker could not be cleared. Preserved ${mergerRecoveryPath}. ${formatDiagnostic(markerError)}`,
            );
          }
        } else {
          mergerRecoveryFailed = true;
          process.exitCode = 1;
          if (mergerOperationError !== undefined) {
            throw new AggregateError(
              [
                mergerOperationError,
                new Error(
                  `Merger recovery failed. Preserved ${mergerRecoveryPath}.`,
                ),
              ],
              "Merger phase and recovery both failed.",
            );
          }
        }
      }
    }

    if (mergerOutcome !== "merged") {
      const phaseFailure =
        mergerFailureReason ??
        formatPhaseFailure({
          phase: `Merger for issue #${plannedIssue.id}`,
          outcome: mergerOutcome,
          detail: mergerDetail,
          logPath: mergerLogPath,
        });
      runEndStatus = {
        kind: mergerRecoveryFailed ? "aborted" : "stopped",
        reason: mergerRecoveryFailed
          ? `Merger recovery failed after outcome ${mergerOutcome}. Original phase result: ${phaseFailure}`
          : phaseFailure,
      };
      break;
    }

    if (!(await removeVerificationWorktree(verificationWorktreePath))) {
      console.warn(
        `WARNING: Issue #${plannedIssue.id} may already be integrated and closed, but host cleanup failed. The runner will not roll back the merge or reopen the issue.`,
      );
      runEndStatus = {
        kind: "aborted",
        reason: `Issue #${plannedIssue.id} integration completed, but host verification-worktree cleanup failed.`,
      };
      process.exitCode = 1;
      break;
    }

    try {
      const [baseCommit, issueCommit, checkedOutBranch, issueClosed] =
        await Promise.all([
          getBranchCommit(baseSnapshot.branch),
          getBranchCommit(branch),
          getCheckedOutBranch(),
          isIssueClosed(plannedIssue.id),
        ]);

      if (baseCommit !== issueCommit) {
        console.warn(
          `WARNING: Merger reported success, but ${baseSnapshot.branch} does not match ${branch}.`,
        );
        throw new Error(
          `Merger reported success, but ${baseSnapshot.branch} does not match ${branch}.`,
        );
      }

      if (checkedOutBranch !== baseSnapshot.branch) {
        console.warn(
          `WARNING: Merger reported success, but ${checkedOutBranch} is checked out instead of ${baseSnapshot.branch}.`,
        );
        throw new Error(
          `Merger left ${checkedOutBranch} checked out instead of ${baseSnapshot.branch}.`,
        );
      }

      if (!issueClosed) {
        console.warn(
          `WARNING: Merger reported success, but issue #${plannedIssue.id} remains open.`,
        );
        throw new Error(
          `Merger reported success, but issue #${plannedIssue.id} remains open.`,
        );
      }
    } catch (error) {
      await recoverAfterMergerValidationFailure(
        error,
        baseSnapshot.branch,
        verificationWorktreePath,
      );
    }

    try {
      await deleteReviewedBranch(branch);
    } catch (error) {
      console.warn(
        `WARNING: Merge succeeded and issue #${plannedIssue.id} is closed, but reviewed branch ${branch} could not be deleted.`,
      );
      console.error(error);
      runEndStatus = {
        kind: "aborted",
        reason: `Issue #${plannedIssue.id} merged, but its reviewed branch could not be deleted.`,
      };
      process.exitCode = 1;
      break;
    }

    await clearMergerRecoveryMarker();

    console.log("\nMerge complete.");

    if (iteration === MAX_ITERATIONS) {
      runEndStatus = {
        kind: "completed",
        reason: `Reached the ${MAX_ITERATIONS}-iteration limit after merging issue #${plannedIssue.id}.`,
      };
    }

    //
    // endregion Spec workflow
    //
  }

  if (!runEndStatus) {
    runEndStatus = skippedStaleStandaloneSelection
      ? {
          kind: "stopped",
          reason: `Reached the ${MAX_ITERATIONS}-iteration limit while replanning stale standalone selections.`,
        }
      : {
          kind: "completed",
          reason: `Reached the ${MAX_ITERATIONS}-iteration limit.`,
        };
  }
} else {
  runEndStatus = {
    kind: "aborted",
    reason: "Interrupted merger recovery failed.",
  };
  process.exitCode = 1;
}

//
// endregion Main iteration loop
//

//
// region Process completion
//

if (runLock !== undefined) {
  try {
    await runLock.release();
  } catch (error) {
    console.error(`ERROR: ${formatDiagnostic(error)}`);
    runEndStatus = {
      kind: "aborted",
      reason:
        "The workflow finished, but its active-run lock could not be released safely.",
    };
    process.exitCode = 1;
  }
}

if (runEndStatus.kind === "stopped" && !process.exitCode) {
  process.exitCode = 3;
}

await runCompletion.printSummary();

//
// endregion Process completion
//
