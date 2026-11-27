import { runnerGitPrefix } from "./git-state.ts";

// Integration runs its commands inside the issue sandbox, which mounts the
// issue worktree and the repository's Git directory, never the main checkout.
type SandboxExec = {
  exec: (
    command: string,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

export type VerificationCommands = {
  install: string;
  typecheck: string;
  test: string;
};

// "verified": the issue branch now points at the tested rebased commit and
// HEAD is attached to it again. Otherwise the issue branch is unchanged: a
// conflict leaves the rebase in progress and a failed verification leaves HEAD
// detached at the rebased commit, so the Reporter can inspect either.
type RebaseOutcome =
  | { kind: "verified"; commit: string }
  | { kind: "conflict"; detail: string }
  | { kind: "verification-failed"; detail: string };

// Appends a command transcript to the Integration log.
export type IntegrationLog = (text: string) => Promise<void>;

const gitCommand = `git ${runnerGitPrefix.join(" ")}`;
const outputTailLines = 40;

async function execLogged(
  sandbox: SandboxExec,
  command: string,
  log: IntegrationLog,
): Promise<{ exitCode: number; output: string; stdout: string }> {
  const result = await sandbox.exec(command);
  const output = `${result.stdout}${result.stderr}`;
  let transcript = `$ ${command}\n${output}`;
  if (output !== "" && !output.endsWith("\n")) {
    transcript += "\n";
  }
  await log(`${transcript}[exit ${result.exitCode}]\n`);
  return { exitCode: result.exitCode, output, stdout: result.stdout };
}

async function execOrThrow(
  sandbox: SandboxExec,
  command: string,
  log: IntegrationLog,
): Promise<string> {
  const result = await execLogged(sandbox, command, log);
  if (result.exitCode !== 0) {
    throw new Error(
      `Integration command failed in the issue sandbox with exit status ${result.exitCode}: ${command}\n${result.output.trim()}`,
    );
  }
  return result.stdout.trim();
}

function tail(output: string): string {
  return output.trimEnd().split("\n").slice(-outputTailLines).join("\n");
}

async function isRebaseInProgress(sandbox: SandboxExec): Promise<boolean> {
  const result = await sandbox.exec(
    `test -d "$(${gitCommand} rev-parse --git-path rebase-merge)" || test -d "$(${gitCommand} rev-parse --git-path rebase-apply)"`,
  );
  return result.exitCode === 0;
}

async function describeConflict(
  sandbox: SandboxExec,
  branch: string,
  onto: string,
  log: IntegrationLog,
): Promise<string> {
  const files = await execOrThrow(
    sandbox,
    `${gitCommand} diff --name-only --diff-filter=U`,
    log,
  );
  const stoppedAt = await execOrThrow(
    sandbox,
    `${gitCommand} log -1 --format='%H %s' REBASE_HEAD`,
    log,
  );
  return `Rebasing ${branch} onto ${onto} stopped at commit ${stoppedAt} with conflicts in: ${files.split("\n").filter(Boolean).join(", ")}.`;
}

// Rebases the issue branch onto `onto` on a detached HEAD, then installs,
// typechecks, and tests the result. The branch moves only after every check
// passes. Throws when a step fails for a reason other than a conflict or a
// failed check, such as uncommitted changes before the rebase.
export async function rebaseAndVerify(
  sandbox: SandboxExec,
  {
    branch,
    onto,
    commands,
    log,
  }: {
    branch: string;
    onto: string;
    commands: VerificationCommands;
    log: IntegrationLog;
  },
): Promise<RebaseOutcome> {
  const changes = await execOrThrow(sandbox, `${gitCommand} status --porcelain`, log);
  if (changes !== "") {
    throw new Error(
      `The issue worktree for ${branch} has uncommitted changes before Integration:\n${changes}`,
    );
  }
  const reviewedCommit = await execOrThrow(
    sandbox,
    `${gitCommand} rev-parse --verify refs/heads/${branch}`,
    log,
  );

  await execOrThrow(sandbox, `${gitCommand} checkout --quiet --detach`, log);
  const rebase = await execLogged(sandbox, `${gitCommand} rebase --quiet ${onto}`, log);
  if (rebase.exitCode !== 0) {
    if (!(await isRebaseInProgress(sandbox))) {
      throw new Error(
        `Rebasing ${branch} onto ${onto} failed without a conflict:\n${rebase.output.trim()}`,
      );
    }
    return {
      kind: "conflict",
      detail: await describeConflict(sandbox, branch, onto, log),
    };
  }

  for (const [step, command] of [
    ["install", commands.install],
    ["typecheck", commands.typecheck],
    ["test", commands.test],
  ] as const) {
    const result = await execLogged(sandbox, command, log);
    if (result.exitCode !== 0) {
      return {
        kind: "verification-failed",
        detail: `The ${step} step \`${command}\` failed with exit status ${result.exitCode} on ${branch} rebased onto ${onto}. Last output:\n${tail(result.output)}`,
      };
    }
  }

  const leftovers = await execOrThrow(sandbox, `${gitCommand} status --porcelain`, log);
  if (leftovers !== "") {
    return {
      kind: "verification-failed",
      detail: `Verification of ${branch} rebased onto ${onto} left uncommitted changes in the issue worktree:\n${leftovers}`,
    };
  }

  const commit = await execOrThrow(sandbox, `${gitCommand} rev-parse --verify HEAD`, log);
  await execOrThrow(
    sandbox,
    `${gitCommand} update-ref refs/heads/${branch} ${commit} ${reviewedCommit}`,
    log,
  );
  await execOrThrow(sandbox, `${gitCommand} symbolic-ref HEAD refs/heads/${branch}`, log);
  return { kind: "verified", commit };
}

// Aborts an unfinished rebase and checks the unchanged issue branch out again.
// The worktree was clean before Integration and the Reporter is checked to
// change nothing, so a forced checkout discards only verification output.
export async function restoreIssueBranch(
  sandbox: SandboxExec,
  branch: string,
  log: IntegrationLog,
): Promise<void> {
  if (await isRebaseInProgress(sandbox)) {
    await execOrThrow(sandbox, `${gitCommand} rebase --abort`, log);
  }
  await execOrThrow(sandbox, `${gitCommand} checkout --quiet --force ${branch}`, log);
}

// Moves the issue branch from a verified rebase back to the reviewed commit,
// after the Base Branch moved before that rebase could be fast-forwarded.
export async function resetIssueBranch(
  sandbox: SandboxExec,
  {
    branch,
    from,
    to,
    log,
  }: { branch: string; from: string; to: string; log: IntegrationLog },
): Promise<void> {
  await execOrThrow(sandbox, `${gitCommand} checkout --quiet --detach`, log);
  await execOrThrow(
    sandbox,
    `${gitCommand} update-ref refs/heads/${branch} ${to} ${from}`,
    log,
  );
  await execOrThrow(sandbox, `${gitCommand} checkout --quiet ${branch}`, log);
}

// Captures HEAD, the issue branch, the rebase state, staged and unstaged
// changes, and untracked file contents, so the runner can tell whether an
// agent changed the issue worktree.
export async function fingerprintWorktree(
  sandbox: SandboxExec,
  branch: string,
): Promise<string> {
  const command = [
    `${gitCommand} rev-parse HEAD`,
    `{ ${gitCommand} symbolic-ref --quiet HEAD || true; }`,
    `${gitCommand} rev-parse --verify refs/heads/${branch}`,
    `{ ls -a "$(${gitCommand} rev-parse --git-path rebase-merge)" "$(${gitCommand} rev-parse --git-path rebase-apply)" 2>/dev/null || true; }`,
    `${gitCommand} status --porcelain=v2 --untracked-files=all`,
    `${gitCommand} diff --binary`,
    `${gitCommand} diff --cached --binary`,
    `{ ${gitCommand} ls-files -z --others --exclude-standard | xargs -0 -r ${gitCommand} hash-object --; }`,
  ].join(" && ");
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not inspect the issue worktree for ${branch}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}
