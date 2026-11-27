import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  cleanupStaleNodeModulesOverlays,
  createNodeModulesOverlay,
  closeSandboxWithNodeModulesOverlay,
  removeNodeModulesOverlay,
} from "../src/node-modules-overlay.ts";

async function createOverlayRoot() {
  return mkdtemp(path.join(os.tmpdir(), "sandcastle-node-modules-overlay-"));
}

describe("node_modules overlays", () => {
  it("creates distinct empty overlays mounted over the sandbox node_modules", async () => {
    const rootDirectory = await createOverlayRoot();

    try {
      const first = await createNodeModulesOverlay({
        rootDirectory,
        sandboxPath: "node_modules",
      });
      const second = await createNodeModulesOverlay({
        rootDirectory,
        sandboxPath: "node_modules",
      });

      assert.notEqual(first.directory, second.directory);
      assert.deepEqual(first.mount, {
        hostPath: first.directory,
        sandboxPath: "node_modules",
      });
      assert.deepEqual(await readdir(first.directory), []);
      assert.deepEqual(await readdir(second.directory), []);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("removes an overlay after its sandbox closes", async () => {
    const rootDirectory = await createOverlayRoot();

    try {
      const overlay = await createNodeModulesOverlay({
        rootDirectory,
        sandboxPath: "node_modules",
      });
      const closeResult = await closeSandboxWithNodeModulesOverlay(
        { close: async () => ({ preservedWorktreePath: "/kept" }) },
        overlay
      );

      assert.deepEqual(closeResult, { preservedWorktreePath: "/kept" });
      assert.equal(await directoryExists(overlay.directory), false);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("removes an overlay after its sandbox fails to close", async () => {
    const rootDirectory = await createOverlayRoot();
    const closeError = new Error("close failed");

    try {
      const overlay = await createNodeModulesOverlay({
        rootDirectory,
        sandboxPath: "node_modules",
      });
      await assert.rejects(
        closeSandboxWithNodeModulesOverlay(
          {
            close: async () => {
              throw closeError;
            },
          },
          overlay
        ),
        closeError
      );

      assert.equal(await directoryExists(overlay.directory), false);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("reports both close and cleanup failures", async () => {
    const rootDirectory = await createOverlayRoot();
    const closeError = new Error("close failed");

    try {
      const overlay = await createNodeModulesOverlay({
        rootDirectory,
        sandboxPath: "node_modules",
      });
      await assert.rejects(
        closeSandboxWithNodeModulesOverlay(
          {
            close: async () => {
              await chmod(rootDirectory, 0o500);
              throw closeError;
            },
          },
          overlay
        ),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.equal(error.errors[0], closeError);
          return true;
        }
      );
    } finally {
      await chmod(rootDirectory, 0o700);
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("removes overlays owned by dead processes and preserves live or malformed entries", async () => {
    const rootDirectory = await createOverlayRoot();
    const deadOverlay = path.join(rootDirectory, "2147483647-stale");
    const liveOverlay = path.join(rootDirectory, `${process.pid}-live`);
    const malformedOverlay = path.join(rootDirectory, "unknown-owner");

    try {
      await Promise.all([
        mkdir(deadOverlay),
        mkdir(liveOverlay),
        mkdir(malformedOverlay),
      ]);

      const result = await cleanupStaleNodeModulesOverlays(rootDirectory);

      assert.deepEqual(result.removed, [deadOverlay]);
      assert.deepEqual(
        result.preserved.sort(),
        [liveOverlay, malformedOverlay].sort()
      );
      assert.equal(await directoryExists(deadOverlay), false);
      assert.equal(await directoryExists(liveOverlay), true);
      assert.equal(await directoryExists(malformedOverlay), true);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("removes a specific overlay idempotently", async () => {
    const rootDirectory = await createOverlayRoot();

    try {
      const overlay = await createNodeModulesOverlay({
        rootDirectory,
        sandboxPath: "node_modules",
      });

      await removeNodeModulesOverlay(overlay);
      await removeNodeModulesOverlay(overlay);

      assert.equal(await directoryExists(overlay.directory), false);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});

async function directoryExists(directory) {
  try {
    await access(directory);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
