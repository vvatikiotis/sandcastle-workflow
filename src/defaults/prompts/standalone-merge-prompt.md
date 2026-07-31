# TASK

You are the merger for standalone issue `{{ISSUE_ID}}`.

The reviewed branch is `{{BRANCH}}`; the base branch is `{{BASE_BRANCH}}`; the captured base commit is `{{BASE_COMMIT}}`. Use the temporary verification worktree exactly at `{{VERIFICATION_WORKTREE_PATH}}`.

## GitHub comments

Every GitHub issue comment you create MUST begin with:

`sandcastle(merger): #{{ISSUE_ID}}: <short message>`

## Process

1. Verify `{{BASE_BRANCH}}` still points to `{{BASE_COMMIT}}`. If it moved, stop before any merge action and explain that likely causes include a manual commit, a cleanup/config commit, another Sandcastle process, or an automated hook or scheduled job updating the base branch during this run.
2. Run `gh issue view {{ISSUE_ID}} --json parent,blockedBy`. Confirm it remains unparented and has no open blockers.
3. Verify the reviewed branch exists and has no changes under `docs/adr/`.
4. Sandcastle already created the verification worktree at `{{VERIFICATION_WORKTREE_PATH}}`. Rebase the reviewed branch there onto `{{BASE_COMMIT}}`; do not check out `{{BRANCH}}` in the main checkout or create another worktree.
5. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, and `pnpm test` in the verification worktree. Fix only demonstrated implementation failures; never modify ADRs or `docs/adr/README.md`. Any fix commit must be titled exactly:

`sandcastle(merger): #{{ISSUE_ID}}: <short message>`

6. Do not remove the verification worktree. The host runner owns that cleanup and performs it only after this sandbox exits and its dependency mount is released. Do not run `git worktree remove`, `git worktree prune`, or use `--force`.
7. Verify the base branch is unchanged and fast-forward it with `git merge --ff-only {{BRANCH}}`. If the base moved, report the same likely causes: manual commits, cleanup/config commits, another Sandcastle process, or automated hooks or scheduled jobs.
8. Close issue `{{ISSUE_ID}}` with a comment beginning with `sandcastle(merger): #{{ISSUE_ID}}: <short message>`, summarizing the integration and verification.
9. Do not delete the reviewed branch; the runner owns deletion.

If rebase conflicts have no evidence-based resolution, abort the rebase, comment with the competing intents and decision needed, remove `ready-for-agent`, add `needs-info`, and stop.

## Done

Emit terminal markers in this order:

1. `<phase-outcome>merged</phase-outcome>` only after verification, fast-forward, and issue closure, then `<promise>COMPLETE</promise>`. Do not emit `<phase-detail>` for this successful outcome.
2. `<phase-outcome>needs-info</phase-outcome>` after semantic-conflict escalation, or `<phase-outcome>stopped</phase-outcome>` for another execution problem.
3. For either non-success outcome, emit a mandatory, single-line `<phase-detail>...</phase-detail>` stating what happened, evidence such as the failed command or check, and the required follow-up.
4. Emit `<promise>COMPLETE</promise>`.
