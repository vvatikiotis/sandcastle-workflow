import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  isReviewerCommitMessageForIssue,
  shouldJumpToMergerAfterReuseForSpec,
  shouldJumpToMergerAfterReuseForStandalone,
} from "../src/recovery-routing.ts";

describe("Reviewer commit classification", () => {
  it("matches exact Sandcastle reviewer commit format for the same issue", () => {
    assert.equal(
      isReviewerCommitMessageForIssue(
        "sandcastle(reviewer): #123: fix lint and formatting",
        "123"
      ),
      true
    );
  });

  it("accepts trailing and leading whitespace around commit subject", () => {
    assert.equal(
      isReviewerCommitMessageForIssue(
        "  \n\tsandcastle(reviewer): #123: follow-up check\t\n",
        "123"
      ),
      true
    );
  });

  it("requires matching issue id in the reviewer prefix", () => {
    assert.equal(
      isReviewerCommitMessageForIssue(
        "sandcastle(reviewer): #124: follow-up check",
        "123"
      ),
      false
    );
  });

  it("requires the exact case-sensitive reviewer prefix", () => {
    assert.equal(
      isReviewerCommitMessageForIssue(
        "Sandcastle(Reviewer): #123: Follow-up check",
        "123"
      ),
      false
    );
  });
});

async function createBranchWithCommitSubject(subject) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "sandcastle-routing-")
  );
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
    await writeFile(path.join(directory, "fixture.txt"), "fixture\n");
    execFileSync("git", ["add", "fixture.txt"], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", subject], {
      cwd: directory,
    });

    return {
      directory,
      subject: execFileSync("git", ["log", "-1", "--pretty=%s", "main"], {
        cwd: directory,
        encoding: "utf8",
      }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

describe("Rerun dispatch after reused worktree commits", () => {
  it("routes spec flow directly to merger when latest commit is reviewer for the same issue", () => {
    assert.equal(
      shouldJumpToMergerAfterReuseForSpec(
        "sandcastle(reviewer): #123: spec review pass",
        "123"
      ),
      true
    );
  });

  it("routes standalone flow directly to merger when latest commit is reviewer for the same issue", () => {
    assert.equal(
      shouldJumpToMergerAfterReuseForStandalone(
        "sandcastle(reviewer): #456: standalone review pass",
        "456"
      ),
      true
    );
  });

  it("keeps spec flow on reviewer when latest commit is not a matching reviewer commit", () => {
    assert.equal(
      shouldJumpToMergerAfterReuseForSpec(
        "sandcastle(implementer): #123: initial implementation",
        "123"
      ),
      false
    );
  });

  it("keeps standalone flow on reviewer when latest commit is not a matching reviewer commit", () => {
    assert.equal(
      shouldJumpToMergerAfterReuseForStandalone("chore: adjust docs", "456"),
      false
    );
  });

  it("routes from the actual reused branch HEAD subject for both paths", async () => {
    const fixture = await createBranchWithCommitSubject(
      "sandcastle(reviewer): #789: review correction"
    );

    try {
      assert.equal(
        shouldJumpToMergerAfterReuseForSpec(fixture.subject, "789"),
        true
      );
      assert.equal(
        shouldJumpToMergerAfterReuseForStandalone(fixture.subject, "789"),
        true
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
