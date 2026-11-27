# Consumer Guide

This guide explains how to install and run `@vvatikiotis/sandcastle-workflow` in a consuming repository. All shell command snippets use syntax supported by both Bash and Zsh.

## Quick start

These steps install version `0.7.0` in a new pnpm consumer.

1. **Create the repository**

   ```bash
   git init
   pnpm init
   ```

   Skip this step when the consumer repository already exists.

2. **Prepare the consumer**

   Add working, non-empty `test` and `typecheck` scripts to `package.json`. Optionally add a `CODING_STANDARDS.md` file with the project rules agents must follow. Without it, Sandcastle prints an info message and reviewers apply general good practice instead.

3. **Copy and verify the reviewed artifact**

   ```bash
   mkdir vendor
   cp /path/artifacts/vvatikiotis-sandcastle-workflow-0.7.0.tgz vendor/
   ```

   Verify the checksum with the available command:

   ```bash
   if command -v sha256sum >/dev/null 2>&1; then
     sha256sum vendor/vvatikiotis-sandcastle-workflow-0.7.0.tgz
   else
     shasum -a 256 vendor/vvatikiotis-sandcastle-workflow-0.7.0.tgz
   fi
   ```

   Compare the output with the checksum supplied with the reviewed artifact.

4. **Install the workflow**

   ```bash
   pnpm add -D ./vendor/vvatikiotis-sandcastle-workflow-0.7.0.tgz
   ```

5. **Add Sandcastle scripts**

   Add these entries to `package.json`:

   ```json
   {
     "scripts": {
       "sandcastle:setup": "sandcastle-workflow-setup",
       "sandcastle": "sandcastle-workflow",
       "sandcastle:dry-run": "sandcastle-workflow --dry-run"
     }
   }
   ```

6. **Run guided setup**

   ```bash
   pnpm sandcastle:setup
   ```

   It creates missing examples and preserves active configuration that already exists.

7. **Configure runner settings and credentials**

   Edit these files and set the required values, including the agent each role runs and `GH_TOKEN`:

   ```text
   .sandcastle/sandcastle.env
   .sandcastle/.env
   ```

   Log in to each agent you choose on the host before a normal run, as described in [Agents and logins](#agents-and-logins).

   `GH_TOKEN` must contain a GitHub personal access token (PAT) with access to the Consumer Repository and these repository permissions:

   - Metadata: read-only
   - Issues: read and write

   The workflow does not work without this PAT and these permissions.

8. **Optional: expose the ticket-relationship skill**

   Skip this step if you publish specification relationships with GitHub CLI or the GitHub web UI instead of an agent.

   ```bash
   mkdir -p .agents/skills
   ln -s ../../node_modules/@vvatikiotis/sandcastle-workflow/skills/github-ticket-relationships \
     .agents/skills/github-ticket-relationships
   ```

   Add this instruction to `AGENTS.md`:

   ```markdown
   Before publishing child issues for a GitHub spec, load
   `.agents/skills/github-ticket-relationships/SKILL.md` after the spec issue
   exists to create native sub-issue and dependency relationships.
   ```

   Commit the tarball, package manifest, lockfile, `.sandcastle` examples, and, when present, the relative symbolic link, `AGENTS.md`, and `CODING_STANDARDS.md` together. Keep the active `.sandcastle/.env` and `.sandcastle/sandcastle.env` files ignored and uncommitted.

9. **Prepare GitHub work**

   ```bash
   git remote add origin git@github.com:OWNER/REPOSITORY.git
   gh auth status
   ```

   Create the required labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. Then create an eligible standalone issue, or publish and verify a specification with its child and dependency relationships, using the relationship skill, GitHub CLI, or the GitHub web UI.

10. **Build and validate**

   ```bash
   pnpm sandcastle build-image
   pnpm sandcastle:dry-run
   ```

   The dry run checks the consumer and GitHub setup without starting agents.

11. **Run Sandcastle**

   ```bash
   pnpm sandcastle
   ```

   This starts the normal workflow and can launch agents.

## Update

To update an existing consumer, copy the reviewed artifact into `vendor/`, verify its checksum, and install it as the new file dependency:

```bash
VERSION=0.7.0
cp /path/artifacts/vvatikiotis-sandcastle-workflow-${VERSION}.tgz vendor/
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "vendor/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
else
  shasum -a 256 "vendor/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
fi
pnpm add -D "./vendor/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
pnpm sandcastle --help
pnpm sandcastle --version
pnpm sandcastle:setup
pnpm sandcastle build-image
pnpm sandcastle:dry-run
```

Keep the previous tarball in `vendor/` until the update succeeds. If the previous tarball is still present, the command above replaces the existing dependency and updates the lockfile. If the previous tarball is missing, update the manifest directly before installing:

```bash
pnpm pkg set "devDependencies[\"@vvatikiotis/sandcastle-workflow\"]=file:vendor/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
pnpm install
```

Commit the new tarball, package manifest, and lockfile together. Review project guidance for conflicts because an update can change packaged prompts. A new package version also changes the derived Docker image name, so rebuild the image unless `DOCKER_IMAGE` is configured.

## Supported environment

Version `0.7.0` supports:

- Node.js 22 or newer on macOS and Linux
- npm 10 or pnpm 11 repositories
- GitHub.com Issues and native issue relationships
- a current GitHub CLI release that exposes native sub-issue and dependency relationship fields
- Docker sandboxes
- Codex and Claude Code runtime agents, chosen per role

The package is private and local-only. Consumers commit a reviewed tarball under `vendor/` and install it as a development dependency. Collaborators with access to the consumer repository receive that artifact.

## npm installation

The quick start uses pnpm. With npm, install the same reviewed artifact as a relative file dependency:

```bash
npm install --save-dev ./vendor/vvatikiotis-sandcastle-workflow-0.7.0.tgz
```

Use these npm commands in place of the pnpm quick-start commands:

```bash
npm run sandcastle:setup
npm run sandcastle -- build-image
npm run sandcastle:dry-run
npm run sandcastle
```

The setup command uses a portable POSIX shell script, asks before creating active configuration, and runs initialization first.

## Commands and exit statuses

Use the configured pnpm scripts:

```text
pnpm sandcastle
pnpm sandcastle init
pnpm sandcastle eject-dockerfile
pnpm sandcastle build-image
pnpm sandcastle:dry-run
pnpm sandcastle --help
pnpm sandcastle --version
```

The underlying executable's help and version options do not require a Git worktree. Operational commands discover the active Git worktree root and do not change the process working directory.

| Status | Meaning |
| --- | --- |
| `0` | Completed successfully |
| `1` | Aborted, failed safety preflight, or unexpected failure, including a missing agent login, an agent that cannot start, an agent that changed a guarded ref, a Reporter that changed the repository, and a Final Spec Reviewer commit |
| `2` | Invalid command or arguments, or a required work-path choice without an interactive terminal |
| `3` | Stopped safely and requires follow-up, including a failed Integration with its Integration Report |
| `129`, `130`, `143` | SIGHUP, SIGINT, or SIGTERM |

## Concurrent runs

A Consumer Repository supports one active mutating workflow run. A normal run owns `.sandcastle/run.lock`; a second normal run stops without changing workflow state. Normal completion removes the lock. Signals, crashes, and unexpected failures preserve it.

When a lock remains, inspect its recorded process:

```bash
LOCK_PID=$(node -p "JSON.parse(require('fs').readFileSync('.sandcastle/run.lock', 'utf8')).pid")
ps -p "$LOCK_PID" -o pid=,lstart=,command=
```

A listed process still owns the lock; leave it in place. If `ps` reports that the PID does not exist, the lock is stale. For any other parsing or lookup error, leave the lock in place and investigate. Before removing a stale lock, inspect `.sandcastle/worktrees` and the latest log. Remove only `.sandcastle/run.lock`.

`--dry-run`, `--help`, `--version`, initialization, and image building do not use the lock. Repositories have independent locks. New initialization adds `run.lock` to `.sandcastle/.gitignore`.

## Initialize a consumer

This is the non-interactive alternative to quick-start step 6:

```bash
pnpm sandcastle init
```

Run it from the Git root or a nested directory. It creates, without overwriting, `.sandcastle/.gitignore`, `.sandcastle/sandcastle.env.example`, and `.sandcastle/.env.example`. When running it directly, copy both examples to their active ignored names and choose every value explicitly:

```bash
cp .sandcastle/sandcastle.env.example .sandcastle/sandcastle.env
cp .sandcastle/.env.example .sandcastle/.env
```

The runner configuration selects the agent, model, and effort for each role, the maximum iterations, and an optional Docker image. Each example key has a comment with its allowed values and an example value. The agent environment supports `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`; an empty value uses a non-empty host value. Any other key stops normal-run preflight. Initialization does not create active configuration, prompts, Dockerfiles, package scripts, logs, worktrees, or overlays.

## Agents and logins

Each role runs Codex or Claude Code. Set every key in `.sandcastle/sandcastle.env`:

| Role | Agent | Model | Effort |
| --- | --- | --- | --- |
| Implementer | `IMPLEMENTER_AGENT` | `IMPLEMENTER_MODEL` | `IMPLEMENTER_EFFORT` |
| Reviewer | `REVIEWER_AGENT` | `REVIEWER_MODEL` | `REVIEWER_EFFORT` |
| Reporter | `REPORTER_AGENT` | `REPORTER_MODEL` | `REPORTER_EFFORT` |
| Final Spec Reviewer | `FINAL_SPEC_REVIEWER_AGENT` | `FINAL_SPEC_REVIEWER_MODEL` | `FINAL_SPEC_REVIEWER_EFFORT` |

An agent key is `codex` or `claude-code`. It has no default: a missing or empty key fails preflight, and any other value fails preflight with the file and line. For a `claude-code` role, effort must be `low`, `medium`, `high`, `xhigh`, or `max`. Codex effort is passed to Codex unchecked. Roles may mix agents; the Implementer, Reviewer, and Reporter then share one sandbox that holds both logins.

Before any sandbox starts, a normal run checks a login for every agent the configuration uses. A missing login exits with status `1` and names the roles, the agent, and how to log in. `--dry-run` checks no logins. An agent no role uses gets no check, mount, or copy.

- **Codex:** run `codex login` on the host. `~/.codex/auth.json` must be a readable file. The runner mounts `~/.codex` read-only and copies `auth.json`, and `config.toml` when present, into the sandbox.
- **Claude Code with a token:** run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in `.sandcastle/.env`, or leave it empty and set it in the host environment. The token takes precedence: the runner forwards it to the sandbox and does not mount `~/.claude`.
- **Claude Code with `~/.claude`:** without a token, `~/.claude/.credentials.json` must be a readable file, which logging in with `claude` creates on Linux. The runner mounts `~/.claude` read-only and copies `.credentials.json` into the sandbox.

On macOS, Claude Code keeps its login in the Keychain rather than in `~/.claude/.credentials.json`, so use the token there.

If an agent still cannot start in the sandbox, for example because its command is missing from the Docker image or its login expired, the run exits with status `1`. The message names the role, the agent, and how to log in again.

## Consumer contract

Meet this contract before completing quick-start step 10.

The Git root must contain:

- `package.json` with non-empty `test` and `typecheck` scripts
- exactly one supported lockfile
- a GitHub.com `origin` remote and working GitHub CLI authentication
- a GitHub CLI release that supports the native `parent`, `blockedBy`, and `blocking` issue fields; update the CLI if relationship preflight reports an unsupported field
- labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`

`GLOSSARY.md`, project ADRs, `CODING_STANDARDS.md`, `AGENTS.md`, and the relationship skill link are optional. Prompts use them only when present.

- Without a root `CODING_STANDARDS.md`, preflight and the dry run print an info message, and reviewers check standards against general good practice and say so in their review.
- Without a root `AGENTS.md`, preflight and the dry run print an info message.
- To let agents publish specification relationships, link `.agents/skills/github-ticket-relationships` to the installed package skill and add the quick-start step 8 instruction to `AGENTS.md`.

A declared `packageManager` must identify npm 10 or pnpm 11 and match its lockfile. Without a declaration, `package-lock.json` selects npm and `pnpm-lock.yaml` selects pnpm. Both lockfiles, missing lockfiles, npm shrinkwrap, unsupported managers, unsupported majors, and malformed declarations fail preflight.

Sandcastle uses a closed command mapping:

| Purpose | npm 10 | pnpm 11 |
| --- | --- | --- |
| Install | `npm ci` | `pnpm install --frozen-lockfile` |
| Type check | `npm run typecheck` | `pnpm typecheck` |
| Test | `npm test` | `pnpm test` |

Monorepositories are supported only when package metadata, lockfile, configuration, and verification scripts live at the Git root. Windows, GitHub Enterprise, and package-subdirectory operation are unsupported.

## GitHub control plane

Before the dry run in quick-start step 10, complete step 9, which prepares the required GitHub configuration and work. Complete optional step 8 first if an agent will publish specification children. Native GitHub relationships determine all executable work:

- direct sub-issues define a specification's children;
- child-to-child blocking edges define eligibility;
- every child blocks its parent specification;
- one specification is selected per invocation;
- final review runs only after every direct child closes;
- when both ready specification work and eligible standalone issues exist, the run and the dry run ask which work path to follow. Answering needs an interactive terminal; without one, or when input ends before an answer, the run exits with status `2` without starting work;
- a standalone issue with an open blocker is not selected and waits until every blocker closes. Other unblocked standalone issues still run. When every standalone candidate is blocked, the run stops with status `3` and lists the open blockers, and the dry run reports blocked issues as waiting.

Sandcastle validates these relationships and never infers, creates, or repairs them. Version `0.7.0` allows at most 100 simultaneously eligible issues and stops safely when the limit is exceeded. GitHub limits a parent to 100 direct sub-issues.

The package includes the optional Agent Skills-standard `github-ticket-relationships` skill. Step 8 configures it project-locally. The symbolic link makes the skill discoverable, and the `AGENTS.md` instruction tells agents when to use it. Both are needed only when agents publish specification relationships. Initialization prints the installed source path but does not create the link or modify agent settings.

Humans and other tools can create the same graph with GitHub CLI or the GitHub web UI: attach each child natively to its parent, add each approved child dependency from the blocked child, and make every child block its parent. Verify the resulting parent, blockers, and blocking edges before running Sandcastle.

## Integration

Each issue runs in one Docker sandbox on its own worktree for branch `sandcastle/issue-<n>`. The Implementer, Reviewer, Integration, and Reporter share it. No agent mounts the Consumer Repository's main checkout.

After the Reviewer approves, the runner integrates the branch itself:

1. In the sandbox, it detaches HEAD and rebases the branch onto the current Base Branch commit, the branch checked out when the issue started.
2. It runs the install, type check, and test commands on the rebased commit.
3. Only when all three pass does it move `sandcastle/issue-<n>` to the tested commit.
4. On the host, it fast-forwards the Base Branch with `git merge --ff-only`, closes the issue, and deletes the branch.

If the Base Branch moved before the fast-forward, the runner rebases and verifies again, for at most 3 attempts in total. It then stops with status `3`. Before each new attempt the branch goes back to the reviewed commit, so after any failure it still points there. The runner's own Git commands run with `core.hooksPath=/dev/null`, so repository hooks do not run for them; agents' commits still run the hooks.

When the rebase conflicts or a check fails, the runner starts the Reporter. The Reporter changes nothing. It writes an Integration Report: the cause, the commits, files, and line numbers involved, and two or three options, each with the exact Git commands to run from the branch and the recorded Base Branch commit. The runner then aborts the rebase, checks the unchanged branch out again, and publishes the Integration Report three ways:

- a `sandcastle-issue-<n>-integration-report-*.log` file under `.sandcastle/logs/`
- a comment on the issue
- the terminal

The run then stops with status `3`. The branch still points at the reviewed commit, so no work is lost. If the Reporter commits, changes the worktree, or moves a ref, the run aborts with status `1`.

### Ref guard

Before an issue's sandbox starts, the runner records every branch except the issue branch, every tag, `refs/stash`, and the main checkout's `HEAD`. It checks them again after the Implementer, Reviewer, Reporter, and Final Spec Reviewer. If one changed, the run aborts with status `1` and prints each changed ref, its old and new value, and the `git update-ref` or `git symbolic-ref` command that restores it. Sandcastle restores nothing itself. Remote-tracking refs under `refs/remotes/` are not guarded.

A commit on the Base Branch made by anyone while an agent runs also trips the guard. Avoid committing to the Base Branch during a run.

### Final spec review

The Final Spec Reviewer runs in its own sandbox on the temporary branch `sandcastle/final-spec-<n>`, created at the current Base Branch commit. Afterwards the runner deletes the branch, and Sandcastle removes the clean worktree. If the reviewer commits on the branch, the run aborts with status `1`; the commit never reaches the Base Branch, and the branch is kept for inspection. Delete it with `git branch -D sandcastle/final-spec-<n>` before the next final review, which refuses to start while it exists.

## Prompts and project guidance

The package always runs its seven packaged prompts. A consumer may add phase-specific guidance by placing one of these fixed filenames directly under `.sandcastle`:

- `implement-prompt.md`
- `review-prompt.md`
- `report-prompt.md`
- `standalone-implement-prompt.md`
- `standalone-review-prompt.md`
- `standalone-report-prompt.md`
- `final-spec-prompt.md`

Each file supplies only additional project instructions for its matching phase. Sandcastle inserts the contents into the packaged prompt before a final mandatory policy and completion block. Project guidance cannot replace the packaged workflow, selected issue scope, safety rules, attribution rules, or completion protocol.

Guidance files must be readable regular files inside the Git worktree. A symbolic link is accepted only when its resolved target remains inside that worktree. Sandcastle does not interpret placeholders or require packaged prompt markers in project guidance.

Consumers that previously copied a complete packaged prompt into `.sandcastle` must replace that copy with only their additional project instructions. Otherwise, the agent receives a redundant full prompt as project guidance.

## Docker image

Normal runs inspect the image before the first agent launch and never build it automatically.

Without `DOCKER_IMAGE`, the package derives `sandcastle:<project>-v<package-version>`. Repositories with the same directory name can collide; set `DOCKER_IMAGE` to avoid that rare case. An overlong generated tag fails rather than being truncated or hashed.

The packaged Dockerfile uses its own minimal build context. A contained `.sandcastle/Dockerfile` override takes precedence and uses the Git root as context.

The default Dockerfile installs `@openai/codex@latest` and `@anthropic-ai/claude-code@latest`. Rebuilds can install a different release, while Docker caching can retain an older one. The package version therefore does not identify the installed Codex or Claude Code version. Sandcastle does not disable Docker cache, attest image contents, or pin either agent automatically.

### Eject and customize the Dockerfile

Create a Consumer Repository-owned copy of the packaged Dockerfile:

```bash
pnpm sandcastle eject-dockerfile
```

With npm, use:

```bash
npm run sandcastle -- eject-dockerfile
```

Run the command from the Git root or any nested directory. It creates `.sandcastle/Dockerfile` only when that file is absent and never overwrites an existing override. The copied file includes comments describing the required runtime capabilities and customization boundaries.

The project Dockerfile is a complete replacement, not an extension of the packaged Dockerfile. You may change the base image, installed operating-system packages, tool versions, or add other runtimes. Preserve Node.js 22 or newer, the Consumer Repository's package manager (npm 10 or pnpm 11), the `git` and `gh` commands, the `codex` command when a role runs Codex and the `claude` command when a role runs Claude Code, agent access to `/home/agent/workspace`, UID/GID build arguments, and a long-running container entrypoint. Rebuild the image after every change:

```bash
pnpm sandcastle build-image
```

An npm consumer uses `npm run sandcastle -- build-image`. Updating the workflow package does not replace an existing `.sandcastle/Dockerfile`; review the packaged default manually and merge relevant changes into the Consumer Repository override when needed.

Agents must not change any file named `Dockerfile` in a Consumer Repository. After the implementer and reviewer phases, Sandcastle compares the branch commits, and before the fast-forward it checks the whole rebased branch. If a phase changed a Dockerfile, Sandcastle writes a prominent `ABORTING RUN` banner and the affected paths to that phase's log, then aborts with an error before starting the next phase or updating the base branch. A maintainer must inspect the branch and make Dockerfile changes outside an agent run.

## State and security

Workflow-owned state remains under `.sandcastle`: logs, issue worktrees, dependency overlays, and the active-run lock. Normal runs enforce owner-only permissions on those directories (`0700`) and on new log and lock files (`0600`). These permissions protect against other local users, not agents that receive the project-root mount.

Logs and agent sessions may contain agent messages, commands, source or issue content, local paths, and any credential an agent prints. Sandcastle copies each agent's session back to the host: Codex sessions under `~/.codex/sessions` and Claude Code sessions under `~/.claude/projects`. Sandcastle does not intentionally include `GH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in its diagnostics, but it does not redact arbitrary agent output or dependency errors. Define access, backup, retention, and deletion practices accordingly.

### Log retention and cleanup

Sandcastle retains logs until the Consumer Repository owner removes them. Before cleanup, confirm that no run is active and review the files:

```bash
test ! -e .sandcastle/run.lock
find .sandcastle/logs -type f -name 'sandcastle-*.log' -print
```

Then remove only Sandcastle logs:

```bash
find .sandcastle/logs -type f -name 'sandcastle-*.log' -exec rm -- {} +
```

This does not remove worktrees, overlays, locks, configuration, or credentials. Manage `~/.codex/sessions` and `~/.claude/projects` separately because they are shared with Codex and Claude Code activity outside this workflow.

The installed package is read-only, but agent containers receive writable worktrees, network access, `GH_TOKEN`, and a copy of each login the configuration uses. Users remain responsible for token scope, Docker trust, project Dockerfiles, network exposure, and agent-generated changes. Host Git, recovery, and cleanup use absolute host paths; prompts and dependency mounts use `/home/agent/workspace/...` paths.

## Upgrade

Version `0.7.0` uses `GLOSSARY.md` for project terminology in the packaged prompts. If your repository previously used `CONTEXT.md` for this purpose, rename it to `GLOSSARY.md`.

Copy the replacement artifact into `vendor/` and verify its checksum. Set `VERSION` to the new version, install the new file dependency, and then remove the old artifact. Qualify the upgrade before a normal run:

```bash
VERSION=x.y.z
pnpm add -D "./vendor/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
pnpm sandcastle --help
pnpm sandcastle --version
pnpm sandcastle:setup
pnpm sandcastle build-image
pnpm sandcastle:dry-run
```

Commit the artifact, `package.json`, and lockfile together. Review project guidance for conflicts because an upgrade can change packaged prompts. A new package version changes the derived Docker image name, so build the new image unless `DOCKER_IMAGE` is configured.
