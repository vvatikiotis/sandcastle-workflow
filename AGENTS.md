# Agent instructions

- Issues and specifications live in `vvatikiotis/sandcastle-workflow` GitHub Issues.
- Read `CODING_STANDARDS.md`, `CONTEXT.md`, and applicable records under `docs/adr/` before changing code.
- Preserve the GitHub-native Control Plane defined by ADR-0001.
- Treat architectural decision records and their index as owner-authored and read-only during autonomous implementation.
- Use the packaged-artifact command seam for user-visible behavior tests.
- Keep changes small and avoid generalizing beyond spec #1.

## Agent skills

### Issue tracker

Issues and specifications are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the five default Matt Pocock skill triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

The repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.
