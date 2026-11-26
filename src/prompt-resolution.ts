import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  isWithinDirectory,
  requireReadableRegularFile,
} from "./file-resolution.ts";

export const promptFilenames = [
  "implement-prompt.md",
  "review-prompt.md",
  "merge-prompt.md",
  "standalone-implement-prompt.md",
  "standalone-review-prompt.md",
  "standalone-merge-prompt.md",
  "final-spec-prompt.md",
] as const;

export type PromptFilename = (typeof promptFilenames)[number];

export type PromptSelection = {
  filename: PromptFilename;
  path: string;
  guidance: string;
  guidancePath?: string;
};

export type OptionalProjectGuidance = {
  codingStandards: boolean;
  agentInstructions: boolean;
};

function getErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

// An absent file is allowed; a present one must still be a readable regular
// file so that agents are not silently given guidance they cannot read.
async function hasOptionalProjectFile(
  projectRoot: string,
  filename: string,
  description: string
): Promise<boolean> {
  const filePath = path.join(projectRoot, filename);
  try {
    await lstat(filePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw new Error(`Could not inspect ${description}.`, { cause: error });
  }
  await requireReadableRegularFile(filePath, description);
  return true;
}

export async function findOptionalProjectGuidance(
  projectRoot: string
): Promise<OptionalProjectGuidance> {
  const [codingStandards, agentInstructions] = await Promise.all([
    hasOptionalProjectFile(
      projectRoot,
      "CODING_STANDARDS.md",
      "Root project coding standards CODING_STANDARDS.md"
    ),
    hasOptionalProjectFile(
      projectRoot,
      "AGENTS.md",
      "Root project agent instructions AGENTS.md"
    ),
  ]);
  return { codingStandards, agentInstructions };
}

async function resolvePromptSelection(options: {
  filename: PromptFilename;
  projectRoot: string;
  workflowRoot: string;
}): Promise<PromptSelection> {
  const { filename, projectRoot, workflowRoot } = options;
  const packagedPath = await requireReadableRegularFile(
    path.join(workflowRoot, "defaults", "prompts", filename),
    `Packaged prompt ${filename}`
  );
  const guidancePath = path.join(projectRoot, ".sandcastle", filename);

  try {
    await lstat(guidancePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filename, path: packagedPath, guidance: "" };
    }
    throw new Error(`Could not inspect project guidance ${filename}.`, {
      cause: error,
    });
  }

  const resolvedGuidancePath = await requireReadableRegularFile(
    guidancePath,
    `Project guidance ${filename}`
  );
  if (!isWithinDirectory(projectRoot, resolvedGuidancePath)) {
    throw new Error(
      `Project guidance ${filename} resolves outside the active Git worktree: ${resolvedGuidancePath}.`
    );
  }

  return {
    filename,
    path: packagedPath,
    guidance: await readFile(resolvedGuidancePath, "utf8"),
    guidancePath: resolvedGuidancePath,
  };
}

export async function resolvePromptFiles(options: {
  projectRoot: string;
  workflowRoot: string;
}): Promise<{
  get: (filename: PromptFilename) => string;
  getGuidance: (filename: PromptFilename) => string;
  selections: readonly PromptSelection[];
}> {
  const canonicalProjectRoot = await realpath(options.projectRoot);
  const selections = await Promise.all(
    promptFilenames.map((filename) =>
      resolvePromptSelection({
        ...options,
        filename,
        projectRoot: canonicalProjectRoot,
      })
    )
  );
  const selectionByFilename = new Map(
    selections.map((selection) => [selection.filename, selection])
  );

  function getSelection(filename: PromptFilename): PromptSelection {
    const selection = selectionByFilename.get(filename);
    if (selection === undefined) {
      throw new Error(`No prompt selection exists for ${filename}.`);
    }
    return selection;
  }

  return {
    get(filename): string {
      return getSelection(filename).path;
    },
    getGuidance(filename): string {
      return getSelection(filename).guidance;
    },
    selections,
  };
}
