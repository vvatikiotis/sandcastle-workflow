import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getErrorCode } from "./error-code.ts";

const agentProviders = ["codex", "claude-code"] as const;

export type AgentProvider = (typeof agentProviders)[number];

const claudeCodeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;

type ClaudeCodeEffort = (typeof claudeCodeEfforts)[number];

export type AgentRoleConfig =
  | { agent: "codex"; model: string; effort: string }
  | { agent: "claude-code"; model: string; effort: ClaudeCodeEffort };

export type AgentConfig = {
  implementer: AgentRoleConfig;
  reviewer: AgentRoleConfig;
  reporter: AgentRoleConfig;
  finalSpecReviewer: AgentRoleConfig;
};

export type AgentEnvironment = {
  GH_TOKEN: string;
  // Absent when neither the file nor the host environment sets a value.
  CLAUDE_CODE_OAUTH_TOKEN?: string;
};

const agentEnvironmentKeys = ["GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

type AgentEnvironmentKey = (typeof agentEnvironmentKeys)[number];

function getRunnerConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".sandcastle", "sandcastle.env");
}

const roleKeyPrefixes = [
  "IMPLEMENTER",
  "REVIEWER",
  "REPORTER",
  "FINAL_SPEC_REVIEWER",
] as const;

const runnerConfigKeys = [
  "IMPLEMENTER_AGENT",
  "IMPLEMENTER_MODEL",
  "IMPLEMENTER_EFFORT",
  "REVIEWER_AGENT",
  "REVIEWER_MODEL",
  "REVIEWER_EFFORT",
  "REPORTER_AGENT",
  "REPORTER_MODEL",
  "REPORTER_EFFORT",
  "FINAL_SPEC_REVIEWER_AGENT",
  "FINAL_SPEC_REVIEWER_MODEL",
  "FINAL_SPEC_REVIEWER_EFFORT",
  "MAX_ITERATIONS",
] as const;
const optionalRunnerConfigKeys = ["DOCKER_IMAGE"] as const;

type RunnerConfigKey = (typeof runnerConfigKeys)[number];
type OptionalRunnerConfigKey = (typeof optionalRunnerConfigKeys)[number];

// loadRunnerConfig reports missing and empty keys with line-level context
// first; this schema then gives the parsed values their type.
const agentProviderSchema = z.enum(agentProviders);
const runnerConfigSchema = z.object({
  IMPLEMENTER_AGENT: agentProviderSchema,
  IMPLEMENTER_MODEL: z.string(),
  IMPLEMENTER_EFFORT: z.string(),
  REVIEWER_AGENT: agentProviderSchema,
  REVIEWER_MODEL: z.string(),
  REVIEWER_EFFORT: z.string(),
  REPORTER_AGENT: agentProviderSchema,
  REPORTER_MODEL: z.string(),
  REPORTER_EFFORT: z.string(),
  FINAL_SPEC_REVIEWER_AGENT: agentProviderSchema,
  FINAL_SPEC_REVIEWER_MODEL: z.string(),
  FINAL_SPEC_REVIEWER_EFFORT: z.string(),
  MAX_ITERATIONS: z.string(),
  DOCKER_IMAGE: z.string().optional(),
}) satisfies z.ZodType<
  Record<RunnerConfigKey, string> &
    Partial<Record<OptionalRunnerConfigKey, string>>
>;
type RunnerConfig = z.infer<typeof runnerConfigSchema>;

function isRunnerConfigEntryKey(
  key: string,
): key is RunnerConfigKey | OptionalRunnerConfigKey {
  return [...runnerConfigKeys, ...optionalRunnerConfigKeys].some(
    (candidate) => candidate === key,
  );
}

function isAgentProvider(value: string): value is AgentProvider {
  return agentProviders.some((provider) => provider === value);
}

function isClaudeCodeEffort(value: string): value is ClaudeCodeEffort {
  return claudeCodeEfforts.some((effort) => effort === value);
}

function isAgentEnvironmentKey(key: string): key is AgentEnvironmentKey {
  return agentEnvironmentKeys.some((candidate) => candidate === key);
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
  const lineNumbers = new Map<
    RunnerConfigKey | OptionalRunnerConfigKey,
    number
  >();

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

    if (key.endsWith("_AGENT") && !isAgentProvider(value)) {
      throw new Error(
        `${runnerConfigPath}:${lineNumber}: ${key} must be one of ${agentProviders.join(", ")}.`,
      );
    }

    values.set(key, value);
    lineNumbers.set(key, lineNumber);
  }

  const missingKeys = runnerConfigKeys.filter((key) => !values.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `${runnerConfigPath} is missing required configuration: ${missingKeys.join(", ")}.`,
    );
  }

  // Codex effort stays unchecked so that new model/effort pairs need no
  // runner release; Sandcastle types Claude Code effort as a closed set.
  for (const prefix of roleKeyPrefixes) {
    const agentKey = `${prefix}_AGENT` as const;
    const effortKey = `${prefix}_EFFORT` as const;
    if (
      values.get(agentKey) === "claude-code" &&
      !isClaudeCodeEffort(values.get(effortKey) ?? "")
    ) {
      throw new Error(
        `${runnerConfigPath}:${lineNumbers.get(effortKey)}: ${effortKey} must be one of ${claudeCodeEfforts.join(", ")} when ${agentKey} is claude-code.`,
      );
    }
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

function createRoleConfig(
  agent: AgentProvider,
  model: string,
  effort: string,
): AgentRoleConfig {
  if (agent === "codex") {
    return { agent, model, effort };
  }
  // loadRunnerConfig has already rejected this with the file and line.
  if (!isClaudeCodeEffort(effort)) {
    throw new Error(
      `Claude Code effort must be one of ${claudeCodeEfforts.join(", ")}.`,
    );
  }
  return { agent, model, effort };
}

export function getAgentConfig(runnerConfig: RunnerConfig): AgentConfig {
  return {
    implementer: createRoleConfig(
      runnerConfig.IMPLEMENTER_AGENT,
      runnerConfig.IMPLEMENTER_MODEL,
      runnerConfig.IMPLEMENTER_EFFORT,
    ),
    reviewer: createRoleConfig(
      runnerConfig.REVIEWER_AGENT,
      runnerConfig.REVIEWER_MODEL,
      runnerConfig.REVIEWER_EFFORT,
    ),
    reporter: createRoleConfig(
      runnerConfig.REPORTER_AGENT,
      runnerConfig.REPORTER_MODEL,
      runnerConfig.REPORTER_EFFORT,
    ),
    finalSpecReviewer: createRoleConfig(
      runnerConfig.FINAL_SPEC_REVIEWER_AGENT,
      runnerConfig.FINAL_SPEC_REVIEWER_MODEL,
      runnerConfig.FINAL_SPEC_REVIEWER_EFFORT,
    ),
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

  const values = new Map<AgentEnvironmentKey, string>();
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
    if (!isAgentEnvironmentKey(key)) {
      throw new Error(
        `${agentEnvironmentPath}:${lineNumber}: unsupported agent environment key ${key}. Only ${agentEnvironmentKeys.join(" and ")} are supported; remove ${key} before running Sandcastle.`,
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

  const ghToken = resolveCredential(values, "GH_TOKEN");
  if (ghToken === undefined) {
    throw new Error(
      `${agentEnvironmentPath} declares GH_TOKEN, but no usable credential was provided in the file or host environment.`,
    );
  }
  // Optional: Claude Code can log in from ~/.claude instead.
  const claudeCodeOAuthToken = resolveCredential(
    values,
    "CLAUDE_CODE_OAUTH_TOKEN",
  );
  return claudeCodeOAuthToken === undefined
    ? { GH_TOKEN: ghToken }
    : { GH_TOKEN: ghToken, CLAUDE_CODE_OAUTH_TOKEN: claudeCodeOAuthToken };
}

// A non-blank value in .sandcastle/.env wins; otherwise a non-blank host value.
function resolveCredential(
  fileValues: ReadonlyMap<AgentEnvironmentKey, string>,
  key: AgentEnvironmentKey,
): string | undefined {
  const fileValue = fileValues.get(key) ?? "";
  if (fileValue.trim() !== "") {
    return fileValue;
  }
  const hostValue = process.env[key] ?? "";
  return hostValue.trim() === "" ? undefined : hostValue;
}
