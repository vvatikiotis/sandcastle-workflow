import { lstat, open, unlink, type FileHandle } from "node:fs/promises";

export type RunLock = {
  release: () => Promise<void>;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function closeAfterFailure(
  handle: FileHandle,
  error: unknown
): Promise<never> {
  try {
    await handle.close();
  } catch {
    // Preserve the original failure. Process exit will close the descriptor.
  }
  throw error;
}

export async function acquireRunLock(lockPath: string): Promise<RunLock> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        `Another Sandcastle workflow run already owns ${lockPath}. Inspect the recorded process before removing a confirmed-stale lock; never remove a live run's lock.`
      );
    }
    throw new Error(`Could not create Sandcastle run lock ${lockPath}.`, {
      cause: error,
    });
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
    );
    await handle.sync();
  } catch (error) {
    return closeAfterFailure(
      handle,
      new Error(
        `Could not initialize Sandcastle run lock ${lockPath}. The lock was preserved for inspection.`,
        { cause: error }
      )
    );
  }

  const owner = await handle.stat();
  let released = false;

  return {
    release: async (): Promise<void> => {
      if (released) {
        return;
      }

      let current;
      try {
        current = await lstat(lockPath);
      } catch (error) {
        return closeAfterFailure(
          handle,
          new Error(
            `Sandcastle run lock ${lockPath} disappeared before release. Refusing to remove any replacement.`,
            { cause: error }
          )
        );
      }

      if (
        current.isSymbolicLink() ||
        current.dev !== owner.dev ||
        current.ino !== owner.ino
      ) {
        return closeAfterFailure(
          handle,
          new Error(
            `Sandcastle run lock ${lockPath} was replaced while the run was active. Refusing to remove it.`
          )
        );
      }

      try {
        await unlink(lockPath);
        released = true;
        await handle.close();
      } catch (error) {
        throw new Error(`Could not release Sandcastle run lock ${lockPath}.`, {
          cause: error,
        });
      }
    },
  };
}
