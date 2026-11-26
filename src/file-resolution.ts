import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export function isWithinDirectory(
  directory: string,
  candidate: string
): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export async function requireReadableRegularFile(
  filePath: string,
  description: string
): Promise<string> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) {
      throw new Error(`${description} must resolve to a regular file.`);
    }
    await access(resolvedPath, constants.R_OK);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(description)) {
      throw error;
    }
    throw new Error(`${description} must be a readable regular file.`, {
      cause: error,
    });
  }
  return resolvedPath;
}

// Workflow State holds credentials and logs, so only the owner may read it.
export async function requirePrivateDirectory(
  directoryPath: string
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directoryPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(
      `Sandcastle private state path ${directoryPath} must be a real directory.`
    );
  }
  await chmod(directoryPath, 0o700);
}
