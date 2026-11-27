import chalk from "chalk";
import { createInterface } from "node:readline/promises";

import type { WorkCandidates } from "./control-plane.ts";
import { unsafeBaseCheckoutReason } from "./git-state.ts";
import { printBlockedStandaloneIssues, printDryRun } from "./dry-run.ts";
import { runFinalSpecReview } from "./final-spec-review.ts";
import {
  createSpecPathProfile,
  createStandalonePathProfile,
  runIssue,
  type WorkPath,
} from "./issue-workflow.ts";
import { formatDiagnostic, type RunEndStatus } from "./run-completion.ts";
import type { RunContext } from "./run-context.ts";
import {
  getBlockedReadyChildren,
  getEligibleChildren,
  getOpenBlockerIds,
  getUnresolvedChildren,
  selectRunSpec,
} from "./spec-selection.ts";
import {
  classifyPlanningError,
  getNoStandaloneIssuesStatus,
} from "./workflow-completion.ts";

type WorkPathChoice =
  | { kind: "chosen"; workPath: WorkPath }
  | { kind: "unanswered"; reason: string };

async function chooseWorkPath(): Promise<WorkPathChoice> {
  // Without a terminal nobody can answer, and the question would wait forever.
  if (!process.stdin.isTTY) {
    return { kind: "unanswered", reason: "stdin is not an interactive terminal" };
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // A terminal in raw mode delivers Ctrl-C to readline instead of raising
  // SIGINT, so forward it to keep the run's interrupt handling.
  readline.on("SIGINT", () => {
    process.kill(process.pid, "SIGINT");
  });
  // Not every way input can end settles a pending question, so the interface
  // closing also ends the wait.
  const closed = new Promise<undefined>((resolve) => {
    readline.once("close", () => resolve(undefined));
  });

  try {
    while (true) {
      const asked = readline
        .question(
          "Ready spec work and standalone issues are available. Follow the spec path or the standalone path? [spec/standalone] ",
        )
        .catch((error: unknown) => {
          // Ctrl-D closes the interface and rejects the question with an AbortError.
          if (error instanceof Error && error.name === "AbortError") {
            return undefined;
          }
          throw error;
        });
      const reply = await Promise.race([asked, closed]);
      if (reply === undefined) {
        return {
          kind: "unanswered",
          reason: "stdin closed before a work path was chosen",
        };
      }

      const answer = reply.trim().toLowerCase();
      if (answer === "spec" || answer === "standalone") {
        return { kind: "chosen", workPath: answer };
      }

      console.warn('Please enter "spec" or "standalone".');
    }
  } finally {
    readline.close();
  }
}

// Ends the run without starting work when the operator cannot choose a Work
// Path. Status 2 marks it as a usage problem: rerun from a terminal.
function stopForUnansweredWorkPath(reason: string): RunEndStatus {
  console.error(
    `ERROR: Both ready spec work and standalone issues are available, and choosing a work path needs an interactive terminal (${reason}). Run Sandcastle from a terminal to choose the spec path or the standalone path.`,
  );
  process.exitCode = 2;
  return {
    kind: "stopped",
    reason: "Choosing a work path needs an interactive terminal.",
  };
}

// Asks the operator for a Work Path when both paths have work and none was
// chosen earlier in the run; otherwise keeps the current one.
async function resolveWorkPath(
  current: WorkPath | undefined,
  { candidates, standaloneIssues }: WorkCandidates,
): Promise<
  | { kind: "resolved"; workPath: WorkPath | undefined }
  | { kind: "ended"; status: RunEndStatus }
> {
  if (
    current !== undefined ||
    candidates.length === 0 ||
    standaloneIssues.length === 0
  ) {
    return { kind: "resolved", workPath: current };
  }

  const choice = await chooseWorkPath();
  return choice.kind === "chosen"
    ? { kind: "resolved", workPath: choice.workPath }
    : { kind: "ended", status: stopForUnansweredWorkPath(choice.reason) };
}

async function requireSafeBaseCheckout(
  context: RunContext,
): Promise<RunEndStatus | undefined> {
  if (await context.git.hasSafeWorkingTree()) {
    return undefined;
  }
  process.exitCode = 1;
  return {
    kind: "aborted",
    reason: unsafeBaseCheckoutReason,
  };
}

// Reads the work graph. An invalid graph ends the run as stopped; any other
// failure propagates.
async function planWork(
  context: RunContext,
): Promise<
  | { kind: "planned"; workCandidates: WorkCandidates }
  | { kind: "ended"; status: RunEndStatus }
> {
  try {
    return {
      kind: "planned",
      workCandidates: await context.controlPlane.getWorkCandidates(),
    };
  } catch (error) {
    const planningStatus = classifyPlanningError(error);
    if (!planningStatus) {
      throw error;
    }
    console.warn(`WARNING: ${formatDiagnostic(error)}`);
    return { kind: "ended", status: planningStatus };
  }
}

// Plans once and prints what a normal run would do, without starting agents.
async function runDryRun(
  context: RunContext,
  maxIterations: number,
): Promise<RunEndStatus> {
  console.log(`\n\nMax iterations: ${maxIterations}`);

  const unsafeCheckout = await requireSafeBaseCheckout(context);
  if (unsafeCheckout !== undefined) {
    return unsafeCheckout;
  }

  const plan = await planWork(context);
  if (plan.kind === "ended") {
    return plan.status;
  }
  const { workCandidates } = plan;
  const { errors } = workCandidates;

  let workPath: WorkPath | undefined;
  if (errors.length === 0) {
    const resolution = await resolveWorkPath(undefined, workCandidates);
    if (resolution.kind === "ended") {
      return resolution.status;
    }
    workPath = resolution.workPath;
  }

  printDryRun({
    specCandidates: workCandidates.candidates,
    standaloneIssues: workCandidates.standaloneIssues,
    blockedStandaloneIssues: workCandidates.blockedStandaloneIssues,
    errors,
    workPath,
  });
  return errors.length === 0
    ? {
        kind: "completed",
        reason: "Dry run completed without starting any agents.",
      }
    : {
        kind: "stopped",
        reason: "Dry run found invalid GitHub native sub-issue relationships.",
      };
}

// NOTE:
// 1. ready-for-agent includes parent specs and executable child issues
// 2. implementer should not close the issue but comment on the work done
// 3. reviewer is the quality gate
// 4. Integration is the completion gate: the runner rebases and verifies the
//    reviewed branch, fast-forwards the base branch, and closes the issue
// Each iteration integrates at most one issue or runs the final spec review.
export async function runWorkflow(
  context: RunContext,
  { isDryRun, maxIterations }: { isDryRun: boolean; maxIterations: number },
): Promise<RunEndStatus> {
  if (isDryRun) {
    return runDryRun(context, maxIterations);
  }

  const { controlPlane } = context;
  let runEndStatus: RunEndStatus | undefined;
  let runSpecIssueId: string | undefined;
  let workPath: WorkPath | undefined;
  let skippedStaleStandaloneSelection = false;

  iterationLoop: for (
    let iteration = 1;
    iteration <= maxIterations;
    iteration++
  ) {
    const unsafeCheckout = await requireSafeBaseCheckout(context);
    if (unsafeCheckout !== undefined) {
      runEndStatus = unsafeCheckout;
      break;
    }

    console.log(
      chalk.blue(`\n=== Iteration ${iteration}/${maxIterations} ===\n`),
    );

    const plan = await planWork(context);
    if (plan.kind === "ended") {
      runEndStatus = plan.status;
      break;
    }
    const {
      candidates: specCandidates,
      standaloneIssues,
      blockedStandaloneIssues,
      errors,
    } = plan.workCandidates;

    if (errors.length > 0) {
      console.warn(
        `WARNING: Sandcastle could not validate native sub-issues:\n${errors.map((error) => `- ${error}`).join("\n")}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: "GitHub native sub-issue validation failed.",
      };
      break;
    }

    const resolution = await resolveWorkPath(workPath, plan.workCandidates);
    if (resolution.kind === "ended") {
      runEndStatus = resolution.status;
      break;
    }
    workPath = resolution.workPath;

    //
    // region Standalone workflow
    //

    if (
      workPath === "standalone" ||
      (workPath !== "spec" && specCandidates.length === 0)
    ) {
      printBlockedStandaloneIssues(blockedStandaloneIssues);
      if (standaloneIssues.length === 0) {
        runEndStatus = getNoStandaloneIssuesStatus({
          blockedIssues: blockedStandaloneIssues,
          skippedStaleSelection: skippedStaleStandaloneSelection,
          standalonePathSelected: workPath === "standalone",
        });
        if (runEndStatus.kind === "stopped") {
          console.warn(`WARNING: ${runEndStatus.reason}`);
        } else {
          console.log(runEndStatus.reason);
        }
        break;
      }

      const standaloneProfile = createStandalonePathProfile(context);
      for (const standaloneIssue of standaloneIssues) {
        // A later candidate was planned before the previous one changed
        // GitHub, so its Eligibility is confirmed before any work starts.
        const eligibilityError =
          await controlPlane.getStandaloneEligibilityError(standaloneIssue.id);
        if (eligibilityError) {
          console.warn(
            `WARNING: Skipping standalone issue because GitHub issue state changed: ${eligibilityError.detail}`,
          );
          if (eligibilityError.kind === "invalid-graph") {
            runEndStatus = {
              kind: "stopped",
              reason: "GitHub native sub-issue validation failed.",
            };
            break iterationLoop;
          }
          skippedStaleStandaloneSelection = true;
          console.warn(
            "WARNING: Standalone selection was stale. Trying the next candidate.",
          );
          continue;
        }

        const result = await runIssue(
          context,
          standaloneIssue,
          standaloneProfile,
        );
        if (result.outcome !== "integrated") {
          runEndStatus = { kind: result.outcome, reason: result.reason };
          break iterationLoop;
        }
        // A skipped stale selection keeps its own iteration-limit reason.
        if (
          iteration === maxIterations &&
          !skippedStaleStandaloneSelection
        ) {
          runEndStatus = {
            kind: "completed",
            reason: `Reached the ${maxIterations}-iteration limit after integrating ${standaloneProfile.issueNoun} #${standaloneIssue.id}.`,
          };
        }
        continue iterationLoop;
      }

      console.warn(
        "WARNING: All standalone candidates were stale. Replanning.",
      );
      continue iterationLoop;
    }

    //
    // endregion Standalone workflow
    //

    //
    // region Spec workflow
    //
    // ADR-0001 governs Specification selection and Child Issue Eligibility.
    // The selected Child Issue then runs through the same issue workflow as
    // a Standalone Issue.

    if (workPath === "spec" && specCandidates.length === 0) {
      const reason = "No open ready-for-agent spec issues were found.";
      console.log(reason);
      runEndStatus = { kind: "completed", reason };
      break;
    }

    const selectingFirstSpec = runSpecIssueId === undefined;
    const selectedSpec = selectRunSpec(specCandidates, runSpecIssueId);

    if (!selectedSpec) {
      console.warn(
        `WARNING: Selected spec #${runSpecIssueId} is no longer an open ready-for-agent native parent. Stopping without selecting another spec.`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: `Selected spec #${runSpecIssueId} is no longer eligible.`,
      };
      break;
    }

    runSpecIssueId ??= selectedSpec.id;

    if (selectingFirstSpec && specCandidates.length > 1) {
      console.warn(
        `WARNING: ${specCandidates.length} open spec issues were found. Processing earliest spec #${selectedSpec.id}; other specs and their children are ignored.`,
      );
    }

    const unresolvedChildren = getUnresolvedChildren(selectedSpec.children);

    if (unresolvedChildren.length > 0) {
      console.warn(
        `WARNING: Spec #${selectedSpec.id} has unresolved child issues. Final review will not run:\n${unresolvedChildren.map((child) => `- #${child.id} ${child.title} (${child.status})`).join("\n")}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: `Spec #${selectedSpec.id} has unresolved child issues.`,
      };
      break;
    }

    const readyChildren = getEligibleChildren(selectedSpec.children);
    const blockedReadyChildren = getBlockedReadyChildren(selectedSpec.children);
    const plannedIssue = readyChildren[0];

    if (!plannedIssue && blockedReadyChildren.length > 0) {
      console.warn(
        `WARNING: Spec #${selectedSpec.id} has no unblocked ready child issues:\n${blockedReadyChildren
          .map(
            (child) =>
              `- #${child.id} blocked by ${getOpenBlockerIds(
                child,
                selectedSpec.children,
              )
                .map((blockerId) => `#${blockerId}`)
                .join(", ")}`,
          )
          .join("\n")}`,
      );
      runEndStatus = {
        kind: "stopped",
        reason: `Spec #${selectedSpec.id} has no unblocked ready child issues.`,
      };
      break;
    }

    if (!plannedIssue) {
      console.log(
        `Spec #${selectedSpec.id} has no open ready-for-agent child issues. Running final spec review.`,
      );
      runEndStatus = await runFinalSpecReview(context, selectedSpec.id);
      break;
    }

    const specProfile = createSpecPathProfile(context, selectedSpec.id);
    const result = await runIssue(context, plannedIssue, specProfile);
    if (result.outcome !== "integrated") {
      runEndStatus = { kind: result.outcome, reason: result.reason };
      break;
    }

    if (iteration === maxIterations) {
      runEndStatus = {
        kind: "completed",
        reason: `Reached the ${maxIterations}-iteration limit after integrating ${specProfile.issueNoun} #${plannedIssue.id}.`,
      };
    }

    //
    // endregion Spec workflow
    //
  }

  if (!runEndStatus) {
    runEndStatus = skippedStaleStandaloneSelection
      ? {
          kind: "stopped",
          reason: `Reached the ${maxIterations}-iteration limit while replanning stale standalone selections.`,
        }
      : {
          kind: "completed",
          reason: `Reached the ${maxIterations}-iteration limit.`,
        };
  }

  return runEndStatus;
}
