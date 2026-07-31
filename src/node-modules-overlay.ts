import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

export type NodeModulesOverlay = {
  directory: string;
  mount: {
    hostPath: string;
    sandboxPath: string;
  };
};

export type StaleOverlayCleanup = {
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

/**
 * Runs one sandbox lifecycle and removes its overlay even when that lifecycle
 * fails. Retaining both errors makes a failed agent run distinguishable from a
 * host-storage cleanup failure.
 */
export async function withNodeModulesOverlay<T>(
  options: NodeModulesOverlayOptions,
  operation: (overlay: NodeModulesOverlay) => Promise<T>
): Promise<T> {
  const overlay = await createNodeModulesOverlay(options);
  let operationResult: OperationResult<T>;

  try {
    operationResult = { kind: "success", value: await operation(overlay) };
  } catch (error) {
    operationResult = { kind: "failure", error };
  }

  let cleanupResult: OperationResult<void>;
  try {
    await removeNodeModulesOverlay(overlay);
    cleanupResult = { kind: "success", value: undefined };
  } catch (error) {
    cleanupResult = { kind: "failure", error };
  }

  if (operationResult.kind === "failure" && cleanupResult.kind === "failure") {
    throw new AggregateError(
      [operationResult.error, cleanupResult.error],
      "Sandbox operation and node_modules overlay cleanup both failed."
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

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
