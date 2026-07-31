import { formatDiagnostic } from "./run-completion.ts";

export type PhaseFailure = {
  phase: string;
  outcome: string;
  detail?: string;
  logPath: string;
};

export type AgentPhaseResult<T extends string> = {
  outcome: T;
  detail?: string;
};

export function formatPhaseFailure({
  phase,
  outcome,
  detail,
  logPath,
}: PhaseFailure): string {
  const reason = detail?.trim() || "No phase detail was provided.";
  return `${phase} outcome: ${outcome}. Reason: ${reason} Log: ${logPath}`;
}

export function reportPhaseFailure(failure: PhaseFailure): string {
  const message = formatPhaseFailure(failure);
  console.warn(message);
  return message;
}

export function formatPhaseExecutionError({
  phase,
  context,
  detail,
  logPath,
  error,
}: {
  phase: string;
  context: string;
  detail?: string;
  logPath: string;
  error: unknown;
}): string {
  const diagnostic =
    error instanceof Error ? error.message : formatDiagnostic(error);
  const agentDetail = detail?.trim() ? `Agent detail: ${detail.trim()} ` : "";
  return `${phase} for ${context} did not produce a valid phase outcome. ${agentDetail}${diagnostic} Log: ${logPath}`;
}

function parsePhaseDetail(stdout: string): string | undefined {
  return [...stdout.matchAll(/<phase-detail>([^<]+)<\/phase-detail>/g)]
    .at(-1)?.[1]
    ?.trim();
}

function parsePhaseOutcome<T extends string>(
  stdout: string,
  allowedOutcomes: readonly T[]
): T {
  const matches = [
    ...stdout.matchAll(/<phase-outcome>([^<]+)<\/phase-outcome>/g),
  ];
  const outcome = matches.at(-1)?.[1]?.trim();

  if (!outcome || !allowedOutcomes.includes(outcome as T)) {
    throw new Error(
      `Agent did not provide a valid phase outcome. Expected one of: ${allowedOutcomes.join(", ")}.`
    );
  }

  return outcome as T;
}

export async function runAgentPhase<T extends string>({
  phase,
  context,
  logPath,
  allowedOutcomes,
  run,
}: {
  phase: string;
  context: string;
  logPath: string;
  allowedOutcomes: readonly T[];
  run: () => Promise<{ stdout: string }>;
}): Promise<AgentPhaseResult<T>> {
  let detail: string | undefined;
  try {
    const result = await run();
    detail = parsePhaseDetail(result.stdout);
    return {
      outcome: parsePhaseOutcome(result.stdout, allowedOutcomes),
      detail,
    };
  } catch (error) {
    const phaseError = new Error(
      formatPhaseExecutionError({ phase, context, detail, logPath, error }),
      { cause: error }
    );
    if (error instanceof Error && error.stack) {
      phaseError.stack = `${phaseError.stack}\nCaused by: ${error.stack}`;
    }
    throw phaseError;
  }
}
