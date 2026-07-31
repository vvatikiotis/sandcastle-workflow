import path from "node:path";

export type VerificationWorktreePaths = {
  hostPath: string;
  sandboxPath: string;
};

export function getVerificationWorktreePaths(
  projectRoot: string,
  issueId: string
): VerificationWorktreePaths {
  const hostPath = path.join(
    projectRoot,
    ".sandcastle",
    "worktrees",
    `sandcastle-merger-verify-issue-${issueId}`
  );

  return {
    hostPath,
    sandboxPath: path.posix.join(
      "/home/agent/workspace",
      ".sandcastle",
      "worktrees",
      `sandcastle-merger-verify-issue-${issueId}`
    ),
  };
}
