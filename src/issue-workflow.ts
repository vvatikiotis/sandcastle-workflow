import chalk from "chalk";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import type { IssueSandbox } from "./agent-runtime.ts";
import type { BaseSnapshot } from "./git-state.ts";
import { reportPhaseFailure } from "./phase-diagnostics.ts";
import type { PromptFilename } from "./prompt-resolution.ts";
import { isReviewerCommitMessageForIssue } from "./recovery-routing.ts";
import { formatDiagnostic } from "./run-completion.ts";
import type { RunContext } from "./run-context.ts";
import type { ReadyIssue, SpecChild } from "./spec-selection.ts";
import { getVerificationWorktreePaths } from "./verification-worktree-paths.ts";

export type WorkPath = "spec" | "standalone";

type ImplementerOutcome = "implemented" | "needs-info" | "stopped";
type ReviewerOutcome = "approved" | "needs-info" | "stopped";
type MergerOutcome = "merged" | "needs-info" | "stopped";

// What differs between the two Work Paths. Every step and message of the
// issue workflow is otherwise shared.
export type WorkPathProfile = {
  // Names the issue in messages: "child issue" or "standalone issue".
  issueNoun: string;
  prompts: {
    implement: PromptFilename;
    review: PromptFilename;
    merge: PromptFilename;
  };
  // Added to every agent prompt, for example SPEC_ISSUE_ID for a Child Issue.
  promptArgs: Record<string, string>;
  // A reason when the issue lost Eligibility; checked before review and merge.
  getEligibilityError: (issueId: string) => Promise<string | undefined>;
};

export function createSpecPathProfile(
  { controlPlane }: RunContext,
  specIssueId: string,
): WorkPathProfile {
  return {
    issueNoun: "child issue",
    prompts: {
      implement: "implement-prompt.md",
      review: "review-prompt.md",
      merge: "merge-prompt.md",
    },
    promptArgs: { SPEC_ISSUE_ID: specIssueId },
    getEligibilityError: (issueId) =>
      controlPlane.getSelectedIssueEligibilityError(specIssueId, issueId),
  };
}

export function createStandalonePathProfile({
  controlPlane,
}: RunContext): WorkPathProfile {
  return {
    issueNoun: "standalone issue",
    prompts: {
      implement: "standalone-implement-prompt.md",
      review: "standalone-review-prompt.md",
      merge: "standalone-merge-prompt.md",
    },
    promptArgs: {},
    getEligibilityError: async (issueId) =>
      (await controlPlane.getStandaloneEligibilityError(issueId))?.detail,
  };
}

// "aborted" means a safety check failed and the run must exit with status 1.
export type IssueRunResult =
  | { outcome: "integrated" }
  | { outcome: "stopped" | "aborted"; reason: string };

type IssueStop = Exclude<IssueRunResult, { outcome: "integrated" }>;

type IssueRun = {
  context: RunContext;
  profile: WorkPathProfile;
  issueId: string;
  // "child issue #11" or "standalone issue #42".
  issueLabel: string;
  branch: string;
  base: BaseSnapshot;
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function promptArgsFor(
  run: IssueRun,
  promptFile: PromptFilename,
  args: Record<string, string>,
): Record<string, string> {
  return {
    ...run.context.verificationPromptArgs,
    ...args,
    ISSUE_ID: run.issueId,
    PROJECT_GUIDANCE: run.context.promptFiles.getGuidance(promptFile),
    ...run.profile.promptArgs,
  };
}

async function throwIfDockerfileChanged(
  role: "implementer" | "reviewer" | "merger",
  issueId: string,
  changedDockerfiles: readonly string[],
  logPath: string,
): Promise<void> {
  if (changedDockerfiles.length === 0) {
    return;
  }

  const message = `ABORTING RUN: ${role} for issue #${issueId} changed Dockerfile(s): ${changedDockerfiles.join(", ")}.`;
  await appendFile(
    logPath,
    `\n\n${"!".repeat(80)}\n${message}\n${"!".repeat(80)}\n`,
  );
  throw new Error(message);
}

async function shouldSkipReviewerAfterRerun(
  { context, branch, issueId }: IssueRun,
): Promise<boolean> {
  try {
    const commitSubject =
      await context.git.getBranchHeadCommitSubject(branch);
    return isReviewerCommitMessageForIssue(commitSubject, issueId);
  } catch (error) {
    console.warn(
      `WARNING: Could not inspect the latest commit on ${branch} for rerun routing. ${formatDiagnostic(error)}`,
    );
    return false;
  }
}

// A reused branch keeps its stale base; the merger, not the runner, rebases it.
async function reportReusedBranchBehindBase({
  context,
  branch,
  base,
}: IssueRun): Promise<void> {
  if (await context.git.isAncestorCommit(base.commit, branch)) {
    return;
  }

  console.log(
    `Info: ${branch} is behind ${base.branch} at ${base.commit}; the merger will rebase it onto ${base.branch}.`,
  );
}

async function stopIfIneligible(
  run: IssueRun,
  step: "review" | "merge",
): Promise<IssueStop | undefined> {
  const eligibilityError = await run.profile.getEligibilityError(run.issueId);
  if (eligibilityError === undefined) {
    return undefined;
  }

  console.warn(
    `WARNING: Skipping ${step} because ${run.issueLabel} is no longer eligible: ${eligibilityError}`,
  );
  return {
    outcome: "stopped",
    reason: `${capitalize(run.issueLabel)} lost eligibility before ${step}.`,
  };
}

async function runImplementer(
  run: IssueRun,
  sandbox: IssueSandbox,
  branchCommitBeforeImplementation: string,
): Promise<IssueStop | undefined> {
  const { context, profile, branch, issueId, issueLabel } = run;
  const logPath = await context.runtime.createLogPath(
    `issue-${issueId}`,
    "implementer",
  );
  const implement = await context.runtime.runAgent<ImplementerOutcome>({
    agentType: "implementer",
    roleConfig: context.agentConfig.implementer,
    branch,
    phase: "Implementer",
    context: issueLabel,
    logPath,
    allowedOutcomes: ["implemented", "needs-info", "stopped"],
    promptFile: context.promptFiles.get(profile.prompts.implement),
    promptArgs: promptArgsFor(run, profile.prompts.implement, {}),
    sandbox: { kind: "issue", sandbox },
  });

  const branchCommitAfterImplementation =
    await context.git.getBranchCommit(branch);
  await throwIfDockerfileChanged(
    "implementer",
    issueId,
    await context.git.getChangedDockerfiles(
      branchCommitBeforeImplementation,
      branchCommitAfterImplementation,
    ),
    logPath,
  );

  if (implement.outcome !== "implemented") {
    const reason = reportPhaseFailure({
      phase: `Implementer for ${issueLabel}`,
      outcome: implement.outcome,
      detail: implement.detail,
      logPath,
    });
    return { outcome: "stopped", reason };
  }

  if (branchCommitAfterImplementation === branchCommitBeforeImplementation) {
    throw new Error("Implementer reported success without creating a commit.");
  }

  console.log(chalk.green(`Implementation complete on branch: ${branch}`));
  return undefined;
}

async function runReviewer(
  run: IssueRun,
  sandbox: IssueSandbox,
): Promise<IssueStop | undefined> {
  const { context, profile, branch, issueId, issueLabel, base } = run;
  const logPath = await context.runtime.createLogPath(
    `issue-${issueId}`,
    "reviewer",
  );
  const branchCommitBeforeReview = await context.git.getBranchCommit(branch);
  const review = await context.runtime.runAgent<ReviewerOutcome>({
    agentType: "reviewer",
    roleConfig: context.agentConfig.reviewer,
    branch,
    phase: "Reviewer",
    context: issueLabel,
    logPath,
    allowedOutcomes: ["approved", "needs-info", "stopped"],
    promptFile: context.promptFiles.get(profile.prompts.review),
    promptArgs: promptArgsFor(run, profile.prompts.review, {
      BASE_COMMIT: base.commit,
      BRANCH: branch,
    }),
    sandbox: { kind: "issue", sandbox },
  });

  const branchCommitAfterReview = await context.git.getBranchCommit(branch);
  await throwIfDockerfileChanged(
    "reviewer",
    issueId,
    await context.git.getChangedDockerfiles(
      branchCommitBeforeReview,
      branchCommitAfterReview,
    ),
    logPath,
  );

  if (review.outcome !== "approved") {
    const reason = reportPhaseFailure({
      phase: `Reviewer for ${issueLabel}`,
      outcome: review.outcome,
      detail: review.detail,
      logPath,
    });
    return { outcome: "stopped", reason };
  }

  console.log(chalk.green("Review complete."));
  return undefined;
}

// Implements the issue, or reuses a committed implementation on a leftover
// issue branch, then reviews it unless the Reviewer already finished.
async function implementAndReview(
  run: IssueRun,
  sandbox: IssueSandbox,
): Promise<IssueStop | undefined> {
  const { context, branch, issueId, base } = run;
  const branchCommitBeforeImplementation =
    await context.git.getBranchCommit(branch);
  const reusingImplementation = await context.git.hasCommitsBeyondBase(
    branch,
    base.commit,
  );

  let jumpToMerger = false;
  if (reusingImplementation) {
    console.log(
      `Reusing committed implementation on ${branch}; checking whether to continue review or jump to merger.`,
    );
    await reportReusedBranchBehindBase(run);
    jumpToMerger = await shouldSkipReviewerAfterRerun(run);
    if (jumpToMerger) {
      console.log(
        `Last commit appears to be from Sandcastle reviewer for #${issueId}; skipping reviewer and jumping to merger.`,
      );
    } else {
      console.log(
        `Last commit for ${branch} does not indicate a completed review for #${issueId}; continuing to reviewer.`,
      );
    }
  } else {
    const implementerStop = await runImplementer(
      run,
      sandbox,
      branchCommitBeforeImplementation,
    );
    if (implementerStop !== undefined) {
      return implementerStop;
    }
  }

  const reviewIneligible = await stopIfIneligible(run, "review");
  if (reviewIneligible !== undefined) {
    return reviewIneligible;
  }

  return jumpToMerger ? undefined : runReviewer(run, sandbox);
}

// Runs the Merger in its verification worktree. When the Merger does not
// succeed, the runner recovers the base checkout before reporting the stop.
async function runMerger(
  run: IssueRun,
  verificationWorktree: { hostPath: string; sandboxPath: string },
  mergerLogPath: string,
): Promise<IssueStop | undefined> {
  const { context, profile, branch, issueLabel, base } = run;
  const { mergerRecovery } = context;
  let mergerOutcome: MergerOutcome = "stopped";
  let mergerFailureReason = "";
  let mergerSucceeded = false;
  let mergerRecoveryFailed = false;
  let mergerOperationError: unknown;

  try {
    const merge = await context.runtime.runAgent<MergerOutcome>({
      agentType: "merger",
      roleConfig: context.agentConfig.merger,
      branch: base.branch,
      phase: "Merger",
      context: issueLabel,
      logPath: mergerLogPath,
      allowedOutcomes: ["merged", "needs-info", "stopped"],
      promptFile: context.promptFiles.get(profile.prompts.merge),
      promptArgs: promptArgsFor(run, profile.prompts.merge, {
        BASE_BRANCH: base.branch,
        BASE_COMMIT: base.commit,
        BRANCH: branch,
        VERIFICATION_WORKTREE_PATH: verificationWorktree.sandboxPath,
      }),
      sandbox: {
        kind: "head",
        nodeModulesPath: path.posix.join(
          verificationWorktree.sandboxPath,
          "node_modules",
        ),
        hooks: "auth-only",
      },
    });

    mergerOutcome = merge.outcome;
    mergerSucceeded = mergerOutcome === "merged";
    if (!mergerSucceeded) {
      mergerFailureReason = reportPhaseFailure({
        phase: `Merger for ${issueLabel}`,
        outcome: mergerOutcome,
        detail: merge.detail,
        logPath: mergerLogPath,
      });
      if (
        merge.detail &&
        /base branch moved|base guard failed/i.test(merge.detail)
      ) {
        console.warn(
          "The base branch may have changed because of a manual commit, cleanup/config commit, another Sandcastle process, or an automated hook or scheduled job.",
        );
      }
    }
  } catch (error) {
    mergerOperationError = error;
    throw error;
  } finally {
    if (!mergerSucceeded) {
      const recovered = await mergerRecovery.recoverMergerState(
        base.branch,
        verificationWorktree.hostPath,
      );

      if (recovered) {
        try {
          await mergerRecovery.clearMergerRecoveryMarker();
        } catch (markerError) {
          mergerRecoveryFailed = true;
          process.exitCode = 1;
          if (mergerOperationError !== undefined) {
            throw new AggregateError(
              [mergerOperationError, markerError],
              "Merger phase succeeded in recovery, but its marker could not be cleared.",
            );
          }
          console.warn(
            `WARNING: Merger recovery marker could not be cleared. Preserved ${mergerRecovery.mergerRecoveryPath}. ${formatDiagnostic(markerError)}`,
          );
        }
      } else {
        mergerRecoveryFailed = true;
        process.exitCode = 1;
        if (mergerOperationError !== undefined) {
          throw new AggregateError(
            [
              mergerOperationError,
              new Error(
                `Merger recovery failed. Preserved ${mergerRecovery.mergerRecoveryPath}.`,
              ),
            ],
            "Merger phase and recovery both failed.",
          );
        }
      }
    }
  }

  if (mergerSucceeded) {
    return undefined;
  }
  if (mergerRecoveryFailed) {
    return {
      outcome: "aborted",
      reason: `Merger recovery failed after outcome ${mergerOutcome}. Original phase result: ${mergerFailureReason}`,
    };
  }
  return { outcome: "stopped", reason: mergerFailureReason };
}

// The merger only rebases, verifies, and commits on the reviewed branch. The
// runner owns the base-branch update so that no agent commit reaches the base
// branch before the Dockerfile guard has checked it.
async function integrateReviewedBranch(
  { context, issueId, base, branch }: IssueRun,
  mergerLogPath: string,
): Promise<void> {
  const { git } = context;
  const [baseCommit, branchCommit, checkedOutBranch] = await Promise.all([
    git.getBranchCommit(base.branch),
    git.getBranchCommit(branch),
    git.getCheckedOutBranch(),
  ]);

  if (checkedOutBranch !== base.branch) {
    throw new Error(
      `Merger left ${checkedOutBranch} checked out instead of ${base.branch}.`,
    );
  }
  if (baseCommit !== base.commit) {
    throw new Error(
      `${base.branch} moved from ${base.commit} to ${baseCommit} during the run; refusing to integrate ${branch}.`,
    );
  }
  if (!(await git.isAncestorCommit(base.commit, branchCommit))) {
    throw new Error(
      `Merger reported success, but ${branch} is not rebased onto ${base.branch} at ${base.commit}.`,
    );
  }

  // The captured base already contains every pre-run base change, so any
  // Dockerfile in this diff came from an agent on the reviewed branch.
  await throwIfDockerfileChanged(
    "merger",
    issueId,
    await git.getChangedDockerfiles(base.commit, branchCommit),
    mergerLogPath,
  );

  await git.fastForwardTo(branch);
  await context.controlPlane.closeIssue(issueId);
}

// Takes one selected issue through Implementer → Reviewer → Merger →
// Integration on either Work Path. Throws when a safety guard fails in a way
// that recovery cannot contain, for example a Dockerfile change.
export async function runIssue(
  context: RunContext,
  issue: ReadyIssue | SpecChild,
  profile: WorkPathProfile,
): Promise<IssueRunResult> {
  const { git, mergerRecovery, runtime, projectRoot } = context;
  const branch = `sandcastle/issue-${issue.id}`;
  const issueLabel = `${profile.issueNoun} #${issue.id}`;
  await runtime.requireDockerImage();
  const base = await git.getBaseSnapshot();
  const run: IssueRun = {
    context,
    profile,
    issueId: issue.id,
    issueLabel,
    branch,
    base,
  };

  console.log(`Selected ${issueLabel}: ${issue.title}`);
  console.log(`Branch: ${branch}\n`);

  const sandboxResult = await runtime.withIssueSandbox(branch, (sandbox) =>
    implementAndReview(run, sandbox),
  );
  if (sandboxResult.value !== undefined) {
    return sandboxResult.value;
  }

  if (sandboxResult.preservedWorktreePath !== undefined) {
    console.warn(
      `WARNING: Sandcastle preserved a dirty issue worktree at ${sandboxResult.preservedWorktreePath}. Stopping before merge.`,
    );
    process.exitCode = 1;
    return {
      outcome: "aborted",
      reason: "Sandcastle preserved a dirty issue worktree before merge.",
    };
  }

  if (!(await git.hasSafeWorkingTree())) {
    process.exitCode = 1;
    return {
      outcome: "aborted",
      reason: "The base checkout has tracked working-tree changes.",
    };
  }

  const mergeIneligible = await stopIfIneligible(run, "merge");
  if (mergeIneligible !== undefined) {
    return mergeIneligible;
  }

  const verificationWorktree = getVerificationWorktreePaths(
    projectRoot,
    issue.id,
  );
  await mergerRecovery.writeMergerRecoveryMarker(
    base.branch,
    branch,
    verificationWorktree.hostPath,
  );

  try {
    await git.createMergerVerificationWorktree(
      verificationWorktree.hostPath,
      branch,
    );
  } catch (error) {
    await mergerRecovery.recoverAfterMergerStepFailure(
      "setup",
      error,
      base.branch,
      verificationWorktree.hostPath,
    );
  }

  const mergerLogPath = await runtime.createLogPath(
    `issue-${issue.id}`,
    "merger",
  );
  const mergerStop = await runMerger(run, verificationWorktree, mergerLogPath);
  if (mergerStop !== undefined) {
    return mergerStop;
  }

  if (
    !(await mergerRecovery.removeVerificationWorktree(
      verificationWorktree.hostPath,
    ))
  ) {
    const reason = `${capitalize(issueLabel)} was not integrated because host verification-worktree cleanup failed.`;
    console.warn(`WARNING: ${reason}`);
    process.exitCode = 1;
    return { outcome: "aborted", reason };
  }

  try {
    await integrateReviewedBranch(run, mergerLogPath);
  } catch (error) {
    await mergerRecovery.recoverAfterMergerStepFailure(
      "validation",
      error,
      base.branch,
      verificationWorktree.hostPath,
    );
  }

  try {
    await git.deleteReviewedBranch(branch);
  } catch (error) {
    console.warn(
      `WARNING: ${capitalize(issueLabel)} was integrated and closed, but reviewed branch ${branch} could not be deleted.`,
    );
    console.error(error);
    process.exitCode = 1;
    return {
      outcome: "aborted",
      reason: `${capitalize(issueLabel)} was integrated, but its reviewed branch could not be deleted.`,
    };
  }

  await mergerRecovery.clearMergerRecoveryMarker();
  console.log(chalk.green(`Integration complete for ${issueLabel}.`));
  return { outcome: "integrated" };
}
