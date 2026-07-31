import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getBlockedReadyChildren,
  getEligibleChildren,
  getIssueStatus,
  selectRunSpec,
  selectSpecCandidates,
  selectStandaloneCandidates,
  validateSpecGraph,
} from "../src/spec-selection.ts";

const readySpec = {
  id: "132",
  title: "Spec",
  createdAt: "2026-07-13T16:16:03Z",
  parentId: null,
};

const readyChild = {
  id: "133",
  title: "Probe",
  status: "ready-for-agent",
  blockerIds: [],
  blocksParent: true,
};

describe("Sandcastle native sub-issue selection", () => {
  it("uses GitHub sub-issue order and preserves closed children", () => {
    const result = selectSpecCandidates({
      readyIssues: [
        {
          id: "133",
          title: "Probe",
          createdAt: "2026-07-13T16:16:43Z",
          parentId: "132",
        },
        readySpec,
      ],
      childrenByParent: new Map([
        [
          "132",
          [
            readyChild,
            {
              id: "134",
              title: "Earlier",
              status: "closed",
              blockerIds: [],
              blocksParent: true,
            },
          ],
        ],
      ]),
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.candidates, [
      {
        ...readySpec,
        children: [
          readyChild,
          {
            id: "134",
            title: "Earlier",
            status: "closed",
            blockerIds: [],
            blocksParent: true,
          },
        ],
      },
    ]);
  });

  it("supports GitHub's maximum of 100 direct sub-issues", () => {
    const children = Array.from({ length: 100 }, (_, index) => ({
      ...readyChild,
      id: String(200 + index),
      title: `Child ${index + 1}`,
    }));
    const result = selectSpecCandidates({
      readyIssues: [
        readySpec,
        ...children.map((child, index) => ({
          id: child.id,
          title: child.title,
          createdAt: `2026-07-13T16:${String(index).padStart(2, "0")}:43Z`,
          parentId: readySpec.id,
        })),
      ],
      childrenByParent: new Map([[readySpec.id, children]]),
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.candidates[0]?.children.length, 100);
  });

  it("keeps later iterations scoped to the first selected spec", () => {
    const candidates = [
      { ...readySpec, children: [readyChild] },
      {
        id: "140",
        title: "Other spec",
        createdAt: "2026-07-14T00:00:00Z",
        parentId: null,
        children: [{ ...readyChild, id: "141" }],
      },
    ];

    assert.equal(selectRunSpec(candidates, undefined)?.id, "132");
    assert.equal(selectRunSpec(candidates, "132")?.id, "132");
  });

  it("skips blocked ready children and selects a later eligible sibling", () => {
    const children = [
      { ...readyChild, id: "133", blockerIds: ["134"] },
      { ...readyChild, id: "134", title: "Independent" },
    ];

    assert.deepEqual(
      getEligibleChildren(children).map((child) => child.id),
      ["134"]
    );
    assert.deepEqual(
      getBlockedReadyChildren(children).map((child) => child.id),
      ["133"]
    );
  });

  it("rejects a cross-scope blocker and missing child-to-parent completion edge", () => {
    assert.deepEqual(
      validateSpecGraph({
        ...readySpec,
        children: [
          {
            ...readyChild,
            blockerIds: ["999"],
            blocksParent: false,
          },
        ],
      }),
      [
        "Child issue #133 does not block spec #132.",
        "Child issue #133 has cross-scope blocker #999; it is not a direct child of spec #132.",
      ]
    );
  });

  it("rejects an in-scope dependency cycle", () => {
    assert.deepEqual(
      validateSpecGraph({
        ...readySpec,
        children: [
          { ...readyChild, id: "133", blockerIds: ["134"] },
          { ...readyChild, id: "134", blockerIds: ["133"] },
        ],
      }),
      ["Spec #132 has dependency cycle: #133 → #134 → #133."]
    );
  });

  it("selects ready roots without native children as standalone issues", () => {
    const result = selectSpecCandidates({
      readyIssues: [
        {
          id: "150",
          title: "Orphan",
          createdAt: "2026-07-14T00:00:00Z",
          parentId: null,
        },
        {
          id: "133",
          title: "Probe",
          createdAt: "2026-07-13T16:16:43Z",
          parentId: "151",
        },
      ],
      childrenByParent: new Map(),
    });

    assert.deepEqual(result.errors, [
      "Ready child issue #133 belongs to non-ready or non-spec parent #151.",
    ]);
    assert.deepEqual(
      selectStandaloneCandidates({
        readyIssues: [
          {
            id: "150",
            title: "Orphan",
            createdAt: "2026-07-14T00:00:00Z",
            parentId: null,
          },
          {
            id: "152",
            title: "Standalone earlier",
            createdAt: "2026-07-13T00:00:00Z",
            parentId: null,
          },
        ],
        childrenByParent: new Map(),
      }).map((issue) => issue.id),
      ["152", "150"]
    );
  });

  it("derives Sandcastle status from GitHub state and labels", () => {
    assert.equal(
      getIssueStatus({ state: "CLOSED", labels: ["ready-for-agent"] }),
      "closed"
    );
    assert.equal(
      getIssueStatus({ state: "OPEN", labels: ["needs-info"] }),
      "needs-info"
    );
    assert.equal(getIssueStatus({ state: "OPEN", labels: [] }), "open");
  });
});
