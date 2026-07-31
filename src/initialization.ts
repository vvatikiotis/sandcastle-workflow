import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ignoreContents = [
  ".env",
  "sandcastle.env",
  "logs/",
  "worktrees/",
  "node-modules-overlays/",
  "merger-recovery.json",
  "",
].join("\n");

const runnerConfigExample = [
  "# Runner-only agent configuration. These values are not forwarded to agents.",
  "IMPLEMENTER_MODEL=",
  "IMPLEMENTER_EFFORT=",
  "REVIEWER_MODEL=",
  "REVIEWER_EFFORT=",
  "MERGER_MODEL=",
  "MERGER_EFFORT=",
  "FINAL_SPEC_REVIEWER_MODEL=",
  "FINAL_SPEC_REVIEWER_EFFORT=",
  "MAX_ITERATIONS=",
  "",
  "# Optional Docker image reference. When absent, Sandcastle derives sandcastle:<project>.",
  "# DOCKER_IMAGE=sandcastle:<project>",
  "",
].join("\n");

const agentEnvironmentExample = [
  "# GitHub personal access token forwarded to agents for GitHub Issues access.",
  "# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new",
  "# Required repository permissions: Issues (Read and write) and Metadata (Read)",
  "# Leave empty to use a non-empty GH_TOKEN from the host environment.",
  "GH_TOKEN=",
  "",
].join("\n");

type InitializationResult = {
  created: readonly string[];
  preserved: readonly string[];
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function createSandcastleDirectory(
  sandcastleRoot: string
): Promise<"created" | "preserved"> {
  try {
    await mkdir(sandcastleRoot);
    return "created";
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
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
    if (hasErrorCode(error, "EEXIST")) {
      return "preserved";
    }
    throw error;
  }
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
    "2. Copy .sandcastle/.env.example to .sandcastle/.env and set GH_TOKEN before launching agents."
  );
  console.log(
    "3. Configure the GitHub relationship skill project-locally before using an agent to publish spec children."
  );
  console.log(`   Packaged skill: ${relationshipSkillPath}`);
  console.log(
    "   Recommended project link: .agents/skills/github-ticket-relationships"
  );
}
