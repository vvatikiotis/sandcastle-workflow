import type { RunEndStatus } from "./run-completion.ts";
import type { BlockedStandaloneIssue } from "./spec-selection.ts";

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

export function formatBlockedStandaloneIssue({
  issue,
  openBlockerIds,
}: BlockedStandaloneIssue): string {
  return `#${issue.id} ${issue.title} is waiting on open blockers: ${openBlockerIds.map((id) => `#${id}`).join(", ")}`;
}

export function getNoStandaloneIssuesStatus({
  blockedIssues,
  skippedStaleSelection,
  standalonePathSelected,
}: {
  blockedIssues: readonly BlockedStandaloneIssue[];
  skippedStaleSelection: boolean;
  standalonePathSelected: boolean;
}): RunEndStatus {
  if (blockedIssues.length > 0) {
    return {
      kind: "stopped",
      reason: `Every remaining standalone issue is waiting on open blockers. ${blockedIssues.map(formatBlockedStandaloneIssue).join("; ")}.`,
    };
  }

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
