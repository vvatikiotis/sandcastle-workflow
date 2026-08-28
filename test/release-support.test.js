import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveReleaseVersion,
  updateConsumerVersion,
} from "../scripts/release-support.mjs";

describe("maintainer release support", () => {
  it("resolves patch, minor, major, and exact release versions", () => {
    assert.equal(resolveReleaseVersion("0.5.1", "patch"), "0.5.2");
    assert.equal(resolveReleaseVersion("0.5.1", "minor"), "0.6.0");
    assert.equal(resolveReleaseVersion("0.5.1", "major"), "1.0.0");
    assert.equal(resolveReleaseVersion("0.5.1", "0.7.3"), "0.7.3");
  });

  it("rejects malformed or non-increasing release versions", () => {
    assert.throws(
      () => resolveReleaseVersion("0.5.1", "next"),
      /patch, minor, major, or an exact version/,
    );
    assert.throws(
      () => resolveReleaseVersion("0.5.1", "0.5.1"),
      /must be newer/,
    );
    assert.throws(
      () => resolveReleaseVersion("0.5.1", "0.5.0"),
      /must be newer/,
    );
  });

  it("updates current consumer release references", () => {
    const document = [
      "Install version `0.5.1`.",
      "VERSION=0.5.1",
      "artifact-0.5.1.tgz",
    ].join("\n");

    assert.equal(
      updateConsumerVersion(document, "0.5.1", "0.5.2"),
      ["Install version `0.5.2`.", "VERSION=0.5.2", "artifact-0.5.2.tgz"].join(
        "\n",
      ),
    );
  });

  it("rejects consumer documentation without the current version", () => {
    assert.throws(
      () => updateConsumerVersion("No release reference", "0.5.1", "0.5.2"),
      /does not reference current version/,
    );
  });
});
