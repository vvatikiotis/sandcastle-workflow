# Sandcastle Workflow Context

This glossary defines the terms used by the Sandcastle workflow.

## Terms

**Workflow Package**: An independently versioned, read-only artifact containing the executable, built-in prompts, default Dockerfile, and optional relationship skill.

**Consumer Repository**: The Git worktree where a Workflow Package runs. It owns configuration, credentials, project guidance, project overrides, and writable Workflow State.

**Workflow State**: Project-local logs, worktrees, dependency overlays, the active-run lock, and merger recovery state beneath the Consumer Repository's `.sandcastle` directory. It is separate from source code, project configuration, and credentials.

**Built-in Default**: A prompt or Dockerfile shipped in the Workflow Package and resolved relative to the compiled executable.

**Project Guidance**: Consumer Repository-owned phase instructions added to one Built-in Default prompt. Project Guidance supplements the packaged workflow and safety rules.

**Project Override**: A Consumer Repository-owned Dockerfile that replaces the Built-in Default Dockerfile for that repository.

**Control Plane**: GitHub-native issue state and relationships that define the executable work graph. Direct sub-issues define specification membership; blocking relationships define dependency eligibility and execution order.

**Specification**: A GitHub issue that groups direct child issues into a unit of planned work. The child relationships and their blocking edges are part of the specification.

**Standalone Issue**: An eligible GitHub issue that has no specification parent and no direct sub-issues. It can run through the standalone workflow path.

**Eligibility**: The conditions an issue must satisfy before selection, based on its GitHub state, labels, and native relationships.
