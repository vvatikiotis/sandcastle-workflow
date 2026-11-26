import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { getErrorCode } from "./error-code.ts";
import {
  isWithinDirectory,
  requireReadableRegularFile,
} from "./file-resolution.ts";

export type DockerfileSelection = {
  path: string;
  context: string;
  source: "packaged" | "project override";
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
    if (getErrorCode(error) !== "ENOENT") {
      throw new Error("Could not inspect project override.", {
        cause: error,
      });
    }

    const packagedPath = await requireReadableRegularFile(
      path.join(workflowRoot, "defaults", "docker", "Dockerfile"),
      "Packaged Dockerfile"
    );
    return {
      path: packagedPath,
      context: path.dirname(packagedPath),
      source: "packaged",
    };
  }

  const resolvedOverridePath = await requireReadableRegularFile(
    overridePath,
    "Project override"
  );
  if (!isWithinDirectory(projectRoot, resolvedOverridePath)) {
    throw new Error(
      `Project override resolves outside the active Git worktree: ${resolvedOverridePath}.`
    );
  }

  return {
    path: resolvedOverridePath,
    context: projectRoot,
    source: "project override",
  };
}
