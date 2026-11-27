import chalk from "chalk";
import { appendFile, writeFile } from "node:fs/promises";

import type { AgentSandbox } from "./agent-runtime.ts";
import type { BaseSnapshot } from "./git-state.ts";
import {
  fingerprintWorktree,
  rebaseAndVerify,
  resetIssueBranch,
  restoreIssueBranch,
  type IntegrationLog,
} from "./integration.ts";
import { reportPhaseFailure } from "./phase-diagnostics.ts";
import type { PromptFilename } from "./prompt-resolution.ts";
import { isReviewerCommitMessageForIssue } from "./recovery-routing.ts";
import {
  formatRefChanges,
  snapshotGuardedRefs,
  type RefGuard,
} from "./ref-guard.ts";
import { formatDiagnostic } from "./run-completion.ts";
import type { RunContext } from "./run-context.ts";
import type { ReadyIssue, SpecChild } from "./spec-selection.ts";

export type WorkPath = "spec" | "standalone";

type ImplementerOutcome = "implemented" | "needs-info" | "stopped";
type ReviewerOutcome = "approved" | "needs-info" | "stopped";
type ReporterOutcome = "reported";

// The agent phases after which the ref guard runs.
type GuardedPhase = "implementer" | "reviewer" | "reporter";

// How many times Integration rebases and verifies in total when the Base
// Branch keeps moving before the fast-forward.
const integrationAttempts = 3;

// What differs between the two Work Paths. Every step and message of the
// issue workflow is otherwise shared.
export type WorkPathProfile = {
  // Names the issue in messages: "child issue" or "standalone issue".
  issueNoun: string;
  prompts: {
    implement: PromptFilename;
    review: PromptFilename;
    report: PromptFilename;
  };
  // Added to every agent prompt, for example SPEC_ISSUE_ID for a Child Issue.
  promptArgs: Record<string, string>;
  // A reason when the issue lost Eligibility; checked before review and
  // Integration.
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
      report: "report-prompt.md",
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
      report: "standalone-report-prompt.md",
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
  // Guards every ref except the issue branch. A failed Integration takes a
  // new snapshot before the Reporter, so an earlier Base Branch move is not
  // blamed on it.
  refGuard: RefGuard;
};

// A rebase conflict or failed verification, as the Reporter receives it.
type IntegrationFailure = {
  cause: "rebase conflict" | "failed verification";
  detail: string;
  onto: string;
  reviewedCommit: string;
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

function abort(reason: string): IssueStop {
  console.error(reason);
  process.exitCode = 1;
  return { outcome: "aborted", reason };
}

async function throwIfDockerfileChanged(
  changedBy: "implementer" | "reviewer" | "the issue branch",
  issueId: string,
  changedDockerfiles: readonly string[],
  logPath: string,
): Promise<void> {
  if (changedDockerfiles.length === 0) {
    return;
  }

  const message = `ABORTING RUN: ${changedBy} for issue #${issueId} changed Dockerfile(s): ${changedDockerfiles.join(", ")}.`;
  await appendFile(
    logPath,
    `\n\n${"!".repeat(80)}\n${message}\n${"!".repeat(80)}\n`,
  );
  throw new Error(message);
}

// Stops the run when an agent phase changed a guarded ref.
async function abortIfRefsChanged(
  run: IssueRun,
  role: GuardedPhase,
): Promise<IssueStop | undefined> {
  const changes = await run.refGuard.check();
  if (changes.length === 0) {
    return undefined;
  }
  return abort(formatRefChanges(`${role} phase for ${run.issueLabel}`, changes));
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

// A reused branch keeps its stale base until Integration rebases it.
async function reportReusedBranchBehindBase({
  context,
  branch,
  base,
}: IssueRun): Promise<void> {
  if (await context.git.isAncestorCommit(base.commit, branch)) {
    return;
  }

  console.log(
    `Info: ${branch} is behind ${base.branch} at ${base.commit}; Integration will rebase it onto ${base.branch}.`,
  );
}

async function stopIfIneligible(
  run: IssueRun,
  step: "review" | "Integration",
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
  sandbox: AgentSandbox,
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
    sandbox,
  });

  const refStop = await abortIfRefsChanged(run, "implementer");
  if (refStop !== undefined) {
    return refStop;
  }

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
  sandbox: AgentSandbox,
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
    sandbox,
  });

  const refStop = await abortIfRefsChanged(run, "reviewer");
  if (refStop !== undefined) {
    return refStop;
  }

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
  sandbox: AgentSandbox,
): Promise<IssueStop | undefined> {
  const { context, branch, issueId, base } = run;
  const branchCommitBeforeImplementation =
    await context.git.getBranchCommit(branch);
  const reusingImplementation = await context.git.hasCommitsBeyondBase(
    branch,
    base.commit,
  );

  let skipReviewer = false;
  if (reusingImplementation) {
    console.log(
      `Reusing committed implementation on ${branch}; checking whether to continue review or go to Integration.`,
    );
    await reportReusedBranchBehindBase(run);
    skipReviewer = await shouldSkipReviewerAfterRerun(run);
    if (skipReviewer) {
      console.log(
        `Last commit appears to be from Sandcastle reviewer for #${issueId}; skipping reviewer and going to Integration.`,
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

  return skipReviewer ? undefined : runReviewer(run, sandbox);
}

function parseIntegrationReport(stdout: string): string | undefined {
  return [
    ...stdout.matchAll(/<integration-report>([\s\S]*?)<\/integration-report>/g),
  ]
    .at(-1)?.[1]
    ?.trim();
}

// Publishes the Integration Report to a log file, an issue comment, and the
// terminal.
async function publishIntegrationReport(
  run: IssueRun,
  failure: IntegrationFailure,
  report: string,
): Promise<string> {
  const { context, issueId, branch, base } = run;
  const reportPath = await context.runtime.createLogPath(
    `issue-${issueId}`,
    "integration-report",
  );
  const body = [
    `sandcastle(reporter): #${issueId}: Integration failed: ${failure.cause}`,
    "",
    `- Branch: \`${branch}\`, unchanged at \`${failure.reviewedCommit}\``,
    `- Base Branch: \`${base.branch}\` at \`${failure.onto}\``,
    "",
    "## What the runner saw",
    "",
    "```text",
    failure.detail,
    "```",
    "",
    "## Integration Report",
    "",
    report,
    "",
  ].join("\n");
  await writeFile(reportPath, body);
  try {
    await context.controlPlane.commentOnIssue(issueId, reportPath);
  } catch (error) {
    console.warn(
      `WARNING: Could not post the Integration Report as a comment on issue #${issueId}. ${formatDiagnostic(error)}`,
    );
  }
  console.log(`\n${body}`);
  return reportPath;
}

// Runs the Reporter on the failed Integration, checks that it changed
// nothing, restores the issue branch, and publishes the Integration Report.
async function reportIntegrationFailure(
  run: IssueRun,
  sandbox: AgentSandbox,
  failure: IntegrationFailure,
  log: IntegrationLog,
): Promise<IssueStop> {
  const { context, profile, branch, issueId, issueLabel, base } = run;
  console.warn(
    `WARNING: Integration of ${issueLabel} failed: ${failure.cause}. Starting the Reporter.`,
  );
  const before = await fingerprintWorktree(sandbox, branch);
  // No agent ran since the Reviewer's check, so a fresh snapshot accepts only
  // Base Branch moves made before the Reporter starts.
  run.refGuard = await snapshotGuardedRefs(context.git, [branch]);
  const logPath = await context.runtime.createLogPath(
    `issue-${issueId}`,
    "reporter",
  );

  let stdout: string;
  try {
    const result = await context.runtime.runAgent<ReporterOutcome>({
      agentType: "reporter",
      roleConfig: context.agentConfig.reporter,
      branch,
      phase: "Reporter",
      context: issueLabel,
      logPath,
      allowedOutcomes: ["reported"],
      promptFile: context.promptFiles.get(profile.prompts.report),
      promptArgs: promptArgsFor(run, profile.prompts.report, {
        BASE_BRANCH: base.branch,
        BASE_COMMIT: failure.onto,
        BRANCH: branch,
        REVIEWED_COMMIT: failure.reviewedCommit,
        FAILURE_KIND: failure.cause,
        FAILURE_DETAIL: failure.detail,
      }),
      sandbox,
    });
    stdout = result.stdout;
  } catch (error) {
    if ((await fingerprintWorktree(sandbox, branch)) === before) {
      await restoreIssueBranch(sandbox, branch, log);
    }
    throw error;
  }

  const refStop = await abortIfRefsChanged(run, "reporter");
  if (refStop !== undefined) {
    return refStop;
  }
  if ((await fingerprintWorktree(sandbox, branch)) !== before) {
    return abort(
      `ABORTING RUN: the Reporter for ${issueLabel} changed the issue worktree, its HEAD, or ${branch}. Sandcastle left them as they are for inspection; the Base Branch is unchanged. Log: ${logPath}`,
    );
  }

  await restoreIssueBranch(sandbox, branch, log);
  const report =
    parseIntegrationReport(stdout) ??
    `The Reporter gave no Integration Report. See its log: ${logPath}`;
  const reportPath = await publishIntegrationReport(run, failure, report);
  return {
    outcome: "stopped",
    reason: `Integration of ${issueLabel} failed: ${failure.cause}. ${branch} is unchanged. Integration Report: ${reportPath}`,
  };
}

// Runner-owned Integration in the issue sandbox: rebase the reviewed branch
// onto the live Base Branch, verify it, and fast-forward the Base Branch on
// the host. Returns undefined once the Base Branch has been fast-forwarded.
async function integrate(
  run: IssueRun,
  sandbox: AgentSandbox,
): Promise<IssueStop | undefined> {
  const { context, branch, issueId, issueLabel, base } = run;
  const { git } = context;
  const logPath = await context.runtime.createLogPath(
    `issue-${issueId}`,
    "integration",
  );
  const log: IntegrationLog = (text) => appendFile(logPath, text);
  const reviewedCommit = await git.getBranchCommit(branch);

  for (let attempt = 1; attempt <= integrationAttempts; attempt++) {
    const onto = await git.getBranchCommit(base.branch);
    console.log(`Integration: rebasing ${branch} onto ${base.branch} at ${onto}.`);
    const outcome = await rebaseAndVerify(sandbox, {
      branch,
      onto,
      commands: context.verificationCommands,
      log,
    });
    if (outcome.kind !== "verified") {
      return reportIntegrationFailure(
        run,
        sandbox,
        {
          cause:
            outcome.kind === "conflict"
              ? "rebase conflict"
              : "failed verification",
          detail: outcome.detail,
          onto,
          reviewedCommit,
        },
        log,
      );
    }

    // Covers commits a reused branch brought from an earlier run.
    await throwIfDockerfileChanged(
      "the issue branch",
      issueId,
      await git.getChangedDockerfiles(onto, outcome.commit),
      logPath,
    );
    if (!(await git.hasSafeWorkingTree())) {
      return abort("The base checkout has tracked working-tree changes.");
    }

    if ((await git.getBranchCommit(base.branch)) === onto) {
      try {
        await git.fastForwardTo(branch);
        return undefined;
      } catch (error) {
        if ((await git.getBranchCommit(base.branch)) === onto) {
          throw error;
        }
      }
    }

    // The branch goes back to the reviewed commit, so it points there again
    // after any later failure.
    await resetIssueBranch(sandbox, {
      branch,
      from: outcome.commit,
      to: reviewedCommit,
      log,
    });
    if (attempt < integrationAttempts) {
      console.warn(
        `WARNING: ${base.branch} moved during Integration of ${issueLabel}; rebasing and verifying again (attempt ${attempt + 1} of ${integrationAttempts}).`,
      );
    }
  }

  const reason = `${base.branch} moved before every fast-forward of ${branch}; Integration of ${issueLabel} gave up after ${integrationAttempts} attempts. ${branch} is unchanged at the reviewed commit ${reviewedCommit}. Log: ${logPath}`;
  console.warn(`WARNING: ${reason}`);
  return { outcome: "stopped", reason };
}

// Takes one selected issue through Implementer → Reviewer → Integration on
// either Work Path, in one issue sandbox. Throws when a safety guard fails in
// a way the run cannot contain, for example a Dockerfile change.
export async function runIssue(
  context: RunContext,
  issue: ReadyIssue | SpecChild,
  profile: WorkPathProfile,
): Promise<IssueRunResult> {
  const { git, runtime } = context;
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
    refGuard: await snapshotGuardedRefs(git, [branch]),
  };

  console.log(`Selected ${issueLabel}: ${issue.title}`);
  console.log(`Branch: ${branch}\n`);

  const sandboxResult = await runtime.withSandbox(branch, async (sandbox) => {
    const reviewStop = await implementAndReview(run, sandbox);
    if (reviewStop !== undefined) {
      return reviewStop;
    }
    const integrationIneligible = await stopIfIneligible(run, "Integration");
    if (integrationIneligible !== undefined) {
      return integrationIneligible;
    }
    return integrate(run, sandbox);
  });

  const { preservedWorktreePath } = sandboxResult;
  if (preservedWorktreePath !== undefined) {
    console.warn(
      `WARNING: Sandcastle preserved a dirty issue worktree at ${preservedWorktreePath}.`,
    );
  }
  if (sandboxResult.value !== undefined) {
    return sandboxResult.value;
  }
  if (preservedWorktreePath !== undefined) {
    return abort(
      `${base.branch} was fast-forwarded to ${branch}, but ${issueLabel} was not closed because Sandcastle preserved its dirty issue worktree at ${preservedWorktreePath}.`,
    );
  }

  await context.controlPlane.closeIssue(issue.id);
  try {
    await git.deleteBranch(branch);
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

  console.log(chalk.green(`Integration complete for ${issueLabel}.`));
  return { outcome: "integrated" };
}
