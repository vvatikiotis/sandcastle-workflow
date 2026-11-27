import {
  reportPhaseFailure,
  type AgentPhaseResult,
} from "./phase-diagnostics.ts";
import { formatRefChanges, snapshotGuardedRefs } from "./ref-guard.ts";
import type { RunEndStatus } from "./run-completion.ts";
import type { RunContext } from "./run-context.ts";

type FinalSpecOutcome = "closed" | "open" | "not-ready" | "stopped";

type FinalSpecReviewerRun =
  | {
      kind: "reviewed";
      result: AgentPhaseResult<FinalSpecOutcome>;
      logPath: string;
    }
  | { kind: "aborted"; reason: string };

// Runs the Final Spec Reviewer in its own sandbox on a temporary branch at the
// Base Branch commit, so it never mounts the main checkout. Any commit or
// guarded-ref change it makes aborts the run; no commit reaches the base.
async function runFinalSpecReviewerPhase(
  { agentConfig, promptFiles, git, runtime }: RunContext,
  specIssueId: string,
): Promise<FinalSpecReviewerRun> {
  await runtime.requireDockerImage();
  const base = await git.getBaseSnapshot();
  const branch = `sandcastle/final-spec-${specIssueId}`;
  const logPath = await runtime.createLogPath(
    `spec-${specIssueId}-final-review`,
    "final-spec-reviewer",
  );
  try {
    await git.createBranch(branch, base.commit);
  } catch (error) {
    throw new Error(
      `Could not create the temporary final-review branch ${branch} at ${base.commit}. If an earlier final review left it behind, inspect it, then delete it with "git branch -D ${branch}".`,
      { cause: error },
    );
  }
  const refGuard = await snapshotGuardedRefs(git, [branch]);

  const reviewInSandbox = () => runtime.withSandbox(branch, async (sandbox) => {
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
      sandbox,
    });
    return { result, refChanges: await refGuard.check() };
  });
  let sandboxResult: Awaited<ReturnType<typeof reviewInSandbox>>;
  try {
    sandboxResult = await reviewInSandbox();
  } catch (error) {
    // An unchanged temporary branch would only block the next final review.
    try {
      if ((await git.getBranchCommit(branch)) === base.commit) {
        await git.deleteBranch(branch);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `The final spec review failed, and its temporary branch ${branch} could not be deleted.`,
      );
    }
    throw error;
  }

  const { refChanges, result } = sandboxResult.value;
  if (refChanges.length > 0) {
    return {
      kind: "aborted",
      reason: formatRefChanges(`final spec reviewer phase for spec #${specIssueId}`, refChanges),
    };
  }
  const branchCommit = await git.getBranchCommit(branch);
  if (branchCommit !== base.commit) {
    return {
      kind: "aborted",
      reason: `ABORTING RUN: the final spec reviewer for spec #${specIssueId} committed on ${branch} (now ${branchCommit}). The commit did not reach ${base.branch}. Inspect the branch, then delete it with "git branch -D ${branch}". Log: ${logPath}`,
    };
  }
  if (sandboxResult.preservedWorktreePath !== undefined) {
    return {
      kind: "aborted",
      reason: `ABORTING RUN: the final spec reviewer for spec #${specIssueId} left uncommitted changes; Sandcastle preserved its worktree at ${sandboxResult.preservedWorktreePath}. Inspect it, remove it with "git worktree remove --force ${sandboxResult.preservedWorktreePath}", then delete ${branch} with "git branch -D ${branch}". Log: ${logPath}`,
    };
  }
  await git.deleteBranch(branch);

  return { kind: "reviewed", result, logPath };
}

// Runs the Final Spec Reviewer once every Child Issue is closed. The agent
// closes the Specification; the runner checks that GitHub agrees with the
// reported outcome.
export async function runFinalSpecReview(
  context: RunContext,
  specIssueId: string,
): Promise<RunEndStatus> {
  const finalSpecRun = await runFinalSpecReviewerPhase(context, specIssueId);
  if (finalSpecRun.kind === "aborted") {
    console.error(finalSpecRun.reason);
    process.exitCode = 1;
    return { kind: "aborted", reason: finalSpecRun.reason };
  }
  const { result: finalSpecReview, logPath } = finalSpecRun;
  const finalSpecOutcome = finalSpecReview.outcome;
  const finalSpecFailureReason =
    finalSpecOutcome === "closed"
      ? undefined
      : reportPhaseFailure({
          phase: `Final spec reviewer for spec #${specIssueId}`,
          outcome: finalSpecOutcome,
          detail: finalSpecReview.detail,
          logPath,
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
