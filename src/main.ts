// Sequential selection → implementer → reviewer → integration workflow
//
// The runner, not an agent, owns the Control Plane decisions (ADR-0001) and
// every base-branch update. Each issue moves through these steps in order:
//   Selection:   the runner reads GitHub native sub-issues and blocking
//                relationships. It follows the earliest ready Specification
//                for the whole run, or the standalone path; the operator
//                chooses when both have work. A Standalone Issue with an open
//                blocker waits.
//   Implementer: works on the issue branch and commits the change.
//   Reviewer:    reviews the branch diff and either approves it or commits
//                corrections on the branch.
//   Integration: the runner rebases the reviewed branch onto the live base
//                branch in the issue sandbox and runs install, typecheck, and
//                test there. Only when they pass does it move the issue branch,
//                fast-forward the base branch with `git merge --ff-only`, close
//                the issue, and delete the branch. When the base moved first,
//                it tries again, for at most 3 attempts in total.
//   Reporter:    runs only when the rebase conflicts or verification fails.
//                It explains why and gives the operator options; it changes
//                nothing. The runner aborts the rebase, keeps the branch, and
//                publishes the Integration Report.
// When every direct child of the selected Specification is closed, the final
// spec reviewer reviews the integrated result and closes the Specification.
//
// The implementer, reviewer, Integration, and Reporter share a single sandbox
// created via createSandbox() on the issue branch's own worktree; no agent
// mounts the main checkout (ADR-0002). The runner checks each agent phase's
// commits for Dockerfile changes, and every agent phase for changed guarded
// refs, and aborts the run on either.
//
// A normal run holds the active-run lock. The outer loop repeats up to
// MAX_ITERATIONS times, integrating
// at most one issue per iteration and stopping early when no eligible work
// remains or a phase stops. This keeps the workflow fully sequential.
//
// This module is the entry point (sandcastle-workflow): it parses the
// command, runs preflight in order, builds the RunContext, and holds the
// active-run lock around run-loop.ts. Selection and the loop live in
// run-loop.ts, each issue's phases in issue-workflow.ts, and the final spec
// review in final-spec-review.ts.

import chalk from "chalk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRunCompletionReporter,
  formatDiagnostic,
  type RunEndStatus,
} from "./run-completion.ts";
import { cleanupStaleNodeModulesOverlays } from "./node-modules-overlay.ts";
import {
  findOptionalProjectGuidance,
  resolvePromptFiles,
} from "./prompt-resolution.ts";
import {
  ejectDockerfile,
  initializeProject,
  reportInitialization,
} from "./initialization.ts";
import { resolveDockerfile, resolveDockerImageName } from "./docker-image.ts";
import { resolvePackageManager } from "./package-manager.ts";
import { createProjectExec, type RunContext } from "./run-context.ts";
import {
  getAgentConfig,
  loadAgentEnvironment,
  loadRunnerConfig,
  requireMaxIterations,
} from "./runner-config.ts";
import {
  discoverProjectRoot,
  requireProjectSandcastleDirectory,
  validateEffectiveIgnoreBehavior,
  validateGitHubRepository,
} from "./project-preflight.ts";
import { createGitState } from "./git-state.ts";
import { createControlPlane } from "./control-plane.ts";
import { createAgentRuntime } from "./agent-runtime.ts";
import { requirePrivateDirectory } from "./file-resolution.ts";
import { runWorkflow } from "./run-loop.ts";
import { acquireRunLock, type RunLock } from "./run-lock.ts";

type CliMode =
  | "run"
  | "init"
  | "eject-dockerfile"
  | "build-image"
  | "dry-run"
  | "help"
  | "version";

const usage = `Usage: sandcastle-workflow [command]

Commands:
  init         Create project-local examples and ignore rules
  eject-dockerfile
               Copy the packaged Dockerfile to .sandcastle/Dockerfile
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
    case "eject-dockerfile":
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

console.log(chalk.blue(`Sandcastle Workflow v${packageVersion}\n`));

//
// region Run completion reporting
//

let runEndStatus: RunEndStatus | undefined;
const runCompletion = createRunCompletionReporter(() => runEndStatus);
runCompletion.installProcessHandlers();

const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

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

if (command === "eject-dockerfile") {
  const dockerfilePath = projectPath(".sandcastle", "Dockerfile");
  const outcome = await ejectDockerfile(
    projectRoot,
    path.join(workflowRoot, "defaults", "docker", "Dockerfile"),
  );
  console.log(`${outcome === "created" ? "Created" : "Preserved"} ${dockerfilePath}`);
  runCompletion.setStatus({
    kind: "completed",
    reason: `${outcome === "created" ? "Created" : "Preserved"} project Dockerfile at ${dockerfilePath}.`,
  });
  await runCompletion.printSummary();
  process.exit(0);
}

function projectPath(...segments: string[]): string {
  return path.join(projectRoot, ...segments);
}

await requireProjectSandcastleDirectory(projectRoot);

const execFile = createProjectExec(projectRoot);
const git = createGitState(execFile);
const controlPlane = createControlPlane({ execFile, packageVersion });

const packageManager = await resolvePackageManager(projectRoot, packageVersion);
const verificationCommands = {
  install: packageManager.commands.install.join(" "),
  typecheck: packageManager.commands.typecheck.join(" "),
  test: packageManager.commands.test.join(" "),
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

const runnerConfig = await loadRunnerConfig(projectRoot);

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
  const dockerfileSource =
    dockerfile.source === "packaged"
      ? chalk.blue(dockerfile.source)
      : dockerfile.source;
  console.log(`Dockerfile: ${dockerfile.path} (${dockerfileSource})`);
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

await validateGitHubRepository(execFile, packageVersion);

//
// endregion GitHub preflight
//

//
// region Agent and prompt preflight
//

const maxIterations = requireMaxIterations(projectRoot, runnerConfig);

// Review these model and effort choices together when optimizing run costs.
const AGENT_CONFIG = getAgentConfig(runnerConfig);

const optionalGuidance = await findOptionalProjectGuidance(projectRoot);
const promptFiles = await resolvePromptFiles({ projectRoot, workflowRoot });
for (const selection of promptFiles.selections) {
  console.log(
    `Prompt ${selection.filename}: ${chalk.blue("packaged")} ${selection.path}`,
  );
  if (selection.guidancePath !== undefined) {
    console.log(
      chalk.blue(
        `Project guidance ${selection.filename}: ${selection.guidancePath}`,
      ),
    );
  }
}
if (!optionalGuidance.codingStandards) {
  console.log(
    "Info: No CODING_STANDARDS.md found; reviewers will apply general good practice.",
  );
}
if (!optionalGuidance.agentInstructions) {
  console.log("Info: No AGENTS.md found.");
}

const agentEnvironment = isDryRun ? {} : await loadAgentEnvironment(projectRoot);

//
// endregion Agent and prompt preflight
//

//
// region Git ignore preflight
//

await validateEffectiveIgnoreBehavior(execFile);

//
// endregion Git ignore preflight
//

//
// endregion Project preflight
//

//
// region Runtime and Sandcastle setup
//

const runtime = createAgentRuntime({
  projectRoot,
  execFile,
  dockerImageName,
  installCommand: packageManager.commands.install,
  agentEnvironment,
});

const runContext: RunContext = {
  projectRoot,
  agentConfig: AGENT_CONFIG,
  promptFiles,
  verificationCommands,
  git,
  controlPlane,
  runtime,
};

//
// endregion Runtime and Sandcastle setup
//

//
// region Workflow run
//

let runLock: RunLock | undefined;

if (!isDryRun) {
  await requirePrivateDirectory(projectPath(".sandcastle"));
  await requirePrivateDirectory(projectPath(".sandcastle", "worktrees"));
  await requirePrivateDirectory(
    projectPath(".sandcastle", "node-modules-overlays"),
  );
  runLock = await acquireRunLock(projectPath(".sandcastle", "run.lock"));
  const staleOverlayCleanup = await cleanupStaleNodeModulesOverlays(
    runtime.nodeModulesOverlayRoot,
  );
  if (staleOverlayCleanup.preserved.length > 0) {
    console.warn(
      `WARNING: Preserved ${staleOverlayCleanup.preserved.length} node_modules overlay(s) with live, malformed, or unverifiable ownership.`,
    );
  }
}

runEndStatus = await runWorkflow(runContext, { isDryRun, maxIterations });

//
// endregion Workflow run
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
