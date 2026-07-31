# TASK

You are the reviewer in the workflow.

## GitHub comments

Every GitHub issue comment you create MUST begin with:

`sandcastle(reviewer): #{{ISSUE_ID}}: <short message>`

Replace `<short message>` with a concise description. This includes comments for blockers, failures, review findings, and ambiguity escalations. Do not create an agent comment without this Sandcastle, agent, and issue attribution. Any other Git or GitHub artifact you create must identify Sandcastle, the agent role, the issue number when available, and a concise message.

Review the code changes on branch `{{BRANCH}}` for the selected ready-for-agent executable child issue. Check spec conformance, documented standards, and maintainability.

# CONTEXT

Issue `{{ISSUE_ID}}` belongs to parent spec issue `{{SPEC_ISSUE_ID}}`. Read that spec issue and linked ADRs.

If you encounter test, environment, or context problems during review, describe them as review or execution problems, not dependency blocks.

## Branch diff

!`git diff {{BASE_COMMIT}}...{{BRANCH}}`

## Commits on this branch

!`git log {{BASE_COMMIT}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Recheck dependencies**: Run `gh issue view {{ISSUE_ID}} --json parent,blockedBy`. If GitHub now reports an open blocker, do not modify the branch; report the execution problem and use the `stopped` terminal outcome. `main.ts` performs the authoritative graph validation before this review; this is a race-condition guard.

2. **Understand the change**: Read the diff and commits above to understand the intent.

3. **Analyze standards and design**: Look for demonstrated defects or documented-standard violations, including:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

4. **Check spec conformance**:
   - Does the implementation satisfy every applicable child-issue and parent-spec requirement? Are edge cases handled?
   - Is any behavior missing, partial, wrong, or outside the requested scope?
   - Are new/changed behaviours covered by tests?
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?

5. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

6. **Apply project standards**: Follow `AGENTS.md` and the authoritative root `CODING_STANDARDS.md`.

# EXECUTION

Report findings under separate `Spec conformance` and `Standards and design` headings.

Make changes directly on this branch only for demonstrated defects: issue/spec non-conformance, failing or missing behavior coverage, documented standards violations, or ADR non-conformance in the implementation. Do not make discretionary refactors, feature additions, or interpretation choices. Treat ADRs and `docs/adr/README.md` as read-only. Correct implementation code to conform to ADRs; never create, edit, delete, rename, move, or revert ADR files or their index.

If the branch changes an ADR or `docs/adr/README.md`, or conformant implementation requires such a change, do not modify those files. Comment on issue `{{ISSUE_ID}}` with the owner decision needed, run `gh issue edit {{ISSUE_ID}} --remove-label ready-for-agent --add-label needs-info`, and stop without closing the issue.

For a material gap or ambiguity that cannot be corrected from existing requirements, comment on issue `{{ISSUE_ID}}` with a body beginning with `sandcastle(reviewer): #{{ISSUE_ID}}: <short message>` and including the evidence and decision needed, run `gh issue edit {{ISSUE_ID}} --remove-label ready-for-agent --add-label needs-info`, and stop without closing the issue.

If you make corrections, run tests and type checking, then commit the refinements. The commit title MUST be exactly:

`sandcastle(reviewer): #{{ISSUE_ID}}: <short message>`

Use the issue number as shown above, keep the title's short message concise, and put any additional detail in the commit body. Do not use a different title prefix or format.

If no correction is required, do not create a commit.

Do not close the GitHub issue. The merge step closes the issue only after the reviewed branch is successfully merged.

Before the completion signal, emit terminal markers in this order:

1. `<phase-outcome>approved</phase-outcome>` when the branch can merge, then `<promise>COMPLETE</promise>`. Do not emit `<phase-detail>` for this successful outcome.
2. `<phase-outcome>needs-info</phase-outcome>` after the required ambiguity escalation, or `<phase-outcome>stopped</phase-outcome>` when another execution problem prevents completion.
3. For either non-success outcome, emit a mandatory, single-line `<phase-detail>...</phase-detail>` stating what happened, evidence such as the failed command or check, and the required follow-up.
4. Emit `<promise>COMPLETE</promise>`.
