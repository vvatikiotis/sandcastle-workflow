import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { getErrorCode } from "./error-code.ts";
import {
  isWithinDirectory,
  requireReadableRegularFile,
} from "./file-resolution.ts";

export const promptFilenames = [
  "implement-prompt.md",
  "review-prompt.md",
  "report-prompt.md",
  "standalone-implement-prompt.md",
  "standalone-review-prompt.md",
  "standalone-report-prompt.md",
  "final-spec-prompt.md",
] as const;

// Project Guidance files an earlier version read, and the file that replaced
// each.
const replacedGuidanceFilenames: ReadonlyArray<
  readonly [string, PromptFilename]
> = [
  ["merge-prompt.md", "report-prompt.md"],
  ["standalone-merge-prompt.md", "standalone-report-prompt.md"],
];

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
    if (getErrorCode(error) === "ENOENT") {
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

export type PromptFiles = {
  // The Packaged Default prompt path.
  get: (filename: PromptFilename) => string;
  // Project Guidance for the prompt, or "" when the project adds none.
  getGuidance: (filename: PromptFilename) => string;
  selections: readonly PromptSelection[];
};

// Stops preflight when the project still has guidance for a replaced prompt,
// so that guidance is not silently ignored.
async function rejectReplacedGuidance(projectRoot: string): Promise<void> {
  for (const [oldFilename, newFilename] of replacedGuidanceFilenames) {
    const guidancePath = path.join(projectRoot, ".sandcastle", oldFilename);
    try {
      await lstat(guidancePath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        continue;
      }
      throw new Error(`Could not inspect project guidance ${oldFilename}.`, {
        cause: error,
      });
    }
    throw new Error(
      `Project guidance .sandcastle/${oldFilename} was replaced by .sandcastle/${newFilename}. The merger no longer exists: the runner integrates, and the Reporter explains failed Integrations. Move any guidance that still applies to .sandcastle/${newFilename}, then delete .sandcastle/${oldFilename}.`,
    );
  }
}

export async function resolvePromptFiles(options: {
  projectRoot: string;
  workflowRoot: string;
}): Promise<PromptFiles> {
  const canonicalProjectRoot = await realpath(options.projectRoot);
  await rejectReplacedGuidance(canonicalProjectRoot);
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
