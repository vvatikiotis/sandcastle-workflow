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
  projectRoot: string,
  packageVersion: string
): string {
  if (configuredImage !== undefined) {
    return configuredImage;
  }

  const normalizedVersion = packageVersion.replace(/[^A-Za-z0-9_.-]/g, "-");
  const imageName = `${defaultImageName(projectRoot)}-v${normalizedVersion}`;
  const tag = imageName.slice(imageName.lastIndexOf(":") + 1);
  if (tag.length > 128) {
    throw new Error(
      `Derived Docker image tag exceeds Docker's 128-character limit: ${imageName}. Configure DOCKER_IMAGE explicitly.`
    );
  }
  return imageName;
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
