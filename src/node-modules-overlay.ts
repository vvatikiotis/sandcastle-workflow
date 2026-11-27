import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { getErrorCode } from "./error-code.ts";

export type NodeModulesOverlay = {
  directory: string;
  mount: {
    hostPath: string;
    sandboxPath: string;
  };
};

type StaleOverlayCleanup = {
  removed: string[];
  preserved: string[];
};

type NodeModulesOverlayOptions = {
  rootDirectory: string;
  sandboxPath: string;
};

type OperationResult<T> =
  { kind: "success"; value: T } | { kind: "failure"; error: unknown };

const overlayDirectoryName = /^(\d+)-[A-Za-z0-9]+$/;

/**
 * Creates a Linux-only dependency directory that masks node_modules from the
 * repository bind mount. Overlays are disposable, per-sandbox storage, not a
 * pnpm store or a cache that can be shared between agent lifecycles.
 */
export async function createNodeModulesOverlay({
  rootDirectory,
  sandboxPath,
}: NodeModulesOverlayOptions): Promise<NodeModulesOverlay> {
  const resolvedRootDirectory = path.resolve(rootDirectory);
  await mkdir(resolvedRootDirectory, { recursive: true });
  const directory = await mkdtemp(
    path.join(resolvedRootDirectory, `${process.pid}-`)
  );

  return {
    directory,
    mount: {
      hostPath: directory,
      sandboxPath,
    },
  };
}

/**
 * Removes an overlay only after its Docker sandbox has closed. Docker owns the
 * mount, but this runner owns the host-backed directory and must delete it.
 */
export async function removeNodeModulesOverlay(
  overlay: NodeModulesOverlay
): Promise<void> {
  await rm(overlay.directory, { recursive: true, force: true });
}

async function settle<T>(
  operation: () => Promise<T>
): Promise<OperationResult<T>> {
  try {
    return { kind: "success", value: await operation() };
  } catch (error) {
    return { kind: "failure", error };
  }
}

/**
 * Removes an overlay after the operation that used it, even when that
 * operation fails. Retaining both errors makes a failed sandbox operation
 * distinguishable from a host-storage cleanup failure.
 */
async function removeOverlayAfter<T>(
  overlay: NodeModulesOverlay,
  operation: () => Promise<T>,
  bothFailedMessage: string
): Promise<T> {
  const operationResult = await settle(operation);
  const cleanupResult = await settle(() => removeNodeModulesOverlay(overlay));

  if (operationResult.kind === "failure" && cleanupResult.kind === "failure") {
    throw new AggregateError(
      [operationResult.error, cleanupResult.error],
      bothFailedMessage
    );
  }
  if (operationResult.kind === "failure") {
    throw operationResult.error;
  }
  if (cleanupResult.kind === "failure") {
    throw cleanupResult.error;
  }

  return operationResult.value;
}

/** Closes a sandbox that mounts the overlay, then removes the overlay. */
export async function closeSandboxWithNodeModulesOverlay<T>(
  sandbox: { close: () => Promise<T> },
  overlay: NodeModulesOverlay
): Promise<T> {
  return removeOverlayAfter(
    overlay,
    () => sandbox.close(),
    "Sandbox closure and node_modules overlay cleanup both failed."
  );
}

/**
 * Removes directories left by dead runners. A live, malformed, or unverifiable
 * owner is preserved: a harmless disk leak is safer than deleting dependencies
 * that another Sandcastle process may still be using.
 */
export async function cleanupStaleNodeModulesOverlays(
  rootDirectory: string
): Promise<StaleOverlayCleanup> {
  const resolvedRootDirectory = path.resolve(rootDirectory);
  let entries;

  try {
    entries = await readdir(resolvedRootDirectory, { withFileTypes: true });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { removed: [], preserved: [] };
    }
    throw error;
  }

  const removed: string[] = [];
  const preserved: string[] = [];

  for (const entry of entries) {
    const directory = path.join(resolvedRootDirectory, entry.name);
    const ownerProcessId = getOverlayOwnerProcessId(entry.name);

    if (!entry.isDirectory() || ownerProcessId === undefined) {
      preserved.push(directory);
      continue;
    }

    if (getProcessState(ownerProcessId) !== "dead") {
      preserved.push(directory);
      continue;
    }

    await rm(directory, { recursive: true, force: true });
    removed.push(directory);
  }

  return { removed, preserved };
}

function getOverlayOwnerProcessId(name: string): number | undefined {
  const match = overlayDirectoryName.exec(name);
  const ownerProcessId =
    match?.[1] === undefined ? undefined : Number(match[1]);

  return ownerProcessId !== undefined &&
    Number.isSafeInteger(ownerProcessId) &&
    ownerProcessId > 0
    ? ownerProcessId
    : undefined;
}

function getProcessState(processId: number): "live" | "dead" | "unknown" {
  try {
    process.kill(processId, 0);
    return "live";
  } catch (error) {
    return getErrorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}
