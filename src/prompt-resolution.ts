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
  source: "built-in" | "project override";
};

type PromptContractElement = {
  description: string;
  value: string;
};

function collectMatches(contents: string, pattern: RegExp): string[] {
  return [...contents.matchAll(pattern)].map((match) => match[0]);
}

function extractPromptContract(contents: string): PromptContractElement[] {
  const elements = [
    ...collectMatches(contents, /\{\{[A-Z][A-Z0-9_]*\}\}/g).map((value) => ({
      description: `placeholder ${value}`,
      value,
    })),
    ...collectMatches(contents, /^!`[^`\r\n]+`\s*$/gm).map((value) => ({
      description: `prompt command ${value}`,
      value,
    })),
    ...collectMatches(
      contents,
      /sandcastle\([^)]+\): #\{\{[A-Z][A-Z0-9_]*\}\}: <short message>/g
    ).map((value) => ({
      description: `artifact prefix ${value}`,
      value,
    })),
    ...collectMatches(
      contents,
      /<phase-outcome>[a-z-]+<\/phase-outcome>|<\/?phase-detail>|<promise>COMPLETE<\/promise>/g
    ).map((value) => ({
      description: `terminal marker ${value}`,
      value,
    })),
  ];

  return [
    ...new Map(
      elements.map((element) => [
        `${element.description}\0${element.value}`,
        element,
      ])
    ).values(),
  ];
}

export async function requireProjectCodingStandards(
  projectRoot: string
): Promise<void> {
  await requireReadableRegularFile(
    path.join(projectRoot, "CODING_STANDARDS.md"),
    "Root project coding standards CODING_STANDARDS.md"
  );
}

async function resolvePromptSelection(options: {
  filename: PromptFilename;
  projectRoot: string;
  workflowRoot: string;
  workflowVersion: string;
}): Promise<PromptSelection> {
  const { filename, projectRoot, workflowRoot, workflowVersion } = options;
  const builtInPath = await requireReadableRegularFile(
    path.join(workflowRoot, "defaults", "prompts", filename),
    `Built-in prompt ${filename}`
  );
  const overridePath = path.join(projectRoot, ".sandcastle", filename);

  try {
    await lstat(overridePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filename, path: builtInPath, source: "built-in" };
    }
    throw new Error(`Could not inspect prompt override ${filename}.`, {
      cause: error,
    });
  }

  const resolvedOverridePath = await requireReadableRegularFile(
    overridePath,
    `Prompt override ${filename}`
  );
  if (!isWithinDirectory(projectRoot, resolvedOverridePath)) {
    throw new Error(
      `Prompt override ${filename} resolves outside the active Git worktree: ${resolvedOverridePath}.`
    );
  }

  const [builtInContents, overrideContents] = await Promise.all([
    readFile(builtInPath, "utf8"),
    readFile(resolvedOverridePath, "utf8"),
  ]);
  const missingElements = extractPromptContract(builtInContents).filter(
    (element) => !overrideContents.includes(element.value)
  );
  if (missingElements.length > 0) {
    throw new Error(
      `Prompt override ${filename} is incompatible with Sandcastle workflow version ${workflowVersion}. Missing contract elements: ${missingElements.map((element) => element.description).join("; ")}.`
    );
  }

  return {
    filename,
    path: resolvedOverridePath,
    source: "project override",
  };
}

export async function resolvePromptFiles(options: {
  projectRoot: string;
  workflowRoot: string;
  workflowVersion: string;
}): Promise<{
  get: (filename: PromptFilename) => string;
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
  const paths = new Map(
    selections.map((selection) => [selection.filename, selection.path])
  );

  return {
    get(filename): string {
      const promptPath = paths.get(filename);
      if (promptPath === undefined) {
        throw new Error(`No prompt selection exists for ${filename}.`);
      }
      return promptPath;
    },
    selections,
  };
}
