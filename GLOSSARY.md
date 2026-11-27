# Sandcastle Workflow Context

This glossary defines the terms used by the Sandcastle workflow.

## Language

### Package and repository

**Workflow Package**:
An independently versioned, read-only artifact containing the executable, the Packaged Defaults, and the optional Relationship Skill.

**Consumer Repository**:
The Git worktree where a Workflow Package runs. It owns configuration, credentials, project guidance, project overrides, and writable Workflow State.

**Base Branch**:
The branch checked out in the Consumer Repository when an issue starts; Integration fast-forwards it.
_Avoid_: target branch, main

**Workflow State**:
Project-local logs, worktrees, dependency overlays, and the active-run lock beneath the Consumer Repository's `.sandcastle` directory. It is separate from source code, project configuration, and credentials.

**Packaged Default**:
A prompt or Dockerfile shipped in the Workflow Package and resolved relative to the compiled executable.
_Avoid_: built-in default, built-in prompt

**Project Guidance**:
Consumer Repository-owned phase instructions added to one Packaged Default prompt. Project Guidance supplements the packaged workflow and safety rules.

**Project Override**:
A Consumer Repository-owned Dockerfile that replaces the Packaged Default Dockerfile for that repository.
_Avoid_: Dockerfile override

### Work graph and selection

**Control Plane**:
GitHub-native issue state and relationships that define the executable work graph. Direct sub-issues define specification membership; blocking relationships define dependency eligibility and execution order.

**Specification**:
A GitHub issue that groups direct child issues into a unit of planned work. The child relationships and their blocking edges are part of the specification; "Spec" is its accepted short form.

**Child Issue**:
A GitHub issue that is a direct native sub-issue of a Specification. It blocks its parent Specification until it closes.

**Standalone Issue**:
A GitHub issue that has no specification parent and no direct sub-issues. It runs through the standalone workflow path once eligible; an open blocker makes it wait.
_Avoid_: orphan (for a standalone issue)

**Blocker**:
An issue linked to another issue through a native blocking relationship. While a Blocker is open, the issue it blocks is not eligible.

**Eligibility**:
The conditions an issue must satisfy before selection, based on its GitHub state, labels, and native relationships.

**Work Path**:
The route a run follows: the spec path, which works one Specification's Child Issues, or the standalone path, which works Standalone Issues. The operator chooses when both have ready work.

**Relationship Skill**:
An optional agent skill, shipped in the Workflow Package, that publishes Specification, Child Issue, and Blocker relationships to GitHub. The GitHub CLI or web UI are alternatives to it.
_Avoid_: ticket-relationship skill

### Workflow roles

**Implementer**:
The agent role that implements one selected issue on its issue branch and commits the change.

**Reviewer**:
The agent role that reviews the implementer's branch against the issue, then approves it or commits corrections on that branch.

**Integration**:
The runner-owned step after the Reviewer that rebases the reviewed branch onto the Base Branch, verifies it, fast-forwards the Base Branch to it, closes the issue, and deletes the branch.
_Avoid_: merge step

**Reporter**:
The agent role that explains why Integration failed and gives the operator options, without changing the repository.
_Avoid_: Merger, conflict resolver

**Integration Report**:
The Reporter's account of a failed Integration: its cause, where it occurred, and the operator's options.
_Avoid_: conflict report, failure report

**Final Spec Reviewer**:
The agent role that reviews a Specification's integrated result once every Child Issue is closed, and closes the Specification when no completion gap remains.
