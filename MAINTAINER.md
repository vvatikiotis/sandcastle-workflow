# Maintainer Guide

This repository contains a private, single-owner Sandcastle workflow. Do not publish it, place its artifacts in consumer repositories, or share its source, compiled output, tarballs, Docker images, or credentials.

## Development flow

1. Install the pinned dependencies.
2. Make one focused change.
3. Run type checking, tests, and the Docker regression when relevant.
4. Build the compiled executable.
5. Test the compiled executable from a consumer repository.
6. Review the diff and commit the source, tests, documentation, and generated `dist/` output when generated output is part of the repository policy.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm run test:docker
pnpm build
```

The Docker test reports a skip when Docker is unavailable. The package's executable is the public interface within this private checkout:

```text
dist/cli.js
dist/setup.sh
```

The source repository remains the source of truth. Consumers use the compiled executable directly through an owner-local absolute path; they do not install this repository, use a workspace link, use a registry, or commit a file dependency.

## Consumer verification

From the consumer repository:

```bash
export SANDCASTLE_WORKFLOW_HOME=/absolute/path/to/sandcastle-workflow
export SANDCASTLE_WORKFLOW="$SANDCASTLE_WORKFLOW_HOME/dist/cli.js"
node "$SANDCASTLE_WORKFLOW" --help
node "$SANDCASTLE_WORKFLOW" --version
node "$SANDCASTLE_WORKFLOW" --dry-run
```

Verify that the command discovers the consumer Git root, uses the consumer configuration, and does not create or modify files during `--dry-run`.

## Package boundary and security

The package owns executable code and read-only defaults. Consumer repositories own configuration, credentials, project guidance, Dockerfile overrides, logs, worktrees, dependency overlays, active-run locks, and merger recovery state.

Never commit consumer `.sandcastle/.env`, runner configuration, logs, worktrees, overlays, locks, recovery state, or credentials to this repository. Treat logs and Codex sessions as sensitive. Preserve owner-only permissions, atomic recovery-marker writes, canonical worktree validation, and the GitHub-native control plane in ADR-0001.

Keep the relationship skill available to the owner through an untracked local symlink in each consumer. Do not add a repository-relative link to this package checkout.

## Release and artifact policy

There is no distribution release process. Do not create or share release tarballs, calculate release checksums, tag versions for distribution, or publish to npm or another registry. The test suite may create a temporary tarball in the system temporary directory for the packed-executable regression; that artifact must not be copied into either repository or retained. Version changes are unnecessary unless they affect local diagnostics or compatibility.

If a temporary local tarball is needed for debugging, keep it outside both repositories and remove it afterward. It must never be committed or copied to a consumer repository.

## Architectural and domain rules

Read `CODING_STANDARDS.md`, `CONTEXT.md`, and applicable ADRs before changing code. ADRs and their index are owner-authored. Preserve the GitHub-native relationship control plane and the workflow-state safety guarantees.
