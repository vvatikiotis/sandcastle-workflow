import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
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
