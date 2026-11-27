import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getErrorCode } from "./error-code.ts";

export type AgentRoleConfig = { model: string; effort: string };

export type AgentConfig = {
  implementer: AgentRoleConfig;
  reviewer: AgentRoleConfig;
  reporter: AgentRoleConfig;
  finalSpecReviewer: AgentRoleConfig;
};

export type AgentEnvironment = { GH_TOKEN: string };

function getRunnerConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".sandcastle", "sandcastle.env");
}

const runnerConfigKeys = [
  "IMPLEMENTER_MODEL",
  "IMPLEMENTER_EFFORT",
  "REVIEWER_MODEL",
  "REVIEWER_EFFORT",
  "REPORTER_MODEL",
  "REPORTER_EFFORT",
  "FINAL_SPEC_REVIEWER_MODEL",
  "FINAL_SPEC_REVIEWER_EFFORT",
  "MAX_ITERATIONS",
] as const;
const optionalRunnerConfigKeys = ["DOCKER_IMAGE"] as const;

type RunnerConfigKey = (typeof runnerConfigKeys)[number];
type OptionalRunnerConfigKey = (typeof optionalRunnerConfigKeys)[number];

// loadRunnerConfig reports missing and empty keys with line-level context
// first; this schema then gives the parsed values their type.
const runnerConfigSchema = z.object({
  IMPLEMENTER_MODEL: z.string(),
  IMPLEMENTER_EFFORT: z.string(),
  REVIEWER_MODEL: z.string(),
  REVIEWER_EFFORT: z.string(),
  REPORTER_MODEL: z.string(),
  REPORTER_EFFORT: z.string(),
  FINAL_SPEC_REVIEWER_MODEL: z.string(),
  FINAL_SPEC_REVIEWER_EFFORT: z.string(),
  MAX_ITERATIONS: z.string(),
  DOCKER_IMAGE: z.string().optional(),
}) satisfies z.ZodType<
  Record<RunnerConfigKey, string> &
    Partial<Record<OptionalRunnerConfigKey, string>>
>;
export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

function isRunnerConfigEntryKey(
  key: string,
): key is RunnerConfigKey | OptionalRunnerConfigKey {
  return [...runnerConfigKeys, ...optionalRunnerConfigKeys].some(
    (candidate) => candidate === key,
  );
}

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

export async function loadRunnerConfig(
  projectRoot: string,
): Promise<RunnerConfig> {
  const runnerConfigPath = getRunnerConfigPath(projectRoot);
  let contents: string;

  try {
    contents = await readFile(runnerConfigPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(
        `${runnerConfigPath} is required. Run "sandcastle-workflow init", then copy .sandcastle/sandcastle.env.example to .sandcastle/sandcastle.env and choose every runner value.`,
      );
    }
    throw error;
  }

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
    if (!isRunnerConfigEntryKey(key)) {
      throw new Error(
        `${runnerConfigPath}:${lineNumber}: unknown configuration key ${key}.`,
      );
    }

    if (values.has(key)) {
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

    values.set(key, value);
  }

  const missingKeys = runnerConfigKeys.filter((key) => !values.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `${runnerConfigPath} is missing required configuration: ${missingKeys.join(", ")}.`,
    );
  }

  return runnerConfigSchema.parse(Object.fromEntries(values));
}

export function requireMaxIterations(
  projectRoot: string,
  runnerConfig: RunnerConfig,
): number {
  const runnerConfigPath = getRunnerConfigPath(projectRoot);
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

  return maxIterations;
}

export function getAgentConfig(runnerConfig: RunnerConfig): AgentConfig {
  return {
    implementer: {
      model: runnerConfig.IMPLEMENTER_MODEL,
      effort: runnerConfig.IMPLEMENTER_EFFORT,
    },
    reviewer: {
      model: runnerConfig.REVIEWER_MODEL,
      effort: runnerConfig.REVIEWER_EFFORT,
    },
    reporter: {
      model: runnerConfig.REPORTER_MODEL,
      effort: runnerConfig.REPORTER_EFFORT,
    },
    finalSpecReviewer: {
      model: runnerConfig.FINAL_SPEC_REVIEWER_MODEL,
      effort: runnerConfig.FINAL_SPEC_REVIEWER_EFFORT,
    },
  };
}

export async function loadAgentEnvironment(
  projectRoot: string,
): Promise<AgentEnvironment> {
  const agentEnvironmentPath = path.join(projectRoot, ".sandcastle", ".env");
  let contents: string;

  try {
    contents = await readFile(agentEnvironmentPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
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
  return { GH_TOKEN: ghToken };
}
