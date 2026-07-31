import type { RunEndStatus } from "./run-completion.ts";

export class InvalidIssueGraphError extends Error {}

export function classifyPlanningError(
  error: unknown
): RunEndStatus | undefined {
  return error instanceof InvalidIssueGraphError
    ? {
        kind: "stopped",
        reason: "GitHub native sub-issue validation failed.",
      }
    : undefined;
}

export function getNoStandaloneIssuesStatus({
  skippedStaleSelection,
  standalonePathSelected,
}: {
  skippedStaleSelection: boolean;
  standalonePathSelected: boolean;
}): RunEndStatus {
  if (skippedStaleSelection) {
    return {
      kind: "stopped",
      reason:
        "No eligible standalone issues remained after stale selections were replanned.",
    };
  }

  return {
    kind: "completed",
    reason: standalonePathSelected
      ? "No open ready-for-agent standalone issues were found."
      : "No open ready-for-agent issues were found.",
  };
}
