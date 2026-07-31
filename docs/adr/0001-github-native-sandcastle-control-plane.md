# GitHub-native control plane for Sandcastle

## Decision

Sandcastle uses GitHub-native issue relationships and state as its deterministic control plane.

- A spec owns work only through native direct sub-issues.
- Every executable child is a GitHub issue in its own right.
- `blockedBy` / `blocking` relationships between direct children define dependency eligibility and execution order.
- Every direct child blocks its parent spec, so GitHub records that the spec cannot complete before its children.
- Sandcastle selects one ready spec per invocation and never switches to another spec during that invocation.
- Markdown bodies, comments, titles, and agent inference may explain work but do not establish scope, dependency, or scheduling.

`main.ts` must validate machine-checkable GitHub invariants before implementation, review, merge, and final review. It rejects orphan children, cross-spec blockers, dependency cycles, missing child-to-parent completion edges, nested hierarchies, and state/label changes that make the selected work ineligible.

Agents receive the selected IDs and read GitHub only for context and narrow race-condition checks. They do not select work, infer relationships, schedule dependencies, or repair the GitHub graph.

## Consequences

- Sandcastle does not invoke a planner model for issue selection.
- GitHub relationship publication must happen before a Sandcastle run, using `.agents/skills/github-ticket-relationships/SKILL.md`.
- An invalid graph stops the run with an explicit error; Sandcastle never repairs GitHub relationships automatically.
- GitHub native sub-issue order is the priority order among otherwise eligible children.
- Final review runs only when every direct native child is closed.
