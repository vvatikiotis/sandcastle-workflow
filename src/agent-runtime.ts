import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import chalk from "chalk";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatAgentStartMessage } from "./agent-run-status.ts";
import { requirePrivateDirectory } from "./file-resolution.ts";
import {
  closeSandboxWithNodeModulesOverlay,
  createNodeModulesOverlay,
  removeNodeModulesOverlay,
  withNodeModulesOverlay,
  type NodeModulesOverlay,
} from "./node-modules-overlay.ts";
import { runAgentPhase, type AgentPhaseResult } from "./phase-diagnostics.ts";
import type { Exec } from "./run-context.ts";
import type { AgentEnvironment, AgentRoleConfig } from "./runner-config.ts";

// The Implementer and Reviewer share one sandbox on the issue branch.
export type IssueSandbox = Awaited<ReturnType<typeof sandcastle.createSandbox>>;

type SandcastleCodexEffort = NonNullable<
  Parameters<typeof sandcastle.codex>[1]
>["effort"];

// Where an agent runs: in the shared issue sandbox, or in a fresh sandbox on
// the checked-out base branch. "dependencies" installs packages first;
// "auth-only" only copies the Codex credentials in.
export type AgentSandbox =
  | { kind: "issue"; sandbox: IssueSandbox }
  | {
      kind: "head";
      nodeModulesPath: string;
      hooks: "dependencies" | "auth-only";
    };

export type AgentRun<T extends string> = {
  // Names the run in its start announcement, for example "implementer".
  agentType: string;
  roleConfig: AgentRoleConfig;
  // The branch named in the start announcement.
  branch: string;
  phase: string;
  context: string;
  logPath: string;
  allowedOutcomes: readonly T[];
  promptFile: string;
  promptArgs: Record<string, string>;
  sandbox: AgentSandbox;
};

export type IssueSandboxResult<T> = {
  value: T;
  // Set when Sandcastle kept a dirty issue worktree instead of removing it.
  preservedWorktreePath: string | undefined;
};

export type AgentRuntime = {
  nodeModulesOverlayRoot: string;
  // Throws with build instructions when the configured image is missing.
  requireDockerImage: () => Promise<void>;
  createLogPath: (scope: string, agentType: string) => Promise<string>;
  // Announces and runs one agent phase, then parses its phase outcome.
  runAgent: <T extends string>(run: AgentRun<T>) => Promise<AgentPhaseResult<T>>;
  // Creates the shared issue sandbox, runs the operation in it, and closes it
  // together with its node_modules overlay even when the operation fails.
  withIssueSandbox: <T>(
    branch: string,
    operation: (sandbox: IssueSandbox) => Promise<T>,
  ) => Promise<IssueSandboxResult<T>>;
};

export function createAgentRuntime({
  projectRoot,
  execFile,
  dockerImageName,
  installCommand,
  agentEnvironment,
}: {
  projectRoot: string;
  execFile: Exec;
  dockerImageName: string;
  installCommand: readonly string[];
  // Empty for a dry run, which never launches agents.
  agentEnvironment: Partial<AgentEnvironment>;
}): AgentRuntime {
  // https://www.eddyvinck.com/blog/how-to-set-up-sandcastle-with-codex/
  const hostCodexHome = path.join(os.homedir(), ".codex");
  const sandboxCodexMount = "/mnt/host-codex";
  const sandboxCodexHome = "/home/agent/.codex";

  // Sandboxes need the host Codex credentials, but must not mutate them.
  const authHook = {
    command: [
      `mkdir -p "${sandboxCodexHome}"`,
      `test -f "${sandboxCodexMount}/auth.json"`,
      `cp "${sandboxCodexMount}/auth.json" "${sandboxCodexHome}/auth.json"`,
      `if [ -f "${sandboxCodexMount}/config.toml" ]; then cp "${sandboxCodexMount}/config.toml" "${sandboxCodexHome}/config.toml"; fi`,
    ].join(" && "),
  };

  // Hooks run inside the sandbox before the agent starts each iteration.
  const dependencyHooks = {
    sandbox: {
      onSandboxReady: [authHook, { command: installCommand.join(" ") }],
    },
  };

  const authOnlyHooks = {
    sandbox: {
      onSandboxReady: [authHook],
    },
  };

  const mounts = [
    {
      hostPath: hostCodexHome,
      sandboxPath: sandboxCodexMount,
      readonly: true,
    },
  ];
  const nodeModulesOverlayRoot = path.join(
    projectRoot,
    ".sandcastle",
    "node-modules-overlays",
  );

  const env = {
    ...agentEnvironment,
    CODEX_HOME: sandboxCodexHome,
    CI: "true",
    PNPM_CONFIG_CONFIRM_MODULES_PURGE: "false",
  };

  function createDockerSandbox(overlay: NodeModulesOverlay) {
    return docker({
      imageName: dockerImageName,
      env,
      mounts: [...mounts, overlay.mount],
    });
  }

  let dockerImageAvailable = false;

  async function requireDockerImage(): Promise<void> {
    if (dockerImageAvailable) {
      return;
    }

    try {
      await execFile("docker", ["image", "inspect", dockerImageName]);
    } catch (error) {
      throw new Error(
        `Docker image '${dockerImageName}' is not available. Build it explicitly with "sandcastle-workflow build-image", then rerun the workflow.`,
        { cause: error },
      );
    }

    dockerImageAvailable = true;
  }

  function createConfiguredAgent(
    config: AgentRoleConfig,
  ): ReturnType<typeof sandcastle.codex> {
    // Sandcastle forwards effort to Codex at runtime, but its type lists only
    // currently known values. Let the provider validate future model/effort pairs.
    return sandcastle.codex(config.model, {
      effort: config.effort as SandcastleCodexEffort,
    });
  }

  let announcedAgentCount = 0;

  function announceAgentStart(runName: string, branch: string): void {
    const prefix = announcedAgentCount === 0 ? "" : "\n";
    announcedAgentCount += 1;
    console.log(
      `${prefix}${formatAgentStartMessage(runName, branch, new Date())}`,
    );
  }

  function formatTimestamp(date: Date): string {
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const pad3 = (n: number) => String(n).padStart(3, "0");

    return (
      [date.getFullYear(), pad2(date.getMonth() + 1), pad2(date.getDate())].join(
        "",
      ) +
      `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-${pad3(date.getMilliseconds())}`
    );
  }

  async function createLogPath(
    scope: string,
    agentType: string,
  ): Promise<string> {
    const logDirectory = path.join(projectRoot, ".sandcastle", "logs");
    await requirePrivateDirectory(logDirectory);
    const logPath = path.join(
      logDirectory,
      `sandcastle-${scope}-${agentType}-${formatTimestamp(new Date())}-${process.pid}.log`,
    );
    const handle = await open(logPath, "wx", 0o600);
    await handle.close();
    return logPath;
  }

  async function runAgent<T extends string>(
    run: AgentRun<T>,
  ): Promise<AgentPhaseResult<T>> {
    const runName = chalk.blue(
      `${run.agentType}: ${run.roleConfig.model}, ${run.roleConfig.effort}`,
    );
    announceAgentStart(runName, run.branch);
    const logging = { type: "file", path: run.logPath, verbose: true } as const;
    const { sandbox } = run;

    return runAgentPhase<T>({
      phase: run.phase,
      context: run.context,
      logPath: run.logPath,
      allowedOutcomes: run.allowedOutcomes,
      run: () => {
        if (sandbox.kind === "issue") {
          return sandbox.sandbox.run({
            name: runName,
            maxIterations: 1,
            agent: createConfiguredAgent(run.roleConfig),
            promptFile: run.promptFile,
            promptArgs: run.promptArgs,
            logging,
          });
        }
        return withNodeModulesOverlay(
          {
            rootDirectory: nodeModulesOverlayRoot,
            sandboxPath: sandbox.nodeModulesPath,
          },
          (overlay) =>
            sandcastle.run({
              name: runName,
              cwd: projectRoot,
              maxIterations: 1,
              agent: createConfiguredAgent(run.roleConfig),
              sandbox: createDockerSandbox(overlay),
              hooks:
                sandbox.hooks === "dependencies"
                  ? dependencyHooks
                  : authOnlyHooks,
              branchStrategy: { type: "head" },
              promptFile: run.promptFile,
              promptArgs: run.promptArgs,
              logging,
            }),
        );
      },
    });
  }

  // Closes the issue sandbox, or only removes its overlay when sandbox creation
  // failed. A close failure after a failed sandbox operation keeps both errors.
  async function closeIssueSandbox(
    sandbox: IssueSandbox | undefined,
    overlay: NodeModulesOverlay,
    sandboxOperationError: unknown,
  ): Promise<string | undefined> {
    try {
      if (sandbox === undefined) {
        await removeNodeModulesOverlay(overlay);
        return undefined;
      }
      const closeResult = await closeSandboxWithNodeModulesOverlay(
        sandbox,
        overlay,
      );
      return closeResult.preservedWorktreePath;
    } catch (error) {
      if (sandboxOperationError !== undefined) {
        throw new AggregateError(
          [sandboxOperationError, error],
          "Sandbox operation and closure both failed.",
        );
      }
      throw error;
    }
  }

  async function withIssueSandbox<T>(
    branch: string,
    operation: (sandbox: IssueSandbox) => Promise<T>,
  ): Promise<IssueSandboxResult<T>> {
    const overlay = await createNodeModulesOverlay({
      rootDirectory: nodeModulesOverlayRoot,
      sandboxPath: "node_modules",
    });
    let sandbox: IssueSandbox | undefined;
    let value: T;

    try {
      sandbox = await sandcastle.createSandbox({
        branch,
        cwd: projectRoot,
        sandbox: createDockerSandbox(overlay),
        hooks: dependencyHooks,
      });
      value = await operation(sandbox);
    } catch (error) {
      await closeIssueSandbox(sandbox, overlay, error);
      throw error;
    }

    const preservedWorktreePath = await closeIssueSandbox(
      sandbox,
      overlay,
      undefined,
    );
    return { value, preservedWorktreePath };
  }

  return {
    nodeModulesOverlayRoot,
    requireDockerImage,
    createLogPath,
    runAgent,
    withIssueSandbox,
  };
}
