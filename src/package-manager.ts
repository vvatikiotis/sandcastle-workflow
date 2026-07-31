import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type SupportedPackageManager = {
  name: "npm" | "pnpm";
  major: 10 | 11;
  commands: {
    install: readonly string[];
    typecheck: readonly string[];
    test: readonly string[];
  };
};

const supportedManagers = {
  npm: {
    major: 10,
    lockfile: "package-lock.json",
    commands: {
      install: ["npm", "ci"],
      typecheck: ["npm", "run", "typecheck"],
      test: ["npm", "test"],
    },
  },
  pnpm: {
    major: 11,
    lockfile: "pnpm-lock.yaml",
    commands: {
      install: ["pnpm", "install", "--frozen-lockfile"],
      typecheck: ["pnpm", "typecheck"],
      test: ["pnpm", "test"],
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
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

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      throw new Error(
        `${path.basename(filePath)} must be a regular file at the Git root.`
      );
    }
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

function requireVerificationScripts(manifest: Record<string, unknown>): void {
  const scripts = manifest.scripts;
  if (!isRecord(scripts)) {
    throw new Error(
      "The consumer package.json must define root test and typecheck scripts."
    );
  }

  for (const scriptName of ["test", "typecheck"] as const) {
    if (
      !(scriptName in scripts) ||
      typeof scripts[scriptName] !== "string" ||
      scripts[scriptName].trim() === ""
    ) {
      throw new Error(
        `The consumer package.json must define a non-empty ${scriptName} script.`
      );
    }
  }
}

export async function resolvePackageManager(
  projectRoot: string
): Promise<SupportedPackageManager> {
  const manifestPath = path.join(projectRoot, "package.json");
  let manifestText: string;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read required consumer package.json at ${manifestPath}.`, {
      cause: error,
    });
  }

  const parsedManifest: unknown = JSON.parse(manifestText);
  if (!isRecord(parsedManifest)) {
    throw new Error(`${manifestPath} must contain a JSON object.`);
  }
  const manifest = parsedManifest;
  requireVerificationScripts(manifest);

  const npmLockfile = await regularFileExists(
    path.join(projectRoot, "package-lock.json")
  );
  const npmShrinkwrap = await pathExists(
    path.join(projectRoot, "npm-shrinkwrap.json")
  );
  const pnpmLockfile = await regularFileExists(
    path.join(projectRoot, "pnpm-lock.yaml")
  );
  if (npmShrinkwrap) {
    throw new Error(
      "npm-shrinkwrap.json is unsupported. Use package-lock.json for an npm 10 consumer."
    );
  }
  if (npmLockfile && pnpmLockfile) {
    throw new Error(
      "The consumer repository contains both package-lock.json and pnpm-lock.yaml. Keep exactly one supported lockfile."
    );
  }

  const declaration = manifest.packageManager;
  let managerName: "npm" | "pnpm";
  if (declaration === undefined) {
    if (!npmLockfile && !pnpmLockfile) {
      throw new Error(
        "The consumer repository needs package-lock.json or pnpm-lock.yaml when package.json has no packageManager declaration."
      );
    }
    managerName = npmLockfile ? "npm" : "pnpm";
  } else {
    if (typeof declaration !== "string") {
      throw new Error("The consumer packageManager declaration must be a string.");
    }
    const match = /^(npm|pnpm)@(\d+)(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.+-]+)?$/.exec(
      declaration
    );
    if (match === null) {
      throw new Error(
        `Unsupported or malformed consumer packageManager declaration: ${declaration}. Version 0.1.1 supports npm 10 and pnpm 11.`
      );
    }
    managerName = match[1] === "npm" ? "npm" : "pnpm";
    const declaredMajor = Number(match[2]);
    const expectedMajor = supportedManagers[managerName].major;
    if (declaredMajor !== expectedMajor) {
      throw new Error(
        `Unsupported ${managerName} major ${declaredMajor}. Version 0.1.1 supports ${managerName} ${expectedMajor}.`
      );
    }
  }

  const manager = supportedManagers[managerName];
  const hasExpectedLockfile = managerName === "npm" ? npmLockfile : pnpmLockfile;
  if (!hasExpectedLockfile) {
    throw new Error(`${managerName} requires ${manager.lockfile} at the Git root.`);
  }

  return {
    name: managerName,
    major: manager.major,
    commands: manager.commands,
  };
}
