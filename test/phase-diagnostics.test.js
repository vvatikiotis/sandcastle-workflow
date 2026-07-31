import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatPhaseExecutionError,
  formatPhaseFailure,
  runAgentPhase,
} from "../src/phase-diagnostics.ts";

describe("phase diagnostics", () => {
  it("formats non-success outcomes with detail and log path", () => {
    const diagnostic = formatPhaseFailure({
      phase: "Reviewer",
      outcome: "stopped",
      detail: "Tests failed; inspect output; fix the failing assertion.",
      logPath: ".sandcastle/logs/reviewer.log",
    });

    assert.match(diagnostic, /Reviewer/);
    assert.match(diagnostic, /stopped/);
    assert.match(diagnostic, /Tests failed/);
    assert.match(diagnostic, /.sandcastle\/logs\/reviewer.log/);
  });

  it("uses a fallback when phase detail is missing or blank", () => {
    for (const detail of [undefined, "   "]) {
      assert.match(
        formatPhaseFailure({
          phase: "Implementer",
          outcome: "needs-info",
          detail,
          logPath: "implementer.log",
        }),
        /No phase detail was provided\./
      );
    }
  });

  it("includes available agent detail, context, and log path for malformed output", () => {
    const diagnostic = formatPhaseExecutionError({
      phase: "Merger",
      context: "issue #42",
      detail: "Rebase failed; git rebase exited 1; resolve the conflict.",
      logPath: "merger.log",
      error: new Error("missing phase outcome"),
    });

    assert.match(diagnostic, /Merger/);
    assert.match(diagnostic, /issue #42/);
    assert.match(diagnostic, /Rebase failed/);
    assert.match(diagnostic, /missing phase outcome/);
    assert.match(diagnostic, /merger.log/);
  });

  it("preserves available agent detail when phase output has no valid outcome", async () => {
    await assert.rejects(
      runAgentPhase({
        phase: "Reviewer",
        context: "issue #42",
        logPath: "reviewer.log",
        allowedOutcomes: ["approved", "needs-info", "stopped"],
        run: async () => ({
          stdout:
            "<phase-outcome>invalid</phase-outcome>\n<phase-detail>Tests failed; pnpm test exited 1; fix the failing test.</phase-detail>",
        }),
      }),
      (error) => {
        assert.match(error.message, /Reviewer/);
        assert.match(error.message, /issue #42/);
        assert.match(error.message, /Tests failed/);
        assert.match(error.message, /reviewer.log/);
        return true;
      }
    );
  });
});
