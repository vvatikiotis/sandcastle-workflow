import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatAgentStartMessage } from "../src/agent-run-status.ts";

describe("agent run start status", () => {
  it("reports local time with its UTC offset and branch", () => {
    const startedAt = {
      getFullYear: () => 2026,
      getMonth: () => 6,
      getDate: () => 23,
      getHours: () => 19,
      getMinutes: () => 49,
      getTimezoneOffset: () => -180,
    };

    assert.equal(
      formatAgentStartMessage(
        "implementer: gpt-5.6-terra, high",
        "sandcastle/issue-170",
        startedAt
      ),
      "[implementer: gpt-5.6-terra, high] Started on branch sandcastle/issue-170 - 2026-07-23 19:49 UTC+3"
    );
  });

  it("formats non-hour UTC offsets", () => {
    const startedAt = {
      getFullYear: () => 2026,
      getMonth: () => 0,
      getDate: () => 5,
      getHours: () => 8,
      getMinutes: () => 7,
      getTimezoneOffset: () => 330,
    };

    assert.equal(
      formatAgentStartMessage("reviewer: model, medium", "main", startedAt),
      "[reviewer: model, medium] Started on branch main - 2026-01-05 08:07 UTC-5:30"
    );
  });
});
