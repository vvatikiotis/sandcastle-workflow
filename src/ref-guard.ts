import type { GitState, RefValue } from "./git-state.ts";

// A guarded ref whose value differs from the snapshot. `before` or `after`
// is undefined when the ref was created or deleted.
export type RefChange = {
  ref: string;
  before: string | undefined;
  after: string | undefined;
};

export type RefGuard = {
  // Changed guarded refs since the snapshot, or an empty list.
  check: () => Promise<RefChange[]>;
};

// Snapshots the branches, tags, stash, and main checkout's HEAD that no agent
// may change. The refs a run owns, such as its issue branch, are excluded;
// remote-tracking refs are never guarded.
export async function snapshotGuardedRefs(
  git: GitState,
  excludedBranches: readonly string[],
): Promise<RefGuard> {
  const excluded = new Set(
    excludedBranches.map((branch) => `refs/heads/${branch}`),
  );
  const read = async (): Promise<Map<string, string>> =>
    new Map(
      (await git.listGuardedRefs())
        .filter(({ ref }) => !excluded.has(ref))
        .map(({ ref, value }: RefValue) => [ref, value]),
    );
  const before = await read();

  return {
    async check(): Promise<RefChange[]> {
      const after = await read();
      const refs = [...new Set([...before.keys(), ...after.keys()])].sort();
      return refs
        .map((ref) => ({ ref, before: before.get(ref), after: after.get(ref) }))
        .filter((change) => change.before !== change.after);
    },
  };
}

function restoreCommand({ ref, before }: RefChange): string {
  if (before === undefined) {
    return `git update-ref -d ${ref}`;
  }
  if (ref === "HEAD") {
    return before.startsWith("ref: ")
      ? `git symbolic-ref HEAD ${before.slice("ref: ".length)}`
      : `git update-ref --no-deref HEAD ${before}`;
  }
  return `git update-ref ${ref} ${before}`;
}

// Lists each change as old → new with the command that restores it. The
// runner restores nothing itself.
export function formatRefChanges(
  phase: string,
  changes: readonly RefChange[],
): string {
  const lines = changes.flatMap((change) => [
    `- ${change.ref}: ${change.before ?? "(absent)"} → ${change.after ?? "(absent)"}`,
    `    ${restoreCommand(change)}`,
  ]);
  return `ABORTING RUN: guarded refs changed during the ${phase}. Sandcastle restores nothing; review each change, then run its restore command:\n${lines.join("\n")}`;
}
