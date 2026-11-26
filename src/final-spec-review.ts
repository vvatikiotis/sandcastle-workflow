import {
  reportPhaseFailure,
  type AgentPhaseResult,
} from "./phase-diagnostics.ts";
import type { RunEndStatus } from "./run-completion.ts";
import type { RunContext } from "./run-context.ts";

type FinalSpecOutcome = "closed" | "open" | "not-ready" | "stopped";

async function runFinalSpecReviewerPhase(
  { agentConfig, promptFiles, git, runtime }: RunContext,
  specIssueId: string,
): Promise<AgentPhaseResult<FinalSpecOutcome> & { logPath: string }> {
  await runtime.requireDockerImage();
  const branch = await git.getCheckedOutBranch();
  const logPath = await runtime.createLogPath(
    `spec-${specIssueId}-final-review`,
    "final-spec-reviewer",
  );

  const result = await runtime.runAgent<FinalSpecOutcome>({
    agentType: "final-spec-reviewer",
    roleConfig: agentConfig.finalSpecReviewer,
    branch,
    phase: "Final spec reviewer",
    context: `spec #${specIssueId}`,
    logPath,
    allowedOutcomes: ["closed", "open", "not-ready", "stopped"],
    promptFile: promptFiles.get("final-spec-prompt.md"),
    promptArgs: {
      PROJECT_GUIDANCE: promptFiles.getGuidance("final-spec-prompt.md"),
      SPEC_ISSUE_ID: specIssueId,
    },
    sandbox: {
      kind: "head",
      nodeModulesPath: "node_modules",
      hooks: "dependencies",
    },
  });

  return { ...result, logPath };
}

// Runs the Final Spec Reviewer once every Child Issue is closed. The agent
// closes the Specification; the runner checks that GitHub agrees with the
// reported outcome.
export async function runFinalSpecReview(
  context: RunContext,
  specIssueId: string,
): Promise<RunEndStatus> {
  const finalSpecReview = await runFinalSpecReviewerPhase(context, specIssueId);
  const finalSpecOutcome = finalSpecReview.outcome;
  const finalSpecFailureReason =
    finalSpecOutcome === "closed"
      ? undefined
      : reportPhaseFailure({
          phase: `Final spec reviewer for spec #${specIssueId}`,
          outcome: finalSpecOutcome,
          detail: finalSpecReview.detail,
          logPath: finalSpecReview.logPath,
        });

  const specIssueClosed = await context.controlPlane.isIssueClosed(specIssueId);

  if (finalSpecOutcome === "closed" && !specIssueClosed) {
    throw new Error(
      `Final reviewer reported closure, but spec issue #${specIssueId} remains open.`,
    );
  }

  if (finalSpecOutcome !== "closed" && specIssueClosed) {
    throw new Error(
      `Final reviewer reported ${finalSpecOutcome}, but spec issue #${specIssueId} is closed.`,
    );
  }

  if (finalSpecFailureReason !== undefined) {
    return { kind: "stopped", reason: finalSpecFailureReason };
  }

  console.log(`Final spec review outcome: ${finalSpecOutcome}.`);
  return {
    kind: "completed",
    reason: `Spec #${specIssueId} passed final review and closed.`,
  };
}
