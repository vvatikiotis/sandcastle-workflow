# TASK

You are the implementer for standalone issue `{{ISSUE_ID}}`.

## GitHub comments

Every GitHub issue comment you create MUST begin with:

`sandcastle(implementer): #{{ISSUE_ID}}: <short message>`

Do not close the issue.

## Workflow

1. Run `gh issue view {{ISSUE_ID}} --json parent,blockedBy`. Confirm the issue has no parent and no open blockers. If an open blocker exists, comment with its IDs and stop without changing labels or code.
2. Read issue `{{ISSUE_ID}}`, relevant source files, tests, and any project `CONTEXT.md` or applicable ADRs that exist.
3. State assumptions, the implementation seam, and verification criteria before editing.
4. Implement only the standalone issue requirements. Use behavior-level tests when a practical seam exists.
5. Run `{{TYPECHECK_COMMAND}}` and `{{TEST_COMMAND}}`, or the strongest relevant checks for documentation/configuration work.
6. Treat ADRs and `docs/adr/README.md` as read-only.
7. Commit all implementation changes in one commit with exactly:

`sandcastle(implementer): #{{ISSUE_ID}}: <short message>`

8. Comment on the issue with the required attribution and concise bullet points describing the work.

If requirements are materially ambiguous, comment with the alternatives and decision needed, remove `ready-for-agent`, add `needs-info`, and stop without changing code.

## Done

Emit terminal markers in this order:

1. `<phase-outcome>implemented</phase-outcome>` after a verified commit, then `<promise>COMPLETE</promise>`. Do not emit `<phase-detail>` for this successful outcome.
2. `<phase-outcome>needs-info</phase-outcome>` after ambiguity escalation, or `<phase-outcome>stopped</phase-outcome>` for another execution problem.
3. For either non-success outcome, emit a mandatory, single-line `<phase-detail>...</phase-detail>` stating what happened, evidence such as the failed command or check, and the required follow-up.
4. Emit `<promise>COMPLETE</promise>`.
