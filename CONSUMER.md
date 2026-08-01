# Consumer Guide

This guide describes using the private Sandcastle checkout from another repository owned by the same person. The workflow is not distributed to collaborators, through a registry, or through committed artifacts.

## Setup and run

From the private package checkout, build the executable:

```bash
pnpm install
pnpm build
```

From the consumer repository, configure the current shell:

```bash
export SANDCASTLE_WORKFLOW_HOME=/absolute/path/to/sandcastle-workflow
export SANDCASTLE_WORKFLOW="$SANDCASTLE_WORKFLOW_HOME/dist/cli.js"
```

Run commands with `node "$SANDCASTLE_WORKFLOW"`:

```bash
node "$SANDCASTLE_WORKFLOW" init
node "$SANDCASTLE_WORKFLOW" build-image
node "$SANDCASTLE_WORKFLOW" --dry-run
node "$SANDCASTLE_WORKFLOW"
```

The command may be run from the Git root or a nested directory. It discovers the active consumer Git root and never changes the process working directory.

Initialization creates, without overwriting:

- `.sandcastle/.gitignore`
- `.sandcastle/sandcastle.env.example`
- `.sandcastle/.env.example`

Copy the examples to their active ignored names and configure them explicitly. Never commit `.sandcastle/.env` or `.sandcastle/sandcastle.env`.

## Consumer contract

The Git root must contain:

- `package.json` with non-empty `test` and `typecheck` scripts
- exactly one supported lockfile
- `CODING_STANDARDS.md`
- a GitHub.com `origin` remote and working GitHub CLI authentication
- a GitHub CLI release supporting native `parent`, `blockedBy`, and `blocking` fields
- labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`

Supported environments are Node.js 22 or newer on macOS and Linux, npm 10 or pnpm 11 repositories, Docker sandboxes, and Codex runtime agents.

## GitHub control plane

Native GitHub relationships determine executable work:

- direct sub-issues define a specification's children;
- child-to-child blocking edges define eligibility;
- every child blocks its parent specification;
- one specification is selected per invocation;
- final review runs only after every direct child closes.

Configure the relationship skill locally, without committing the link:

```bash
mkdir -p .agents/skills
ln -s "$SANDCASTLE_WORKFLOW_HOME/skills/github-ticket-relationships" \
  .agents/skills/github-ticket-relationships
printf '%s\n' '.agents/skills/github-ticket-relationships' >> .git/info/exclude
```

The skill link and the matching instruction in `AGENTS.md` are required before publishing child issues.

## Prompts, Docker, and state

Consumer-owned prompt guidance may be placed directly under `.sandcastle` using the fixed filenames documented by the packaged defaults. A contained `.sandcastle/Dockerfile` may override the packaged Dockerfile.

Build the effective image explicitly before a normal run:

```bash
node "$SANDCASTLE_WORKFLOW" build-image
```

Workflow state remains under the consumer's `.sandcastle` directory: logs, worktrees, dependency overlays, locks, and merger recovery state. Treat logs and Codex sessions as sensitive. The package does not delete logs automatically.

## Commands and exit statuses

```text
node "$SANDCASTLE_WORKFLOW"
node "$SANDCASTLE_WORKFLOW" init
node "$SANDCASTLE_WORKFLOW" build-image
node "$SANDCASTLE_WORKFLOW" --dry-run
node "$SANDCASTLE_WORKFLOW" --help
node "$SANDCASTLE_WORKFLOW" --version
```

Exit status `0` means success, `1` means abort or failure, `2` means invalid usage, and `3` means a safe stop requiring follow-up. Signal statuses remain `129`, `130`, and `143`.

Run `--dry-run` before a normal workflow. It performs read-only preflight and GitHub queries, and does not launch agents or mutate GitHub.

## Local-only upgrades

After changing the private package checkout:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Rebuild the consumer's Docker image and run `--help`, `--version`, and `--dry-run` before a normal workflow. Do not copy a tarball into the consumer repository or add a package dependency for this workflow.
