---
name: github-ticket-relationships
description: Publish approved GitHub spec-child ticket graphs using native sub-issues and issue dependencies. Use whenever a spec issue and its child issues are about to be published.
---

# GitHub Ticket Relationships

Use this skill whenever child issues for a spec are about to be published to
GitHub. Create the spec issue first; this skill requires its issue number. The
approved graph may come from `/to-tickets` or another user-approved planning
workflow. Do not redesign tickets, infer missing edges, or publish before
approval.

## Source of truth

Use GitHub-native relationships only:

- Each executable child is a GitHub issue in its own right.
- A child belongs to a spec only when it is a native direct sub-issue.
- A blocking edge exists only when GitHub records it as `blocked by` / `blocking`.
- Markdown `Parent` and `Blocked by` sections may explain the graph but do not
  establish automation relationships.

## Required inputs

Before publishing, identify:

- the parent spec issue number;
- every approved child ticket;
- every ticket's direct blockers; and
- the approved dependency order.

If any input is unclear, stop and ask the user. Do not guess.

## Publish

1. Verify GitHub authentication and the parent spec:

   ```bash
   gh auth status
   gh issue view <spec-number> --json number,state,title,subIssues
   ```

2. Create every approved child issue in dependency order. Record each created
   issue number. Attach it directly to the parent spec:

   ```bash
   gh issue create \
     --parent <spec-number> \
     --label ready-for-agent \
     --title "<title>" \
     --body-file <prepared-body-file>
   ```

3. For an approved existing issue, attach it only after confirming that the
   existing issue is intended to become a direct child:

   ```bash
   gh issue edit <spec-number> --add-sub-issue <child-number>
   ```

4. After all child issue numbers exist, add every approved child-to-child
   dependency from the blocked issue's side:

   ```bash
   gh issue edit <blocked-child-number> \
     --add-blocked-by <comma-separated-blocker-issue-numbers>
   ```

5. Make the parent spec blocked by every direct child. Set each edge from the
   child side:

   ```bash
   gh issue edit <child-number> --add-blocking <spec-number>
   ```

   Never add the inverse edge from a child to its parent. The parent is blocked
   by its children; a child must not be blocked by its parent.

## Verify

Read the resulting GitHub graph. Do not rely on command success alone.

```bash
gh issue view <spec-number> --json number,subIssues,blockedBy
gh issue view <child-number> --json number,parent,blockedBy,blocking
```

Verify that:

- every approved child has the spec as its native parent;
- the spec lists every approved direct child;
- each child has exactly its approved direct blockers;
- the spec is blocked by every direct child;
- no dependency cycle exists; and
- no issue outside the approved graph was modified.

Report the published issue numbers, parent-child relationships, and blocking
edges. Do not close any issue.
