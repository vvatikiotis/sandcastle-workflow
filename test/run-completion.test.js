import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "run-completion.fixture.ts"
);
const ansi = {
  blue: "\u001b[34m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};

async function runFixture(mode) {
  const child = spawn(process.execPath, [fixturePath, mode], {
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

async function signalFixture(signal) {
  const child = spawn(process.execPath, [fixturePath, "wait"], {
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let signalSent = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!signalSent && stdout.includes("READY")) {
      signalSent = true;
      child.kill(signal);
    }
  });
  const [code] = await once(child, "close");
  return { code, stdout };
}

describe("Sandcastle run completion reporting", () => {
  it("prints one colored completed summary", async () => {
    const result = await runFixture("completed-twice");

    assert.equal(result.code, 0);
    assert.equal(result.stdout.match(/SANDCASTLE RUN:/g)?.length, 1);
    assert.ok(result.stdout.includes(`${ansi.blue}SANDCASTLE RUN:`));
    assert.ok(result.stdout.includes(`${ansi.green}COMPLETED`));
    assert.ok(result.stdout.includes(`${ansi.green}yes`));
  });

  it("prints stopped and aborted outcomes with their status colors", async () => {
    const stopped = await runFixture("stopped");
    const aborted = await runFixture("aborted");

    assert.ok(stopped.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.ok(aborted.stdout.includes(`${ansi.red}ABORTED`));
  });

  it("prints non-success phase diagnostics immediately and in the final summary", async () => {
    const result = await runFixture("phase-failure");

    for (const output of [result.stderr, result.stdout]) {
      assert.match(output, /Reviewer for issue #42/);
      assert.match(output, /Tests failed/);
      assert.match(output, /.sandcastle\/logs\/reviewer.log/);
    }
  });

  it("stops for invalid issue graphs and stale standalone exhaustion", async () => {
    const invalidGraph = await runFixture("invalid-graph");
    const staleEmpty = await runFixture("stale-empty");
    const empty = await runFixture("empty");

    assert.ok(invalidGraph.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(invalidGraph.stdout, /sub-issue validation failed/);
    assert.ok(staleEmpty.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(staleEmpty.stdout, /stale selections were replanned/);
    assert.ok(empty.stdout.includes(`${ansi.green}COMPLETED`));
  });

  it("stops and lists open blockers when every standalone issue is blocked", async () => {
    const blocked = await runFixture("blocked-empty");

    assert.ok(blocked.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(blocked.stdout, /#42 Blocked is waiting on open blockers: #7/);
  });

  it("preserves Error stacks and inspects circular rejection values", async () => {
    const error = await runFixture("throw-error");
    const object = await runFixture("reject-object");

    assert.equal(error.code, 1);
    assert.ok(error.stderr.includes(ansi.red));
    assert.match(error.stderr, /Error: fixture failure/);
    assert.match(error.stderr, /run-completion\.fixture\.ts/);
    assert.equal(object.code, 1);
    assert.match(object.stderr, /code: 'fixture-rejection'/);
    assert.match(object.stderr, /Circular/);
    assert.doesNotMatch(object.stderr, /\[object Object\]/);
  });

  for (const [signal, exitCode] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    it(`preserves the conventional ${signal} exit status`, async () => {
      const result = await signalFixture(signal);

      assert.equal(result.code, exitCode);
      assert.equal(result.stdout.match(/SANDCASTLE RUN:/g)?.length, 1);
      assert.ok(result.stdout.includes(`${ansi.red}ABORTED`));
      assert.ok(result.stdout.includes(`Received ${signal}`));
    });
  }
});
