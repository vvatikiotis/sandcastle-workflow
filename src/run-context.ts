import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { AgentRuntime } from "./agent-runtime.ts";
import type { ControlPlane } from "./control-plane.ts";
import type { GitState } from "./git-state.ts";
import type { VerificationCommands } from "./integration.ts";
import type { PromptFiles } from "./prompt-resolution.ts";
import type { AgentConfig } from "./runner-config.ts";

type ExecResult = { stdout: string; stderr: string };

// Runs a command in the Consumer Repository root and resolves with its output.
export type Exec = (file: string, args: readonly string[]) => Promise<ExecResult>;

const rawExecFile = promisify(execFileCallback);

export function createProjectExec(projectRoot: string): Exec {
  return (file, args) =>
    rawExecFile(file, [...args], { cwd: projectRoot, encoding: "utf8" });
}

// Variables gh reads a token from. The runner's GitHub calls must use only
// the GH_TOKEN from .sandcastle/.env, so host values are removed.
const hostGitHubTokenKeys = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

// Like createProjectExec, but every command sees ghToken as GH_TOKEN and no
// token from the host environment.
export function createGitHubExec(projectRoot: string, ghToken: string): Exec {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of hostGitHubTokenKeys) {
    delete env[key];
  }
  env.GH_TOKEN = ghToken;
  return (file, args) =>
    rawExecFile(file, [...args], { cwd: projectRoot, encoding: "utf8", env });
}

// Everything a workflow run needs once preflight has passed. The runner
// builds it once; workflow modules receive it instead of reading globals.
export type RunContext = {
  projectRoot: string;
  agentConfig: AgentConfig;
  promptFiles: PromptFiles;
  // Integration runs these on the rebased issue branch; agent prompts name
  // them as INSTALL_COMMAND, TYPECHECK_COMMAND, and TEST_COMMAND.
  verificationCommands: VerificationCommands;
  git: GitState;
  controlPlane: ControlPlane;
  runtime: AgentRuntime;
};
