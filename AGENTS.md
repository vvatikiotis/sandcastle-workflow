# Agent instructions

## Before changing code

1. Identify the GitHub Issue that owns the work and use its specification and acceptance criteria as the scope. For work without an Issue, state the scope and acceptance criteria from the user's request before implementation; resolve any ambiguity with the user first.
2. Read `CODING_STANDARDS.md`, `CONTEXT.md`, and `docs/adr/README.md`. From the index, read each ADR governing a component, interface, state, or workflow behavior the change touches. Complete this step only after every applicable rule and decision is accounted for in the change.
3. Preserve the GitHub-native Control Plane defined by ADR-0001.
4. Keep the implementation tight to the established scope and acceptance criteria.

## Verification

Exercise user-visible behavior through the packaged-artifact command seam. Verify the resulting artifact, rather than testing only internal source paths.

## Conditional references

- When retrieving or interpreting an Issue specification, read `docs/agents/issue-tracker.md` first.
- When assigning triage labels, read `docs/agents/triage-labels.md` first.
- When exploring code or using domain terminology, read `docs/agents/domain.md` first.

## Ownership

Architectural decision records and their index are owner-authored. Treat them as read-only during autonomous implementation.
