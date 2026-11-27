import { z } from "zod";

import type { Exec } from "./run-context.ts";
import {
  getEligibleChildren,
  getIssueStatus,
  partitionStandaloneByOpenBlockers,
  selectSpecCandidates,
  selectStandaloneCandidates,
  validateSpecGraph,
  type BlockedStandaloneIssue,
  type ReadyIssue,
  type SpecCandidate,
  type SpecChild,
} from "./spec-selection.ts";
import { InvalidIssueGraphError } from "./workflow-completion.ts";

export type WorkCandidates = {
  candidates: SpecCandidate[];
  standaloneIssues: ReadyIssue[];
  blockedStandaloneIssues: BlockedStandaloneIssue[];
  errors: string[];
};

type StandaloneEligibilityError = {
  kind: "state-changed" | "invalid-graph";
  detail: string;
};

// The runner's view of the GitHub Control Plane (ADR-0001): ready issues,
// native sub-issues, Blockers, and the Eligibility re-checks made between
// phases. Agents never select work; every selection decision reads from here.
export type ControlPlane = {
  // Throws InvalidIssueGraphError when GitHub reports an inconsistent graph.
  getWorkCandidates: () => Promise<WorkCandidates>;
  // A reason when the Child Issue is no longer eligible in its Specification.
  getSelectedIssueEligibilityError: (
    specIssueId: string,
    issueId: string,
  ) => Promise<string | undefined>;
  getStandaloneEligibilityError: (
    issueId: string,
  ) => Promise<StandaloneEligibilityError | undefined>;
  isIssueClosed: (issueId: string) => Promise<boolean>;
  closeIssue: (issueId: string) => Promise<void>;
  // Posts the file's contents as an issue comment.
  commentOnIssue: (issueId: string, bodyFile: string) => Promise<void>;
};

export function createControlPlane({
  execFile,
  packageVersion,
}: {
  execFile: Exec;
  packageVersion: string;
}): ControlPlane {
  async function getOpenReadyIssues(): Promise<ReadyIssue[]> {
    const { stdout } = await execFile("gh", [
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "ready-for-agent",
      "--limit",
      "101",
      "--json",
      "number,title,createdAt,parent",
      "--jq",
      "[.[] | {id: (.number | tostring), title, createdAt, parentId: (if .parent == null then null else (.parent.number | tostring) end)}]",
    ]);

    const readyIssues = z
      .array(
        z.object({
          id: z.string().regex(/^\d+$/),
          title: z.string(),
          createdAt: z.string().datetime({ offset: true }),
          parentId: z.string().regex(/^\d+$/).nullable(),
        }),
      )
      .parse(JSON.parse(stdout));
    if (readyIssues.length > 100) {
      throw new InvalidIssueGraphError(
        `Sandcastle found more than 100 open ready-for-agent issues. Reduce the eligible set to the documented version ${packageVersion} limit before running the workflow.`,
      );
    }
    return readyIssues;
  }

  async function getNativeSubIssueDetails(issueId: string): Promise<{
    parentId: string | null;
    blockerIds: string[];
    blockingIds: string[];
  }> {
    const { stdout } = await execFile("gh", [
      "issue",
      "view",
      issueId,
      "--json",
      "parent,blockedBy,blocking",
    ]);
    const issue = z
      .object({
        parent: z.object({ number: z.number().int().positive() }).nullable(),
        blockedBy: z.object({
          nodes: z.array(z.object({ number: z.number().int().positive() })),
        }),
        blocking: z.object({
          nodes: z.array(z.object({ number: z.number().int().positive() })),
        }),
      })
      .parse(JSON.parse(stdout));

    return {
      parentId: issue.parent === null ? null : String(issue.parent.number),
      blockerIds: issue.blockedBy.nodes.map((blocker) => String(blocker.number)),
      blockingIds: issue.blocking.nodes.map((blocked) => String(blocked.number)),
    };
  }

  async function getNativeSubIssues(specIssueId: string): Promise<SpecChild[]> {
    const { stdout } = await execFile("gh", [
      "api",
      `repos/{owner}/{repo}/issues/${specIssueId}/sub_issues?per_page=100`,
    ]);
    const issues = z
      .array(
        z.object({
          number: z.number().int().positive(),
          title: z.string(),
          state: z.enum(["open", "closed"]),
          labels: z.array(z.object({ name: z.string() })),
        }),
      )
      .parse(JSON.parse(stdout));

    return await Promise.all(
      issues.map(async (issue) => {
        const details = await getNativeSubIssueDetails(String(issue.number));

        if (details.parentId !== specIssueId) {
          throw new InvalidIssueGraphError(
            `GitHub listed issue #${issue.number} under spec #${specIssueId}, but its parent is #${details.parentId ?? "none"}.`,
          );
        }

        return {
          id: String(issue.number),
          title: issue.title,
          status: getIssueStatus({
            state: issue.state === "closed" ? "CLOSED" : "OPEN",
            labels: issue.labels.map((label) => label.name),
          }),
          blockerIds: details.blockerIds,
          blocksParent: details.blockingIds.includes(specIssueId),
        };
      }),
    );
  }

  async function getOpenBlockerIds(issueId: string): Promise<string[]> {
    const { blockerIds } = await getNativeSubIssueDetails(issueId);
    const openBlockerIds: string[] = [];
    for (const blockerId of blockerIds) {
      if (!(await isIssueClosed(blockerId))) {
        openBlockerIds.push(blockerId);
      }
    }
    return openBlockerIds;
  }

  async function getWorkCandidates(): Promise<WorkCandidates> {
    const readyIssues = await getOpenReadyIssues();
    const childrenByParent = new Map<string, readonly SpecChild[]>();
    const nativeSubIssuesByIssue = new Map<string, readonly SpecChild[]>();

    const getCachedNativeSubIssues = async (
      issueId: string,
    ): Promise<readonly SpecChild[]> => {
      const cached = nativeSubIssuesByIssue.get(issueId);
      if (cached) {
        return cached;
      }

      const children = await getNativeSubIssues(issueId);
      nativeSubIssuesByIssue.set(issueId, children);
      return children;
    };

    for (const issue of readyIssues) {
      if (issue.parentId === null) {
        childrenByParent.set(issue.id, await getCachedNativeSubIssues(issue.id));
      }
    }

    const selection = selectSpecCandidates({ readyIssues, childrenByParent });
    const standaloneCandidates = selectStandaloneCandidates({
      readyIssues,
      childrenByParent,
    });
    const openBlockerIdsByIssue = new Map<string, string[]>();
    for (const issue of standaloneCandidates) {
      openBlockerIdsByIssue.set(issue.id, await getOpenBlockerIds(issue.id));
    }
    const { unblocked: standaloneIssues, blocked: blockedStandaloneIssues } =
      partitionStandaloneByOpenBlockers(standaloneCandidates, openBlockerIdsByIssue);

    for (const candidate of selection.candidates) {
      selection.errors.push(...validateSpecGraph(candidate));

      for (const child of candidate.children) {
        if ((await getCachedNativeSubIssues(child.id)).length > 0) {
          selection.errors.push(
            `Spec #${candidate.id} has nested sub-issue #${child.id}; nested hierarchies are not supported.`,
          );
        }
      }
    }

    return { ...selection, standaloneIssues, blockedStandaloneIssues };
  }

  async function getSelectedIssueEligibilityError(
    specIssueId: string,
    issueId: string,
  ): Promise<string | undefined> {
    let workCandidates: WorkCandidates;
    try {
      workCandidates = await getWorkCandidates();
    } catch (error) {
      if (error instanceof InvalidIssueGraphError) {
        return error.message;
      }
      throw error;
    }
    const { candidates, errors } = workCandidates;

    if (errors.length > 0) {
      return errors.join("; ");
    }

    const spec = candidates.find((candidate) => candidate.id === specIssueId);
    if (!spec) {
      return `Spec #${specIssueId} is no longer an open ready-for-agent native parent.`;
    }

    if (
      !getEligibleChildren(spec.children).some((child) => child.id === issueId)
    ) {
      return `Issue #${issueId} is no longer an eligible child of spec #${specIssueId}.`;
    }

    return undefined;
  }

  async function isIssueClosed(issueId: string): Promise<boolean> {
    const { stdout } = await execFile("gh", [
      "issue",
      "view",
      issueId,
      "--json",
      "state",
      "--jq",
      ".state",
    ]);
    const state = stdout.trim();

    if (state !== "CLOSED" && state !== "OPEN") {
      throw new Error(`GitHub returned an invalid issue state: ${stdout}`);
    }

    return state === "CLOSED";
  }

  async function getStandaloneEligibilityErrorDetail(
    issueId: string,
  ): Promise<string | undefined> {
    const issue = (await getOpenReadyIssues()).find(
      (candidate) => candidate.id === issueId,
    );

    if (!issue) {
      return `Standalone issue #${issueId} is no longer open and ready-for-agent.`;
    }

    if (issue.parentId !== null) {
      return `Standalone issue #${issueId} now has parent #${issue.parentId}.`;
    }

    const [children, openBlockers] = await Promise.all([
      getNativeSubIssues(issueId),
      getOpenBlockerIds(issueId),
    ]);
    if (children.length > 0) {
      return `Standalone issue #${issueId} now has native sub-issues.`;
    }

    if (openBlockers.length > 0) {
      return `Standalone issue #${issueId} has open blockers: ${openBlockers.map((blockerId) => `#${blockerId}`).join(", ")}.`;
    }

    return undefined;
  }

  async function getStandaloneEligibilityError(
    issueId: string,
  ): Promise<StandaloneEligibilityError | undefined> {
    try {
      const detail = await getStandaloneEligibilityErrorDetail(issueId);
      return detail === undefined ? undefined : { kind: "state-changed", detail };
    } catch (error) {
      if (error instanceof InvalidIssueGraphError) {
        return { kind: "invalid-graph", detail: error.message };
      }
      throw error;
    }
  }

  async function closeIssue(issueId: string): Promise<void> {
    await execFile("gh", ["issue", "close", issueId]);
  }

  async function commentOnIssue(
    issueId: string,
    bodyFile: string,
  ): Promise<void> {
    await execFile("gh", ["issue", "comment", issueId, "--body-file", bodyFile]);
  }

  return {
    getWorkCandidates,
    getSelectedIssueEligibilityError,
    getStandaloneEligibilityError,
    isIssueClosed,
    closeIssue,
    commentOnIssue,
  };
}
