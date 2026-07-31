export type IssueStatus =
  | "closed"
  | "ready-for-agent"
  | "needs-info"
  | "ready-for-human"
  | "needs-triage"
  | "wontfix"
  | "open";

export type ReadyIssue = {
  id: string;
  title: string;
  createdAt: string;
  parentId: string | null;
};

export type SpecChild = {
  id: string;
  title: string;
  status: IssueStatus;
  blockerIds: string[];
  blocksParent: boolean;
};

export type SpecCandidate = ReadyIssue & {
  children: SpecChild[];
};

export function getIssueStatus({
  state,
  labels,
}: {
  state: "OPEN" | "CLOSED";
  labels: readonly string[];
}): IssueStatus {
  if (state === "CLOSED") {
    return "closed";
  }

  for (const status of [
    "ready-for-agent",
    "needs-info",
    "ready-for-human",
    "needs-triage",
    "wontfix",
  ] as const) {
    if (labels.includes(status)) {
      return status;
    }
  }

  return "open";
}

export function selectSpecCandidates({
  readyIssues,
  childrenByParent,
}: {
  readyIssues: readonly ReadyIssue[];
  childrenByParent: ReadonlyMap<string, readonly SpecChild[]>;
}): { candidates: SpecCandidate[]; errors: string[] } {
  const candidates = readyIssues
    .filter((issue) => issue.parentId === null)
    .flatMap((issue) => {
      const children = childrenByParent.get(issue.id) ?? [];
      return children.length === 0
        ? []
        : [{ ...issue, children: [...children] }];
    })
    .sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
    );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const errors = readyIssues.flatMap((issue) => {
    if (issue.parentId === null) {
      return [];
    }

    return candidateIds.has(issue.parentId)
      ? []
      : [
          `Ready child issue #${issue.id} belongs to non-ready or non-spec parent #${issue.parentId}.`,
        ];
  });

  return { candidates, errors };
}

export function selectStandaloneCandidates({
  readyIssues,
  childrenByParent,
}: {
  readyIssues: readonly ReadyIssue[];
  childrenByParent: ReadonlyMap<string, readonly SpecChild[]>;
}): ReadyIssue[] {
  return readyIssues
    .filter(
      (issue) =>
        issue.parentId === null &&
        (childrenByParent.get(issue.id)?.length ?? 0) === 0
    )
    .sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
    );
}

export function validateSpecGraph(candidate: SpecCandidate): string[] {
  const errors: string[] = [];
  const childrenById = new Map(
    candidate.children.map((child) => [child.id, child])
  );

  for (const child of candidate.children) {
    if (!child.blocksParent) {
      errors.push(
        `Child issue #${child.id} does not block spec #${candidate.id}.`
      );
    }

    for (const blockerId of child.blockerIds) {
      if (!childrenById.has(blockerId)) {
        errors.push(
          `Child issue #${child.id} has cross-scope blocker #${blockerId}; it is not a direct child of spec #${candidate.id}.`
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  function visit(childId: string): void {
    if (visiting.has(childId)) {
      const cycleStart = path.indexOf(childId);
      errors.push(
        `Spec #${candidate.id} has dependency cycle: ${[...path.slice(cycleStart), childId].map((id) => `#${id}`).join(" → ")}.`
      );
      return;
    }
    if (visited.has(childId)) {
      return;
    }

    visiting.add(childId);
    path.push(childId);
    for (const blockerId of childrenById.get(childId)?.blockerIds ?? []) {
      if (childrenById.has(blockerId)) {
        visit(blockerId);
      }
    }
    path.pop();
    visiting.delete(childId);
    visited.add(childId);
  }

  for (const child of candidate.children) {
    visit(child.id);
  }

  return errors;
}

export function selectRunSpec(
  candidates: readonly SpecCandidate[],
  runSpecIssueId: string | undefined
): SpecCandidate | undefined {
  return runSpecIssueId
    ? candidates.find((candidate) => candidate.id === runSpecIssueId)
    : candidates[0];
}

export function getEligibleChildren(
  children: readonly SpecChild[]
): SpecChild[] {
  const childrenById = new Map(children.map((child) => [child.id, child]));

  return children.filter(
    (child) =>
      child.status === "ready-for-agent" &&
      child.blockerIds.every(
        (blockerId) => childrenById.get(blockerId)?.status === "closed"
      )
  );
}

export function getBlockedReadyChildren(
  children: readonly SpecChild[]
): SpecChild[] {
  const eligibleChildIds = new Set(
    getEligibleChildren(children).map((child) => child.id)
  );

  return children.filter(
    (child) =>
      child.status === "ready-for-agent" && !eligibleChildIds.has(child.id)
  );
}
