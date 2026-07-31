# Maintainer Guide

This guide explains how to develop, qualify, package, and release the local Sandcastle Workflow artifact.

## Development and release flow

Follow these steps in order. Later sections define the checks and release invariants in detail.

1. **Prepare the checkout** — install the pinned dependencies from [Prerequisites](#prerequisites) and confirm the existing test suite passes.
2. **Make one focused change** — preserve the [package boundary](#package-boundary), ADR-0001, workflow-state protections, and the packaged-executable test seam.
3. **Verify during development** — run `pnpm typecheck` and `pnpm test`. Run the real-Docker regression when the change affects sandbox mounts, worktrees, cleanup, or Docker behavior. See [Development checks](#development-checks).
4. **Choose the release version** — classify the change using [Versioning](#versioning), then update the package version and current-version references before creating an artifact.
5. **Qualify the release** — run every command under [Build and qualify an artifact](#build-and-qualify-an-artifact). A failed or skipped required check is not successful qualification.
6. **Inspect and identify the artifact** — inspect the tarball allowlist, confirm sensitive and development files are absent, and record its SHA-256 checksum.
7. **Commit and tag one release unit** — commit source, tests, documentation, generated output, artifact, and checksum together; then create the matching Git tag. Follow the [Release checklist](#release-checklist).
8. **Provide migration instructions** — tell consumers which tarball and checksum to use, how to update their lockfile, and which initialization, image, or guidance changes require attention. See [Consumer migration](#consumer-migration).

## Package boundary

The package is private and local-only:

- package: `@vvatikiotis/sandcastle-workflow`
- public interface: the compiled `sandcastle-workflow` executable
- distribution: reviewed `.tgz` tarballs committed by consumers under `vendor/`
- registry publication, workspace links, adjacent checkouts, and source-directory installation: unsupported

The package owns executable code and read-only defaults. Consumer repositories own configuration, credentials, project prompt guidance, Dockerfile overrides, logs, worktrees, dependency overlays, active-run locks, and merger recovery state.

Workflow state is private local data. Preserve owner-only directory and file modes, atomic recovery-marker writes, canonical worktree validation before recovery commands, and the consumer warning that agent logs and Codex sessions may contain sensitive content.

Preserve the GitHub-native control plane in ADR-0001. Treat `CONTEXT.md`, `CODING_STANDARDS.md`, `docs/adr/`, and its index as authoritative; ADR files and the index are read-only during implementation.

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

`pnpm test` runs unit tests and the packed-artifact suite. The packed suite builds one real tarball, installs it independently in clean npm and pnpm consumers, and exercises the installed shim and compiled entry. It must not use `tsx` or publisher dependency links to test consumer behavior.

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

Update the package version and all repository references to it. Find references with:

```bash
grep -RIl --exclude-dir=node_modules --exclude='*.tgz' '0\.1\.0' .
```

At minimum, check `package.json`, `README.md` or `CONSUMER.md`, `src/`, and `test/`. Rebuild output under `dist/` through the package scripts rather than editing it manually.

## Build and qualify an artifact

After the version bump:

```bash
pnpm typecheck
pnpm test
pnpm run test:docker
pnpm pack --dry-run
pnpm run pack:artifact
```

`prepack` runs a clean build and copies the packaged prompts and Dockerfile into `dist/`. The artifact allowlist is defined by `package.json` and must contain only the compiled output, defaults, relationship skill, README, and package metadata.

The resulting filename is versioned, for example:

```text
artifacts/vvatikiotis-sandcastle-workflow-0.1.1.tgz
```

Inspect the contents and record its checksum:

```bash
tar -tzf artifacts/vvatikiotis-sandcastle-workflow-0.1.1.tgz
sha256sum artifacts/vvatikiotis-sandcastle-workflow-0.1.1.tgz
```

Confirm that the tarball excludes source, tests, development configuration, credentials, active consumer configuration, logs, worktrees, overlays, active-run locks, recovery state, and unrelated repository files.

## Release checklist

1. Review the source diff and confirm no ADR or ADR-index files changed.
2. Bump the package version and update all version references.
3. Run `pnpm typecheck`.
4. Run `pnpm test`.
5. Run `pnpm run test:docker`.
6. Run `pnpm pack --dry-run`.
7. Generate the tarball into `artifacts/`.
8. Inspect the tarball contents.
9. Calculate and record the SHA-256 checksum.
10. Commit source, tests, documentation, generated `dist/`, and the artifact together.
11. Create a matching Git tag, such as `v0.1.1`.
12. Tell consumers to replace the vendored tarball and update their lockfile.

Example release commands:

```bash
git diff --check
git add package.json CONSUMER.md MAINTAINER.md src test dist artifacts
git commit -m "release: package v0.1.1"
git tag v0.1.1
```

Do not publish to npm or another registry unless the project specification explicitly changes.

## Consumer migration

A consumer updates by replacing its vendored artifact and lockfile entry:

```bash
pnpm add -D ./vendor/vvatikiotis-sandcastle-workflow-0.1.1.tgz
```

Consumers must run help, version, initialization, image building, and dry run before a normal workflow. A new package version can make project prompt guidance obsolete or conflicting and changes derived Docker image names. The consumer must build the new image explicitly unless it uses `DOCKER_IMAGE`.
