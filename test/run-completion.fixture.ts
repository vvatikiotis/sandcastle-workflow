import { reportPhaseFailure } from "../src/phase-diagnostics.ts";
import { createRunCompletionReporter } from "../src/run-completion.ts";
import {
  classifyPlanningError,
  getNoStandaloneIssuesStatus,
  InvalidIssueGraphError,
} from "../src/workflow-completion.ts";

const reporter = createRunCompletionReporter(() => undefined);
reporter.installProcessHandlers();

switch (process.argv[2]) {
  case "completed-twice":
    reporter.setStatus({ kind: "completed", reason: "Fixture completed." });
    await reporter.printSummary();
    await reporter.printSummary();
    break;
  case "stopped":
    reporter.setStatus({ kind: "stopped", reason: "Fixture stopped." });
    break;
  case "aborted":
    reporter.setStatus({ kind: "aborted", reason: "Fixture aborted." });
    break;
  case "phase-failure": {
    const reason = reportPhaseFailure({
      phase: "Reviewer for issue #42",
      outcome: "stopped",
      detail: "Tests failed; fix the failing assertion.",
      logPath: ".sandcastle/logs/reviewer.log",
    });
    reporter.setStatus({ kind: "stopped", reason });
    break;
  }
  case "invalid-graph":
    reporter.setStatus(
      classifyPlanningError(new InvalidIssueGraphError("invalid graph")) ?? {
        kind: "aborted",
        reason: "Fixture failed to classify the graph error.",
      }
    );
    break;
  case "stale-empty":
    reporter.setStatus(
      getNoStandaloneIssuesStatus({
        skippedStaleSelection: true,
        standalonePathSelected: true,
      })
    );
    break;
  case "empty":
    reporter.setStatus(
      getNoStandaloneIssuesStatus({
        skippedStaleSelection: false,
        standalonePathSelected: true,
      })
    );
    break;
  case "throw-error":
    setImmediate(() => {
      throw new Error("fixture failure");
    });
    break;
  case "reject-object": {
    const reason: { code: string; self?: unknown } = {
      code: "fixture-rejection",
    };
    reason.self = reason;
    void Promise.reject(reason);
    break;
  }
  case "wait":
    console.log("READY");
    setInterval(() => undefined, 1_000);
    break;
  default:
    throw new Error(`Unknown fixture mode: ${process.argv[2] ?? "none"}`);
}
