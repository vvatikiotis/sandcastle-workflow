# Maintainer Guide

This guide explains how to develop, qualify, package, and release the local Sandcastle Workflow artifact.

## Package boundary

The package is private and local-only:

- package: `@vvatikiotis/sandcastle-workflow`
- public interface: the compiled `sandcastle-workflow` executable
- distribution: reviewed `.tgz` tarballs committed by consumers under `vendor/`
- registry publication, workspace links, adjacent checkouts, and source-directory installation: unsupported

The package owns executable code and read-only defaults. Consumer repositories own configuration, credentials, prompt and Dockerfile overrides, logs, worktrees, dependency overlays, active-run locks, and merger recovery state.

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

Consumers must run help, version, initialization, image building, and dry run before a normal workflow. A new package version can invalidate project prompt overrides and changes derived Docker image names. The consumer must build the new image explicitly unless it uses `DOCKER_IMAGE`.
