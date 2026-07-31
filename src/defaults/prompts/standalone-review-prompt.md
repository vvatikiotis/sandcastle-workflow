# TASK

You are the reviewer for standalone issue `{{ISSUE_ID}}` on branch `{{BRANCH}}`.

## GitHub comments

Every GitHub issue comment you create MUST begin with:

`sandcastle(reviewer): #{{ISSUE_ID}}: <short message>`

Do not close the issue.

## Review process

1. Run `gh issue view {{ISSUE_ID}} --json parent,blockedBy`. Confirm the issue remains unparented and has no open blockers. If not, report the execution problem and stop.
2. Inspect `git diff {{BASE_COMMIT}}...{{BRANCH}}` and the branch commits.
3. Read the issue, relevant source files, tests, `CODING_STANDARDS.md`, and any project `CONTEXT.md` or applicable ADRs that exist.
4. Report findings under separate `Spec conformance` and `Standards and design` headings.
5. Correct only demonstrated defects directly on this branch. Treat ADRs and `docs/adr/README.md` as read-only.
6. If corrections are made, run `{{TYPECHECK_COMMAND}}` and `{{TEST_COMMAND}}`, then commit with exactly:

`sandcastle(reviewer): #{{ISSUE_ID}}: <short message>`

If a material ambiguity cannot be resolved from the issue or repository evidence, comment with the decision needed, remove `ready-for-agent`, add `needs-info`, and stop.

## Done

Emit terminal markers in this order:

1. `<phase-outcome>approved</phase-outcome>` when the branch can merge, then `<promise>COMPLETE</promise>`. Do not emit `<phase-detail>` for this successful outcome.
2. `<phase-outcome>needs-info</phase-outcome>` after ambiguity escalation, or `<phase-outcome>stopped</phase-outcome>` for another execution problem.
3. For either non-success outcome, emit a mandatory, single-line `<phase-detail>...</phase-detail>` stating what happened, evidence such as the failed command or check, and the required follow-up.
4. Emit `<promise>COMPLETE</promise>`.
