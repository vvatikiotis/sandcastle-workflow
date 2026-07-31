# Consumer Guide

This guide explains how to install and run `@vvatikiotis/sandcastle-workflow` in a consuming repository.

## Supported environment

Version `0.1.1` supports:

- Node.js 22 or newer on macOS and Linux
- npm 10 or pnpm 11 repositories
- GitHub.com Issues and native issue relationships
- Docker sandboxes
- Codex runtime agents

The package is local-only. Consumers commit a reviewed tarball under `vendor/` and install it as a development dependency.

## Install a reviewed tarball

Copy the artifact into the consuming repository:

```text
vendor/vvatikiotis-sandcastle-workflow-0.1.1.tgz
```

With pnpm:

```bash
pnpm add -D ./vendor/vvatikiotis-sandcastle-workflow-0.1.1.tgz
```

With npm:

```bash
npm install --save-dev ./vendor/vvatikiotis-sandcastle-workflow-0.1.1.tgz
```

The relative file dependency keeps clean installs independent of an adjacent package checkout. Commit the tarball, package manifest, and lockfile together. Initialization never edits consumer package metadata.

An optional project script can provide a shorter command:

```json
{
  "scripts": {
    "sandcastle": "sandcastle-workflow",
    "sandcastle:dry-run": "sandcastle-workflow --dry-run"
  }
}
```

## Commands and exit statuses

```text
sandcastle-workflow
sandcastle-workflow init
sandcastle-workflow build-image
sandcastle-workflow --dry-run
sandcastle-workflow --help
sandcastle-workflow --version
```

Help and version work outside Git. All operational commands discover the active Git worktree root and do not change the process working directory.

| Status | Meaning |
| --- | --- |
| `0` | Completed successfully |
| `1` | Aborted, failed safety preflight, or unexpected failure |
| `2` | Invalid command or arguments |
| `3` | Stopped safely and requires follow-up |
| `129`, `130`, `143` | SIGHUP, SIGINT, or SIGTERM |

## Concurrent runs

A Consumer Repository supports one active mutating workflow run. Before cleanup, recovery, branch changes, issue changes, or agent launch, a normal run exclusively creates `.sandcastle/run.lock`. A second normal run stops without changing workflow state.

The lock records the host process ID and UTC start time. Normal completion removes it. Signals, crashes, and unexpected failures preserve it because child processes or recovery work may still exist. Inspect the recorded process and workflow state before manually removing a confirmed-stale lock. Never remove a live run's lock.

Read-only `--dry-run`, `--help`, and `--version` do not acquire or remove the lock. Initialization and image building also remain outside the workflow lock.

Different Consumer Repositories have independent locks and may run concurrently. If their directory names are the same, their derived Docker image names collide. Configure a distinct `DOCKER_IMAGE` in each repository before building images or running those workflows concurrently.

Consumers initialized before active-run locking was introduced must add `run.lock` to `.sandcastle/.gitignore`. New initialization includes this rule automatically.

## Initialize a consumer

Run from the Git root or a nested directory:

```bash
sandcastle-workflow init
```

Initialization creates without overwriting:

- `.sandcastle/.gitignore`
- `.sandcastle/sandcastle.env.example`
- `.sandcastle/.env.example`

Copy the examples to their active ignored names and choose every value explicitly:

```bash
cp .sandcastle/sandcastle.env.example .sandcastle/sandcastle.env
cp .sandcastle/.env.example .sandcastle/.env
```

The runner configuration selects models, effort, maximum iterations, and an optional Docker image. The agent environment must declare `GH_TOKEN`; an empty declaration uses a non-empty host value. Initialization does not create credentials, active configuration, prompts, Dockerfiles, package scripts, logs, worktrees, overlays, or recovery state.

## Consumer contract

The Git root must contain:

- `package.json` with non-empty `test` and `typecheck` scripts
- exactly one supported lockfile
- `CODING_STANDARDS.md`
- a GitHub.com `origin` remote and working GitHub CLI authentication
- labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`

`AGENTS.md`, `CONTEXT.md`, and project ADRs are optional. Prompts use them only when present.

A declared `packageManager` must identify npm 10 or pnpm 11 and match its lockfile. Without a declaration, `package-lock.json` selects npm and `pnpm-lock.yaml` selects pnpm. Both lockfiles, missing lockfiles, npm shrinkwrap, unsupported managers, unsupported majors, and malformed declarations fail preflight.

Sandcastle uses a closed command mapping:

| Purpose | npm 10 | pnpm 11 |
| --- | --- | --- |
| Install | `npm ci` | `pnpm install --frozen-lockfile` |
| Type check | `npm run typecheck` | `pnpm typecheck` |
| Test | `npm test` | `pnpm test` |

Monorepositories are supported only when package metadata, lockfile, configuration, and verification scripts live at the Git root. Windows, GitHub Enterprise, and package-subdirectory operation are unsupported.

## GitHub control plane

Native GitHub relationships determine all executable work:

- direct sub-issues define a specification's children;
- child-to-child blocking edges define eligibility;
- every child blocks its parent specification;
- one specification is selected per invocation;
- final review runs only after every direct child closes.

Sandcastle validates these relationships and never infers, creates, or repairs them. Version `0.1.1` allows at most 100 simultaneously eligible issues and stops safely when the limit is exceeded. GitHub limits a parent to 100 direct sub-issues.

The package includes the optional Agent Skills-standard `github-ticket-relationships` skill. Configure it project-locally before asking an agent to publish tickets. For harnesses that discover `.agents/skills`, commit a relative symbolic link from `.agents/skills/github-ticket-relationships` to the installed package's skill directory. Initialization prints the installed source path but does not create the link or modify agent settings.

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

Build explicitly:

```bash
sandcastle-workflow build-image
```

Normal runs inspect the image before the first agent launch and never build it automatically.

Without `DOCKER_IMAGE`, the package derives `sandcastle:<project>-v<package-version>`. Repositories with the same directory name can collide; set `DOCKER_IMAGE` to avoid that rare case. An overlong generated tag fails rather than being truncated or hashed.

The packaged Dockerfile uses its own minimal build context. A contained `.sandcastle/Dockerfile` override takes precedence and uses the Git root as context.

The default Dockerfile installs `@openai/codex@latest`. This is intentionally nondeterministic:

- rebuilding the same package version can install a different Codex release;
- Docker layer caching can retain an older release despite `latest`;
- package version does not identify the installed Codex version;
- maintainers own rebuild, cache, compatibility, and regression risk.

The package does not disable Docker cache, attest image contents, or pin Codex automatically.

## State and security

Workflow-owned state remains beneath the consumer's `.sandcastle` directory:

- logs
- issue worktrees
- dependency overlays
- merger recovery state
- active-run ownership lock

The installed package is treated as read-only. This guarantee does not restrict agent activity. Agent containers intentionally receive writable worktrees, network access, and `GH_TOKEN`; agents can create commits and branches and mutate GitHub issues within the workflow. Users remain responsible for token scope, Docker trust, project Dockerfiles, network exposure, and agent-generated changes. Diagnostics do not print credential values.

Merger verification keeps host and container paths separate. Host Git, recovery, and cleanup use absolute host paths. Prompts and dependency mounts use `/home/agent/workspace/...` paths.

## Upgrade

Replace the committed tarball and update the consumer lockfile together. Run help, version, initialization, image building, and dry run before a normal workflow. A package upgrade can change packaged prompt rules; review project guidance for conflicts or obsolete instructions before running agents. Derived Docker image names include package version, so a new release requires an explicit image build unless `DOCKER_IMAGE` is configured.
