// Node reports a failure's cause through a `code` property: a string such as
// "ENOENT" for a filesystem error, or the exit status for a failed child
// process.
export function getErrorCode(error: unknown): string | number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
    ? error.code
    : undefined;
}
