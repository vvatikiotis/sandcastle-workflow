// A fake @ai-hero/sandcastle module for the packed-CLI tests. Like the real
// SDK, createSandbox() checks out the branch in a Git worktree beneath
// .sandcastle/worktrees, exec() runs commands in that worktree, and close()
// removes a clean worktree and preserves a dirty one. Agents are simulated:
// environment variables choose what each role does.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const agentIdentity = {
  GIT_AUTHOR_NAME: "Fake Agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "Fake Agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

function capture(value) {
  appendFileSync(process.env.FAKE_SANDCASTLE_CAPTURE, JSON.stringify(value) + "\n");
}

// Sandcastle's own git commands, which are not the runner's or an agent's.
function sandcastleGit(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// Agent git commands keep the repository's hooks.
function agentGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...agentIdentity },
  }).trim();
}

function commitFile(worktree, filePath, contents, message) {
  const target = path.join(worktree, filePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  agentGit(worktree, ["add", "--", filePath]);
  agentGit(worktree, ["commit", "--quiet", "-m", message]);
}

// "<role>:<value>" settings apply to one role only.
function settingFor(variable, role) {
  const setting = process.env[variable];
  if (!setting) return undefined;
  const separator = setting.indexOf(":");
  return setting.slice(0, separator) === role
    ? setting.slice(separator + 1)
    : undefined;
}

function roleOf(name) {
  for (const role of ["final-spec-reviewer", "implementer", "reviewer", "reporter"]) {
    if (name.includes(role)) return role;
  }
  throw new Error("fake Sandcastle: unknown agent " + name);
}

function verificationStep(command) {
  if (/^(npm ci|pnpm install)\b/.test(command)) return "install";
  if (/^(npm run typecheck|pnpm typecheck)\b/.test(command)) return "typecheck";
  if (/^(npm|pnpm) test\b/.test(command)) return "test";
  return undefined;
}

function countFile(name) {
  return process.env.FAKE_SANDCASTLE_CAPTURE + "." + name;
}

function increment(name) {
  let count = 0;
  try {
    count = Number(readFileSync(countFile(name), "utf8"));
  } catch {}
  count += 1;
  writeFileSync(countFile(name), String(count));
  return count;
}

export function codex(model, options) {
  return { provider: "codex", model, options };
}

export function claudeCode(model, options) {
  return { provider: "claude-code", model, options };
}

export async function createSandbox(options) {
  const repository = options.cwd;
  try {
    sandcastleGit(repository, ["rev-parse", "--verify", "--quiet", "refs/heads/" + options.branch]);
  } catch {
    sandcastleGit(repository, ["branch", options.branch]);
  }
  const worktreePath = path.join(
    repository,
    ".sandcastle",
    "worktrees",
    options.branch.replaceAll("/", "-"),
  );
  sandcastleGit(repository, ["worktree", "add", "--quiet", worktreePath, options.branch]);
  capture({
    type: "sandbox",
    branch: options.branch,
    hooks: options.hooks,
    env: options.sandbox.env,
    mounts: options.sandbox.mounts,
  });

  async function runAgent(runOptions) {
    const role = roleOf(runOptions.name);
    const issueId = runOptions.promptArgs.ISSUE_ID;
    capture({
      type: "phase",
      name: runOptions.name,
      promptArgs: runOptions.promptArgs,
      promptFile: runOptions.promptFile,
      logMode: statSync(runOptions.logging.path).mode & 0o777,
      verbose: runOptions.logging.verbose,
      agent: runOptions.agent,
    });

    // Like Sandcastle when the agent command fails, for example because the
    // CLI is missing from the image or its login expired.
    if (settingFor("FAKE_AGENT_START_FAILURE", role) !== undefined) {
      throw new Error(`${runOptions.agent.provider} exited with code 127:\nsh: 1: ${settingFor("FAKE_AGENT_START_FAILURE", role)}: not found`);
    }

    const changedFile = settingFor("FAKE_AGENT_FILE_CHANGE", role);
    if (changedFile) {
      commitFile(worktreePath, changedFile, "FROM scratch\n", `sandcastle(${role}): #${issueId}: fake change`);
    } else if (role === "implementer") {
      commitFile(
        worktreePath,
        process.env.FAKE_IMPLEMENTER_FILE ?? `src/issue-${issueId}.js`,
        process.env.FAKE_IMPLEMENTER_CONTENTS ?? "export {};\n",
        `sandcastle(implementer): #${issueId}: fake implementation`,
      );
    }
    const updatedRef = settingFor("FAKE_AGENT_UPDATE_REF", role);
    if (updatedRef) {
      agentGit(worktreePath, ["update-ref", updatedRef, "HEAD"]);
    }

    switch (role) {
      case "implementer":
        return { stdout: "<phase-outcome>implemented</phase-outcome>\n<promise>COMPLETE</promise>" };
      case "reviewer":
        return { stdout: "<phase-outcome>approved</phase-outcome>\n<promise>COMPLETE</promise>" };
      case "reporter": {
        const action = process.env.FAKE_REPORTER_ACTION;
        if (action === "commit") {
          agentGit(worktreePath, ["commit", "--quiet", "--allow-empty", "-m", "reporter commit"]);
        } else if (action === "dirty") {
          writeFileSync(path.join(worktreePath, "reporter-notes.txt"), "notes\n");
        }
        const report = [
          `Cause: ${runOptions.promptArgs.FAILURE_KIND} for issue #${issueId}.`,
          `Detail: ${runOptions.promptArgs.FAILURE_DETAIL}`,
          "Option 1: resolve the conflict by hand.",
          `  git switch ${runOptions.promptArgs.BRANCH}`,
          `  git rebase ${runOptions.promptArgs.BASE_COMMIT}`,
        ].join("\n");
        return {
          stdout: `<integration-report>\n${report}\n</integration-report>\n<phase-outcome>reported</phase-outcome>\n<promise>COMPLETE</promise>`,
        };
      }
      case "final-spec-reviewer": {
        const outcome = process.env.FAKE_FINAL_REVIEW_OUTCOME ?? "closed";
        if (outcome === "closed" && !process.env.FAKE_FINAL_REVIEW_SKIP_CLOSE) {
          execFileSync("gh", ["issue", "close", runOptions.promptArgs.SPEC_ISSUE_ID], { cwd: repository });
        }
        const detail = outcome === "closed" ? "" : `<phase-detail>fake ${outcome}</phase-detail>\n`;
        return { stdout: `<phase-outcome>${outcome}</phase-outcome>\n${detail}<promise>COMPLETE</promise>` };
      }
    }
  }

  return {
    branch: options.branch,
    worktreePath,
    run: runAgent,
    async exec(command) {
      capture({ type: "exec", command });
      const step = verificationStep(command);
      if (step !== undefined) {
        if (step === "test" && process.env.FAKE_MOVE_BASE_ON_TEST) {
          const times = Number(process.env.FAKE_MOVE_BASE_ON_TEST);
          if (increment("base-moves") <= times) {
            // "<path>:<contents>" makes the moving commit change a file.
            const moveFile = process.env.FAKE_BASE_MOVE_FILE;
            if (moveFile) {
              const [filePath, contents] = moveFile.split(":");
              writeFileSync(path.join(repository, filePath), contents + "\n");
              sandcastleGit(repository, ["add", "--", filePath]);
            }
            sandcastleGit(repository, ["commit", "--quiet", "--allow-empty", "-m", "base moves on"]);
          }
        }
        if (step === "test" && process.env.FAKE_TEST_WRITES) {
          writeFileSync(path.join(worktreePath, process.env.FAKE_TEST_WRITES), "test output\n");
        }
        if (process.env.FAKE_VERIFY_FAIL === step) {
          return { exitCode: 1, stdout: "", stderr: `fake ${step} failure at src/broken.js:3\n` };
        }
        return { exitCode: 0, stdout: `fake ${step} passed\n`, stderr: "" };
      }
      const result = spawnSync("sh", ["-c", command], {
        cwd: worktreePath,
        encoding: "utf8",
        env: { ...process.env, ...agentIdentity },
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
    async close() {
      const status = sandcastleGit(worktreePath, ["status", "--porcelain"]);
      if (status !== "") {
        return { preservedWorktreePath: worktreePath };
      }
      sandcastleGit(repository, ["worktree", "remove", worktreePath]);
      return {};
    },
  };
}

// Head mode mounts the main working tree; no workflow phase may use it.
export async function run(options) {
  capture({ type: "head-run", name: options.name });
  throw new Error("fake Sandcastle: run() mounts the main working tree");
}
