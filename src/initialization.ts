import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getErrorCode } from "./error-code.ts";

const ignoreContents = [
  ".env",
  "sandcastle.env",
  "logs/",
  "worktrees/",
  "node-modules-overlays/",
  "run.lock",
  "",
].join("\n");

const roleExamples = [
  { prefix: "IMPLEMENTER", role: "Implementer" },
  { prefix: "REVIEWER", role: "Reviewer" },
  { prefix: "REPORTER", role: "Reporter" },
  { prefix: "FINAL_SPEC_REVIEWER", role: "Final Spec Reviewer" },
] as const;

const runnerConfigExample = [
  "# Runner-only agent configuration. These values are not forwarded to agents.",
  "# Every key is required except DOCKER_IMAGE; set each value explicitly.",
  ...roleExamples.flatMap(({ prefix, role }) => [
    "",
    `# ${role} agent: codex or claude-code. Example: ${prefix}_AGENT=codex`,
    `${prefix}_AGENT=`,
    `# ${role} model, a model name that agent accepts. Example: ${prefix}_MODEL=gpt-6.2-sol (codex) or ${prefix}_MODEL=claude-opus-5-5 (claude-code)`,
    `${prefix}_MODEL=`,
    `# ${role} effort: low, medium, high, xhigh, or max for claude-code; any effort the model accepts for codex. Example: ${prefix}_EFFORT=high`,
    `${prefix}_EFFORT=`,
  ]),
  "",
  "# Workflow iterations per run, each integrating at most one issue: a positive integer. Example: MAX_ITERATIONS=3",
  "MAX_ITERATIONS=",
  "",
  "# Optional Docker image reference: any image name and tag. When absent, Sandcastle derives",
  "# sandcastle:<project>-v<package-version>. Example: DOCKER_IMAGE=sandcastle:my-project",
  "# DOCKER_IMAGE=",
  "",
].join("\n");

const agentEnvironmentExample = [
  "# Agent credentials. Only GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN are supported;",
  "# any other key stops preflight. Tokens are read only from this file; the runner",
  "# ignores them in the host environment. A declared key must have a value.",
  "",
  "# Required: GitHub personal access token for the runner's GitHub calls and for agents.",
  "# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new",
  "# Required repository permissions: Issues (Read and write) and Metadata (Read)",
  "# Example: GH_TOKEN=github_pat_...",
  "GH_TOKEN=",
  "",
  "# Optional: Claude Code login token from `claude setup-token`, used when a role runs claude-code.",
  "# Without it, Claude Code uses the ~/.claude/.credentials.json login. On macOS, where Claude",
  "# Code keeps its login in the Keychain, set this token.",
  "# Example: CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...",
  "# CLAUDE_CODE_OAUTH_TOKEN=",
  "",
].join("\n");

type InitializationResult = {
  created: readonly string[];
  preserved: readonly string[];
};

async function createSandcastleDirectory(
  sandcastleRoot: string
): Promise<"created" | "preserved"> {
  try {
    await mkdir(sandcastleRoot, { mode: 0o700 });
    return "created";
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") {
      throw error;
    }
  }

  const stats = await lstat(sandcastleRoot);
  if (stats.isSymbolicLink()) {
    throw new Error(
      `Refusing to initialize through symbolic Sandcastle directory ${sandcastleRoot}.`
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `Sandcastle initialization path ${sandcastleRoot} exists but is not a directory.`
    );
  }

  return "preserved";
}

async function createExclusiveFile(
  filePath: string,
  contents: string
): Promise<"created" | "preserved"> {
  try {
    await writeFile(filePath, contents, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (getErrorCode(error) === "EEXIST") {
      return "preserved";
    }
    throw error;
  }
}

export async function ejectDockerfile(
  projectRoot: string,
  packagedDockerfilePath: string
): Promise<"created" | "preserved"> {
  const sandcastleRoot = path.join(projectRoot, ".sandcastle");
  await createSandcastleDirectory(sandcastleRoot);
  const dockerfileContents = await readFile(packagedDockerfilePath, "utf8");
  return createExclusiveFile(
    path.join(sandcastleRoot, "Dockerfile"),
    dockerfileContents
  );
}

export async function initializeProject(
  projectRoot: string
): Promise<InitializationResult> {
  const sandcastleRoot = path.join(projectRoot, ".sandcastle");
  const directoryOutcome = await createSandcastleDirectory(sandcastleRoot);
  const created: string[] = [];
  const preserved: string[] = [];

  if (directoryOutcome === "created") {
    created.push(sandcastleRoot);
  } else {
    preserved.push(sandcastleRoot);
  }

  const files = [
    {
      path: path.join(sandcastleRoot, ".gitignore"),
      contents: ignoreContents,
    },
    {
      path: path.join(sandcastleRoot, "sandcastle.env.example"),
      contents: runnerConfigExample,
    },
    {
      path: path.join(sandcastleRoot, ".env.example"),
      contents: agentEnvironmentExample,
    },
  ];

  for (const file of files) {
    const outcome = await createExclusiveFile(file.path, file.contents);
    if (outcome === "created") {
      created.push(file.path);
    } else {
      preserved.push(file.path);
    }
  }

  return { created, preserved };
}

export function reportInitialization(
  result: InitializationResult,
  projectRoot: string,
  relationshipSkillPath: string
): void {
  console.log(`Sandcastle project root: ${projectRoot}`);
  for (const filePath of result.created) {
    console.log(`Created ${filePath}`);
  }
  for (const filePath of result.preserved) {
    console.log(`Preserved ${filePath}`);
  }
  console.log("Next steps:");
  console.log(
    "1. Copy .sandcastle/sandcastle.env.example to .sandcastle/sandcastle.env and choose every runner value."
  );
  console.log(
    "2. Copy .sandcastle/.env.example to .sandcastle/.env and set GH_TOKEN, and CLAUDE_CODE_OAUTH_TOKEN when a role runs claude-code, before launching agents."
  );
  console.log(
    "3. Configure the GitHub relationship skill project-locally before using an agent to publish spec children."
  );
  console.log(`   Packaged skill: ${relationshipSkillPath}`);
  console.log(
    "   Recommended project link: .agents/skills/github-ticket-relationships"
  );
}
