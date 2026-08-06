# Maintainer Guide

This guide explains how to develop, qualify, package, and release the local Sandcastle Workflow artifact.

## Workflows

- **Developing a change:** preserve the [package boundary](#package-boundary), then run the [development checks](#development-checks).
- **Preparing a release:** follow the [release checklist](#release-checklist) in order; its links provide the detailed commands and constraints.
- **Preparing consumer migration instructions:** after qualifying the artifact, follow [Consumer migration](#consumer-migration).

## Package boundary

The package is private and local-only:

- package: `@vvatikiotis/sandcastle-workflow`
- public interface: the compiled `sandcastle-workflow` executable
- distribution: reviewed `.tgz` tarballs committed by consumers under `vendor/`
- registry publication, workspace links, adjacent checkouts, and source-directory installation: unsupported

The package owns executable code and read-only defaults. Consumer repositories own configuration, credentials, project prompt guidance, Dockerfile overrides, logs, worktrees, dependency overlays, active-run locks, and merger recovery state.

Workflow state is private local data. Preserve owner-only directory and file modes, atomic recovery-marker writes, canonical worktree validation before recovery commands, and the consumer warning that agent logs and Codex sessions may contain sensitive content. Workflow logs are retained until the consumer explicitly removes them; do not add automatic deletion without a separately approved retention requirement.

Preserve the GitHub-native control plane in ADR-0001. Treat `CONTEXT.md`, `CODING_STANDARDS.md`, `docs/adr/`, and its index as authoritative. ADR files and the index remain owner-authored and read-only during implementation.

## Prerequisites

- Node.js 22 or newer
- the pinned pnpm 11 release from `package.json`
- Docker for the optional real-Docker regression
- GitHub CLI for consumer boundary fixtures and issue operations

Install dependencies:

```bash
pnpm install
```

## Development checks

Run the standard checks before committing implementation changes:

```bash
pnpm typecheck
pnpm test
```

`pnpm test` runs unit tests and the packed-artifact suite. The packed suite builds one real tarball, installs it independently in clean npm and pnpm consumers, and exercises the installed shim and compiled entry. It validates consumer behavior through that installed package rather than through `tsx` or publisher dependency links. The packed suite disables terminal color output so its plain-text assertions are stable in local and automated environments.

Run the optional Docker regression separately:

```bash
pnpm run test:docker
```

It exercises merger verification-worktree mount behavior and reports a skip when Docker is unavailable.

Inspect the artifact without creating it:

```bash
pnpm pack --dry-run
```

## Versioning

The package version is the public workflow version. Bump it before producing a new artifact:

- patch release for compatible fixes, for example `0.1.0` → `0.1.1`;
- minor release for compatible capabilities, for example `0.1.0` → `0.2.0`;
- major release for incompatible public behavior.

Before changing the package version, record the old version:

```bash
OLD_VERSION=$(node -p "require('./package.json').version")
```

Update `package.json`. In the same shell, confirm the manifest changed and find tracked references to review:

```bash
VERSION=$(node -p "require('./package.json').version")
test "$VERSION" != "$OLD_VERSION"
git grep -l --fixed-strings "$OLD_VERSION" -- . \
  ':(exclude)artifacts/**' \
  ':(exclude)graphify-out/**' \
  ':(exclude)pnpm-lock.yaml'
```

Review every result. Update a result when it identifies the current release; preserve historical release records and unrelated dependency versions. At minimum, account for references in `package.json`, `README.md`, `CONSUMER.md`, `MAINTAINER.md`, `src/`, `test/`, and generated `dist/`. Rebuild `dist/` through the package scripts rather than editing it manually.

## Build and qualify an artifact

After the version bump:

```bash
pnpm typecheck
pnpm test
pnpm run test:docker
pnpm pack --dry-run
pnpm run pack:artifact
```

`prepack` runs a clean build and copies the packaged prompts and Dockerfile into `dist/`. The artifact allowlist in `package.json` contains the compiled output and defaults, relationship skill, `README.md`, `CONSUMER.md`, `MAINTAINER.md`, and package metadata.

The resulting filename is versioned. Inspect the contents and record its checksum:

```bash
VERSION=$(node -p "require('./package.json').version")
ARTIFACT="artifacts/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
CHECKSUM="${ARTIFACT}.sha256"
tar -tzf "$ARTIFACT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARTIFACT" > "$CHECKSUM"
else
  shasum -a 256 "$ARTIFACT" > "$CHECKSUM"
fi
cat "$CHECKSUM"
```

Confirm that the tarball excludes source, tests, development configuration, credentials, active consumer configuration, logs, worktrees, overlays, active-run locks, recovery state, and unrelated repository files.

## Release checklist

Follow these steps in order. A failed or skipped required check stops the release.

1. Review the source diff and confirm no ADR or ADR-index files changed.
2. Choose the release under [Versioning](#versioning), then update the package version and every current-release reference while preserving historical release records.
3. Complete [Build and qualify an artifact](#build-and-qualify-an-artifact). This step is complete when every command passes, the tarball contents satisfy the allowlist and exclusions, and the checksum sidecar exists.
4. Stage source, tests, documentation, generated `dist/`, artifact, and checksum as one release unit. Review the staged file list and confirm it contains only that release.
5. Commit the release unit and create a Git tag matching the package version.
6. For each consumer-facing change in the release diff, provide the required migration action or state that no consumer action is required. Include the artifact path, checksum, lockfile update command, and qualification commands.

Example release commands:

```bash
VERSION=$(node -p "require('./package.json').version")
git diff --check
git add -A
git diff --cached --check
git diff --cached --name-status
git commit -m "release: package v${VERSION}"
git tag "v${VERSION}"
```

Keep releases local. Publish to npm or another registry only when the project specification explicitly changes.

## Consumer migration

A consumer updates by replacing its vendored artifact and lockfile entry:

```bash
VERSION=x.y.z
pnpm add -D "./vendor/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
```

Consumers must run help, version, initialization, image building, and dry run before a normal workflow. A new package version can make project prompt guidance obsolete or conflicting and changes derived Docker image names. The consumer must build the new image explicitly unless it uses `DOCKER_IMAGE`.
