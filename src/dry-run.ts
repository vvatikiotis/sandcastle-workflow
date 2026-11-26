import chalk from "chalk";

import type { WorkPath } from "./issue-workflow.ts";
import {
  getBlockedReadyChildren,
  getEligibleChildren,
  type BlockedStandaloneIssue,
  type ReadyIssue,
  type SpecCandidate,
} from "./spec-selection.ts";
import { formatBlockedStandaloneIssue } from "./workflow-completion.ts";

export function printBlockedStandaloneIssues(
  blockedStandaloneIssues: readonly BlockedStandaloneIssue[],
): void {
  for (const blocked of blockedStandaloneIssues) {
    console.log(`Standalone issue ${formatBlockedStandaloneIssue(blocked)}.`);
  }
}

export function printDryRun({
  specCandidates,
  standaloneIssues,
  blockedStandaloneIssues,
  errors,
  workPath,
}: {
  specCandidates: readonly SpecCandidate[];
  standaloneIssues: readonly ReadyIssue[];
  blockedStandaloneIssues: readonly BlockedStandaloneIssue[];
  errors: readonly string[];
  // Undefined when no Work Path choice was needed.
  workPath: WorkPath | undefined;
}): void {
  console.log("\n=== Sandcastle dry run ===");
  console.log(
    "Dry run only. No agents will be started and no changes will be made.",
  );

  if (errors.length > 0) {
    console.log(
      chalk.red(`Would abort:\n${errors.map((error) => `- ${error}`).join("\n")}`),
    );
    return;
  }

  printBlockedStandaloneIssues(blockedStandaloneIssues);

  if (specCandidates.length === 0) {
    if (standaloneIssues.length === 0) {
      console.log(
        blockedStandaloneIssues.length === 0
          ? "No open ready-for-agent issues found. Dry run complete."
          : "No unblocked standalone issues to implement. Dry run complete.",
      );
      return;
    }

    console.log(
      `Standalone issues: ${standaloneIssues.map((issue) => `#${issue.id} ${issue.title}`).join(", ")}.`,
    );
    console.log(
      `Would implement standalone issue #${standaloneIssues[0].id} next.`,
    );
    return;
  }

  console.log(`Spec candidates: ${specCandidates.length}.`);

  for (const candidate of specCandidates) {
    console.log(
      `\nSpec #${candidate.id}: ${candidate.title} (${candidate.createdAt})`,
    );

    for (const child of candidate.children) {
      console.log(`  - #${child.id} ${child.title} (${child.status})`);
    }
  }

  if (workPath === "standalone") {
    console.log(
      `\nSelected standalone path. Would implement standalone issue #${standaloneIssues[0].id} next.`,
    );
    return;
  }

  const selectedSpec = specCandidates[0];
  const readyChildren = getEligibleChildren(selectedSpec.children);
  const blockedReadyChildren = getBlockedReadyChildren(selectedSpec.children);
  const unresolvedChildren = selectedSpec.children.filter(
    (child) => child.status !== "closed" && child.status !== "ready-for-agent",
  );

  console.log(
    `\nSelected earliest spec: #${selectedSpec.id} ${selectedSpec.title}.`,
  );
  console.log(
    `Ordered ready-for-agent children: ${readyChildren.length === 0 ? "none" : readyChildren.map((child) => `#${child.id} ${child.title}`).join(", ")}.`,
  );

  if (unresolvedChildren.length > 0) {
    console.log(chalk.yellow("Would warn about unresolved children and stop."));
  } else if (readyChildren.length > 0) {
    console.log(`Would implement #${readyChildren[0].id} next.`);
  } else if (blockedReadyChildren.length > 0) {
    console.log(
      chalk.yellow(
        `Would stop: no ready child is unblocked (${blockedReadyChildren.map((child) => `#${child.id}`).join(", ")}).`,
      ),
    );
  } else {
    console.log("Would run final spec review.");
  }
}
