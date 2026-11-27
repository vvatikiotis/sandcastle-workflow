import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import { getErrorCode } from "./error-code.ts";
import type {
  AgentConfig,
  AgentEnvironment,
  AgentProvider,
} from "./runner-config.ts";

// How the sandbox gets the host's login for one agent the config uses.
export type AgentLogin =
  | { agent: "codex"; codexHome: string }
  | { agent: "claude-code"; method: "oauth-token"; token: string }
  | { agent: "claude-code"; method: "credentials-file"; claudeHome: string };

const agentNames: Record<AgentProvider, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

const agentCommands: Record<AgentProvider, string> = {
  codex: "codex",
  "claude-code": "claude",
};

const loginInstructions: Record<AgentProvider, string> = {
  codex: "Run `codex login` on the host so that ~/.codex/auth.json exists.",
  "claude-code":
    "Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in .sandcastle/.env (the host environment is ignored); on macOS, where Claude Code keeps its login in the Keychain, this is the only way. On Linux, logging in with `claude` so that ~/.claude/.credentials.json exists also works.",
};

const roles: readonly { key: keyof AgentConfig; name: string }[] = [
  { key: "implementer", name: "Implementer" },
  { key: "reviewer", name: "Reviewer" },
  { key: "reporter", name: "Reporter" },
  { key: "finalSpecReviewer", name: "Final Spec Reviewer" },
];

function getRolesByAgent(
  agentConfig: AgentConfig,
): Map<AgentProvider, string[]> {
  const rolesByAgent = new Map<AgentProvider, string[]>();
  for (const role of roles) {
    const { agent } = agentConfig[role.key];
    rolesByAgent.set(agent, [...(rolesByAgent.get(agent) ?? []), role.name]);
  }
  return rolesByAgent;
}

async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      return false;
    }
    await access(filePath, constants.R_OK);
    return true;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
      return false;
    }
    throw new Error(`Could not inspect agent login file ${filePath}.`, {
      cause: error,
    });
  }
}

type LoginResolution =
  | { kind: "found"; login: AgentLogin }
  | { kind: "missing"; reason: string };

async function resolveCodexLogin(
  homeDirectory: string,
): Promise<LoginResolution> {
  const codexHome = path.join(homeDirectory, ".codex");
  const authPath = path.join(codexHome, "auth.json");
  return (await isReadableFile(authPath))
    ? { kind: "found", login: { agent: "codex", codexHome } }
    : { kind: "missing", reason: `${authPath} is not a readable file` };
}

async function resolveClaudeCodeLogin(
  homeDirectory: string,
  agentEnvironment: AgentEnvironment,
): Promise<LoginResolution> {
  const token = agentEnvironment.CLAUDE_CODE_OAUTH_TOKEN;
  if (token !== undefined) {
    return {
      kind: "found",
      login: { agent: "claude-code", method: "oauth-token", token },
    };
  }
  const claudeHome = path.join(homeDirectory, ".claude");
  const credentialsPath = path.join(claudeHome, ".credentials.json");
  return (await isReadableFile(credentialsPath))
    ? {
        kind: "found",
        login: { agent: "claude-code", method: "credentials-file", claudeHome },
      }
    : {
        kind: "missing",
        reason: `CLAUDE_CODE_OAUTH_TOKEN is not set in .sandcastle/.env, and ${credentialsPath} is not a readable file`,
      };
}

// Finds a login for every agent the config uses, so a missing login stops the
// run before any sandbox starts. Agents the config does not use are skipped.
export async function resolveAgentLogins({
  agentConfig,
  agentEnvironment,
  homeDirectory,
}: {
  agentConfig: AgentConfig;
  agentEnvironment: AgentEnvironment;
  homeDirectory: string;
}): Promise<readonly AgentLogin[]> {
  const logins: AgentLogin[] = [];
  const problems: string[] = [];
  const roleList = new Intl.ListFormat("en", { type: "conjunction" });

  for (const [agent, agentRoles] of getRolesByAgent(agentConfig)) {
    const resolution =
      agent === "codex"
        ? await resolveCodexLogin(homeDirectory)
        : await resolveClaudeCodeLogin(homeDirectory, agentEnvironment);
    if (resolution.kind === "found") {
      logins.push(resolution.login);
    } else {
      problems.push(
        `${agentNames[agent]} (${agent}) has no login for the ${roleList.format(agentRoles)}: ${resolution.reason}. ${loginInstructions[agent]}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
  return logins;
}

// Explains an agent that failed inside the sandbox, for example because its
// command is missing from the Docker image or its login expired.
export function formatAgentFailure({
  role,
  agent,
  cause,
}: {
  role: string;
  agent: AgentProvider;
  cause: string;
}): string {
  return `The ${role} could not run ${agentNames[agent]} (${agent}). Check that the Docker image provides the \`${agentCommands[agent]}\` command and that its login is still valid. ${loginInstructions[agent]} Cause: ${cause.trim()}`;
}
