# Consumer Guide

This guide explains how to install and run `@vvatikiotis/sandcastle-workflow` in a consuming repository. All shell command snippets use syntax supported by both Bash and Zsh.

## Quick start

These steps install version `0.5.0` in a new pnpm consumer.

1. **Create the repository**

   ```bash
   git init
   pnpm init
   ```

   Skip this step when the consumer repository already exists.

2. **Prepare the consumer**

   Add working, non-empty `test` and `typecheck` scripts to `package.json`. Add a `CODING_STANDARDS.md` file with the project rules agents must follow.

3. **Copy and verify the reviewed artifact**

   ```bash
   mkdir vendor
   cp /path/artifacts/vvatikiotis-sandcastle-workflow-0.5.0.tgz vendor/
   ```

   Verify the checksum with the available command:

   ```bash
   if command -v sha256sum >/dev/null 2>&1; then
     sha256sum vendor/vvatikiotis-sandcastle-workflow-0.5.0.tgz
   else
     shasum -a 256 vendor/vvatikiotis-sandcastle-workflow-0.5.0.tgz
   fi
   ```

   Compare the output with the checksum supplied with the reviewed artifact.

4. **Install the workflow**

   ```bash
   pnpm add -D ./vendor/vvatikiotis-sandcastle-workflow-0.5.0.tgz
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

   Edit these files and set the required values, including `GH_TOKEN`:

   ```text
   .sandcastle/sandcastle.env
   .sandcastle/.env
   ```

   `GH_TOKEN` must contain a GitHub personal access token (PAT) with access to the Consumer Repository and these repository permissions:

   - Metadata: read-only
   - Issues: read and write

   The workflow does not work without this PAT and these permissions.

8. **Expose the ticket-relationship skill**

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

   Commit the tarball, package manifest, lockfile, `.sandcastle` examples, relative symbolic link, `AGENTS.md`, and `CODING_STANDARDS.md` together. Keep the active `.sandcastle/.env` and `.sandcastle/sandcastle.env` files ignored and uncommitted.

9. **Prepare GitHub work**

   ```bash
   git remote add origin git@github.com:OWNER/REPOSITORY.git
   gh auth status
   ```

   Create the required labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. Then create an eligible standalone issue, or use the installed relationship skill to publish and verify a specification with its child and dependency relationships.

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
VERSION=0.5.0
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

Version `0.5.0` supports:

- Node.js 22 or newer on macOS and Linux
- npm 10 or pnpm 11 repositories
- GitHub.com Issues and native issue relationships
- a current GitHub CLI release that exposes native sub-issue and dependency relationship fields
- Docker sandboxes
- Codex runtime agents

The package is private and local-only. Consumers commit a reviewed tarball under `vendor/` and install it as a development dependency. Collaborators with access to the consumer repository receive that artifact.

## npm installation

The quick start uses pnpm. With npm, install the same reviewed artifact as a relative file dependency:

```bash
npm install --save-dev ./vendor/vvatikiotis-sandcastle-workflow-0.5.0.tgz
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
| `1` | Aborted, failed safety preflight, or unexpected failure |
| `2` | Invalid command or arguments |
| `3` | Stopped safely and requires follow-up |
| `129`, `130`, `143` | SIGHUP, SIGINT, or SIGTERM |

## Concurrent runs

A Consumer Repository supports one active mutating workflow run. A normal run owns `.sandcastle/run.lock`; a second normal run stops without changing workflow state. Normal completion removes the lock. Signals, crashes, and unexpected failures preserve it.

When a lock remains, inspect its recorded process:

```bash
LOCK_PID=$(node -p "JSON.parse(require('fs').readFileSync('.sandcastle/run.lock', 'utf8')).pid")
ps -p "$LOCK_PID" -o pid=,lstart=,command=
```

A listed process still owns the lock; leave it in place. If `ps` reports that the PID does not exist, the lock is stale. For any other parsing or lookup error, leave the lock in place and investigate. Before removing a stale lock, inspect `.sandcastle/merger-recovery.json`, `.sandcastle/worktrees`, and the latest log, preserving any recovery state for the next run. Remove only `.sandcastle/run.lock`.

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

The runner configuration selects models, effort, maximum iterations, and an optional Docker image. The agent environment supports only `GH_TOKEN`; an empty declaration uses a non-empty host value. Any other key stops normal-run preflight. Initialization does not create active configuration, prompts, Dockerfiles, package scripts, logs, worktrees, overlays, or recovery state.

## Consumer contract

Meet this contract before completing quick-start step 10.

The Git root must contain:

- `package.json` with non-empty `test` and `typecheck` scripts
- exactly one supported lockfile
- `CODING_STANDARDS.md`
- `.agents/skills/github-ticket-relationships` linked to the installed package skill
- `AGENTS.md` with the instruction that tells agents when to load that skill
- a GitHub.com `origin` remote and working GitHub CLI authentication
- a GitHub CLI release that supports the native `parent`, `blockedBy`, and `blocking` issue fields; update the CLI if relationship preflight reports an unsupported field
- labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`

`CONTEXT.md` and project ADRs are optional. Prompts use them only when present.

A declared `packageManager` must identify npm 10 or pnpm 11 and match its lockfile. Without a declaration, `package-lock.json` selects npm and `pnpm-lock.yaml` selects pnpm. Both lockfiles, missing lockfiles, npm shrinkwrap, unsupported managers, unsupported majors, and malformed declarations fail preflight.

Sandcastle uses a closed command mapping:

| Purpose | npm 10 | pnpm 11 |
| --- | --- | --- |
| Install | `npm ci` | `pnpm install --frozen-lockfile` |
| Type check | `npm run typecheck` | `pnpm typecheck` |
| Test | `npm test` | `pnpm test` |

Monorepositories are supported only when package metadata, lockfile, configuration, and verification scripts live at the Git root. Windows, GitHub Enterprise, and package-subdirectory operation are unsupported.

## GitHub control plane

Before the dry run in quick-start step 10, complete steps 8 and 9. Step 8 makes the relationship skill discoverable before an agent publishes specification children; step 9 prepares the required GitHub configuration and work. Native GitHub relationships determine all executable work:

- direct sub-issues define a specification's children;
- child-to-child blocking edges define eligibility;
- every child blocks its parent specification;
- one specification is selected per invocation;
- final review runs only after every direct child closes.

Sandcastle validates these relationships and never infers, creates, or repairs them. Version `0.5.0` allows at most 100 simultaneously eligible issues and stops safely when the limit is exceeded. GitHub limits a parent to 100 direct sub-issues.

The package includes the required Agent Skills-standard `github-ticket-relationships` skill. Step 8 configures it project-locally. The symbolic link makes the skill discoverable, and the `AGENTS.md` instruction tells agents when to use it. Both are required consumer setup. Initialization prints the installed source path but does not create the link or modify agent settings.

Humans and other tools can create the same graph with GitHub CLI: attach each child natively to its parent, add each approved child dependency from the blocked child, and make every child block its parent. Verify the resulting parent, blockers, and blocking edges before running Sandcastle.

## Prompts and project guidance

The package always runs its seven built-in prompts. A consumer may add phase-specific guidance by placing one of these fixed filenames directly under `.sandcastle`:

- `implement-prompt.md`
- `review-prompt.md`
- `merge-prompt.md`
- `standalone-implement-prompt.md`
- `standalone-review-prompt.md`
- `standalone-merge-prompt.md`
- `final-spec-prompt.md`

Each file supplies only additional project instructions for its matching phase. Sandcastle inserts the contents into the packaged prompt before a final mandatory policy and completion block. Project guidance cannot replace the packaged workflow, selected issue scope, safety rules, attribution rules, or completion protocol.

Guidance files must be readable regular files inside the Git worktree. A symbolic link is accepted only when its resolved target remains inside that worktree. Sandcastle does not interpret placeholders or require packaged prompt markers in project guidance.

Consumers that previously copied a complete built-in prompt into `.sandcastle` must replace that copy with only their additional project instructions. Otherwise, the agent receives a redundant full prompt as project guidance.

## Docker image

Normal runs inspect the image before the first agent launch and never build it automatically.

Without `DOCKER_IMAGE`, the package derives `sandcastle:<project>-v<package-version>`. Repositories with the same directory name can collide; set `DOCKER_IMAGE` to avoid that rare case. An overlong generated tag fails rather than being truncated or hashed.

The packaged Dockerfile uses its own minimal build context. A contained `.sandcastle/Dockerfile` override takes precedence and uses the Git root as context.

The default Dockerfile installs `@openai/codex@latest`. Rebuilds can install a different release, while Docker caching can retain an older one. The package version therefore does not identify the installed Codex version. Sandcastle does not disable Docker cache, attest image contents, or pin Codex automatically.

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

The project Dockerfile is a complete replacement, not an extension of the packaged Dockerfile. You may change the base image, installed operating-system packages, tool versions, or add other runtimes. Preserve Node.js 22 or newer, the Consumer Repository's package manager (npm 10 or pnpm 11), the `codex`, `git`, and `gh` commands, agent access to `/home/agent/workspace`, UID/GID build arguments, and a long-running container entrypoint. Rebuild the image after every change:

```bash
pnpm sandcastle build-image
```

An npm consumer uses `npm run sandcastle -- build-image`. Updating the workflow package does not replace an existing `.sandcastle/Dockerfile`; review the packaged default manually and merge relevant changes into the Consumer Repository override when needed.

## State and security

Workflow-owned state remains under `.sandcastle`: logs, issue worktrees, dependency overlays, merger recovery state, and the active-run lock. Normal runs enforce owner-only permissions on those directories (`0700`) and on new log, lock, and recovery files (`0600`). These permissions protect against other local users, not agents that receive the project-root mount.

Logs and Codex sessions may contain agent messages, commands, source or issue content, local paths, and any credential an agent prints. Sandcastle does not intentionally include `GH_TOKEN` in its diagnostics, but it does not redact arbitrary agent output or dependency errors. Define access, backup, retention, and deletion practices accordingly. Recovery state contains branch names and an absolute host worktree path, not credentials or source content.

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

This does not remove worktrees, overlays, locks, recovery markers, configuration, or credentials. Manage `~/.codex/sessions` separately because it is shared with Codex activity outside this workflow.

The installed package is read-only, but agent containers receive writable worktrees, network access, and `GH_TOKEN`. Users remain responsible for token scope, Docker trust, project Dockerfiles, network exposure, and agent-generated changes. Host Git, recovery, and cleanup use absolute host paths; prompts and dependency mounts use `/home/agent/workspace/...` paths.

## Upgrade

Version `0.5.0` requires no consumer migration action. The packaged CLI is now minified and mangled without changing its commands or runtime behavior.

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
