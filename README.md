# Sandcastle Workflow

A private, single-owner workflow for deterministic GitHub-native issue implementation through Docker and Codex.

This repository is the only supported distribution. It is not published, vendored, or shared as an npm package or tarball. It does not expose a JavaScript or TypeScript import interface.

## Use from a consumer repository

From the package checkout:

```bash
pnpm install
pnpm build
```

From a consumer repository, set the local executable path for the current shell:

```bash
export SANDCASTLE_WORKFLOW_HOME=/absolute/path/to/sandcastle-workflow
export SANDCASTLE_WORKFLOW="$SANDCASTLE_WORKFLOW_HOME/dist/cli.js"

node "$SANDCASTLE_WORKFLOW" init
node "$SANDCASTLE_WORKFLOW" build-image
node "$SANDCASTLE_WORKFLOW" --dry-run
node "$SANDCASTLE_WORKFLOW"
```

The executable discovers the consumer's Git root from the current working directory. Keep the path and any skill link local to the host; do not commit them to the consumer repository.

The detailed operational contract is in [CONSUMER.md](CONSUMER.md). Development and maintenance checks are in [MAINTAINER.md](MAINTAINER.md).
