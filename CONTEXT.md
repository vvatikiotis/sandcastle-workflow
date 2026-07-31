# Sandcastle Workflow Package

This context packages and runs a deterministic issue-driven coding workflow.

## Language

**Workflow Package**: The independently versioned, read-only npm artifact containing the executable, built-in prompts, default Dockerfile, and optional relationship skill.

**Consumer Repository**: The Git worktree in which the Workflow Package runs. It owns configuration, credentials, overrides, and writable Workflow State.

**Workflow State**: Project-local logs, worktrees, dependency overlays, active-run lock, and merger recovery state stored beneath the Consumer Repository's `.sandcastle` directory.

**Built-in Default**: A prompt or Dockerfile shipped in the Workflow Package and resolved relative to the compiled executable.

**Project Override**: A Consumer Repository-owned prompt or Dockerfile that safely replaces one matching Built-in Default.

**Control Plane**: GitHub-native issue state, direct sub-issue relationships, and blocking relationships used for deterministic work selection.
