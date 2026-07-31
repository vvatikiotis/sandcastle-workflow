import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const expectedPrompts = [
  "final-spec-prompt.md",
  "implement-prompt.md",
  "merge-prompt.md",
  "review-prompt.md",
  "standalone-implement-prompt.md",
  "standalone-merge-prompt.md",
  "standalone-review-prompt.md",
];

const sourceDefaults = path.resolve("src", "defaults");
const outputDefaults = path.resolve("dist", "defaults");
const promptNames = (await readdir(path.join(sourceDefaults, "prompts"))).sort();

if (JSON.stringify(promptNames) !== JSON.stringify(expectedPrompts)) {
  throw new Error(
    `Expected exactly these packaged prompts: ${expectedPrompts.join(", ")}. Found: ${promptNames.join(", ")}.`
  );
}

await rm(outputDefaults, { recursive: true, force: true });
await mkdir(outputDefaults, { recursive: true });
await cp(sourceDefaults, outputDefaults, { recursive: true });
await chmod(path.resolve("dist", "cli.js"), 0o755);
