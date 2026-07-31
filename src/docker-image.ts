import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";
import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  isWithinDirectory,
  requireReadableRegularFile,
} from "./file-resolution.ts";

export type DockerfileSelection = {
  path: string;
  context: string;
  source: "built-in" | "project override";
};

export function resolveDockerImageName(
  configuredImage: string | undefined,
  projectRoot: string
): string {
  return configuredImage ?? defaultImageName(projectRoot);
}

export async function resolveDockerfile(options: {
  projectRoot: string;
  workflowRoot: string;
}): Promise<DockerfileSelection> {
  const { projectRoot, workflowRoot } = options;
  const overridePath = path.join(projectRoot, ".sandcastle", "Dockerfile");

  try {
    await lstat(overridePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Could not inspect project Dockerfile override.", {
        cause: error,
      });
    }

    const builtInPath = await requireReadableRegularFile(
      path.join(workflowRoot, "defaults", "docker", "Dockerfile"),
      "Built-in Dockerfile"
    );
    return {
      path: builtInPath,
      context: path.dirname(builtInPath),
      source: "built-in",
    };
  }

  const resolvedOverridePath = await requireReadableRegularFile(
    overridePath,
    "Project Dockerfile override"
  );
  if (!isWithinDirectory(projectRoot, resolvedOverridePath)) {
    throw new Error(
      `Project Dockerfile override resolves outside the active Git worktree: ${resolvedOverridePath}.`
    );
  }

  return {
    path: resolvedOverridePath,
    context: projectRoot,
    source: "project override",
  };
}
