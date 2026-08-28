# Maintainer guide

Use this guide to turn a source change into a reviewed, locally vendored package artifact.

## Package contract

- Package: `@vvatikiotis/sandcastle-workflow`
- Public interface: the compiled `sandcastle-workflow` executable
- Consumer distribution: a reviewed `.tgz` committed under the consumer's `vendor/` directory
- Publication to npm, workspace links, adjacent checkouts, and source-directory installation are unsupported

The package owns executable code and read-only defaults. Consumers own configuration, credentials, project guidance, Dockerfile overrides, logs, worktrees, dependency overlays, locks, and recovery state. Preserve the GitHub-native control plane in [ADR-0001](docs/adr/0001-github-native-sandcastle-control-plane.md).

Implementer and reviewer phases must not modify any Consumer Repository file named `Dockerfile`. The runner enforces this after each agent finishes by comparing the branch commits. A detected change must append a prominent error to that phase's log and abort before the next phase or merge. Maintainers make and review Dockerfile changes outside agent runs, then rebuild the configured image.

## Prerequisites

- Node.js 22 or newer
- pnpm 11.10.0, as declared in `package.json`
- GitHub CLI for consumer-boundary fixtures and issue operations
- Docker for the optional Docker regression

`GH_TOKEN` must contain a GitHub personal access token (PAT) with access to the Consumer Repository and these repository permissions:

- Metadata: read-only
- Issues: read and write

The workflow does not work without this PAT and these permissions.

## Release procedure

The command snippets use shell syntax supported by both Bash and Zsh. Run these steps in order. Stop if a required check fails.

### 1. Start clean and inspect the change

```bash
git status --short
git diff --check
```

Review the source diff. Do not change ADR files or the ADR index during implementation.

### 2. Install dependencies

```bash
pnpm install
```

### 3. Choose and apply the version bump

The package version is the public workflow version:

- patch: compatible fixes, `0.1.0` → `0.1.1`
- minor: compatible capabilities, `0.1.0` → `0.2.0`
- major: incompatible public behavior

Record the old version, update `package.json`, then find references that may identify the current release:

```bash
OLD_VERSION=$(node -p "require('./package.json').version")
# Edit package.json
VERSION=$(node -p "require('./package.json').version")
test "$VERSION" != "$OLD_VERSION"
git grep -l --fixed-strings "$OLD_VERSION" -- . \
  ':(exclude)artifacts/**' \
  ':(exclude)graphify-out/**' \
  ':(exclude)pnpm-lock.yaml'
```

Review every result. Update current-release references in consumer documentation, but preserve historical release records and unrelated dependency versions. Source and tests must derive the workflow version from `package.json`; replace any current-version literal found there instead of bumping it. Never edit `dist/` manually; the build regenerates it.

### 4. Run source and artifact checks

```bash
pnpm typecheck
pnpm test
pnpm run test:docker       # required when Docker is available; otherwise record the skip
pnpm pack --dry-run
```

`pnpm test` includes the packed-artifact suite. That suite creates a real tarball, installs it independently in clean npm and pnpm consumers, and tests the installed executable.

The Docker regression checks verification-worktree mount behavior and builds the ejected packaged Dockerfile when Docker is available. It reports a skip when Docker is unavailable. Packed-artifact coverage must also verify consumer-visible workflow safety behavior, including abort status and phase-log diagnostics when an implementer or reviewer changes a Dockerfile.

### 5. Build the release artifact

```bash
pnpm run pack:artifact
```

`prepack` runs the clean build and copies packaged prompts and the Dockerfile into `dist/`. The allowlist in `package.json` controls the tarball contents.

### 6. Inspect and checksum the artifact

```bash
VERSION=$(node -p "require('./package.json').version")
ARTIFACT="artifacts/vvatikiotis-sandcastle-workflow-${VERSION}.tgz"
CHECKSUM="${ARTIFACT}.sha256"
test -f "$ARTIFACT"
tar -tzf "$ARTIFACT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$ARTIFACT" > "$CHECKSUM"
else
  shasum -a 256 "$ARTIFACT" > "$CHECKSUM"
fi
cat "$CHECKSUM"
```

Confirm that the tarball contains only the compiled output, packaged defaults and skills, documentation, and package metadata. It must exclude source, tests, development configuration, credentials, consumer configuration, logs, worktrees, overlays, locks, recovery state, and unrelated repository files.

### 7. Review the release unit

Update release notes or consumer migration instructions for every consumer-facing change. State when no consumer action is required.

Then stage the source change, tests, documentation, generated `dist/`, tarball, and checksum together:

```bash
git add -A
git diff --cached --check
git diff --cached --name-status
```

Confirm the staged list contains only this release. Check that the artifact path and checksum are present.

### 8. Commit and tag

```bash
VERSION=$(node -p "require('./package.json').version")
git commit -m "release: package v${VERSION}"
git tag "v${VERSION}"
```

Keep the release local. Do not publish it to a registry.

## Handoff to a consumer

Give the consumer maintainer:

1. `artifacts/vvatikiotis-sandcastle-workflow-${VERSION}.tgz`
2. Its `.sha256` file
3. The checksum value
4. The required migration action, or an explicit statement that none is required
5. The qualification commands

The consumer copies the tarball into `vendor/`, verifies the checksum, and installs it:

```bash
VERSION=x.y.z
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

The consumer commits the new tarball, package manifest, and lockfile together. It must rebuild the Docker image unless `DOCKER_IMAGE` is configured. Review project guidance because packaged prompts may have changed.
