import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const fixturePath = path.resolve(
  ".sandcastle",
  "test",
  "run-completion.fixture.ts"
);
const ansi = {
  blue: "\u001b[34m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};
const validRunnerConfig = [
  "IMPLEMENTER_MODEL=test-model",
  "IMPLEMENTER_EFFORT=low",
  "REVIEWER_MODEL=test-model",
  "REVIEWER_EFFORT=low",
  "MERGER_MODEL=test-model",
  "MERGER_EFFORT=low",
  "FINAL_SPEC_REVIEWER_MODEL=test-model",
  "FINAL_SPEC_REVIEWER_EFFORT=low",
  "MAX_ITERATIONS=10",
  "",
].join("\n");

async function runFixture(mode) {
  const child = spawn(process.execPath, [fixturePath, mode], {
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

async function runMain({
  agentEnvironment = "GH_TOKEN=test-token\n",
  ghScript = '#!/bin/sh\nif [ "$1 $2" = "issue list" ]; then printf "[]\\n"; else exit 1; fi\n',
  args = ["--dry-run"],
  createRunnerConfig = true,
  dockerScript,
  hostGhToken,
  invokeFromNestedDirectory = false,
  invokeOutsideWorktree = false,
  gitScript,
  inspectProject,
  invocationCount = 1,
  runnerConfig = validRunnerConfig,
  signal,
  setupRepository,
  setupProject,
  workflowInProject = true,
}) {
  const root = process.cwd();
  const tempRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "sandcastle-summary-"))
  );
  const outsideDirectory = invokeOutsideWorktree
    ? await mkdtemp(path.join(os.tmpdir(), "sandcastle-outside-"))
    : undefined;

  try {
    if (workflowInProject) {
      await mkdir(path.join(tempRoot, ".sandcastle"));
      for (const filename of [
        "agent-run-status.ts",
        "docker-image.ts",
        "file-resolution.ts",
        "initialization.ts",
        "main.ts",
        "node-modules-overlay.ts",
        "phase-diagnostics.ts",
        "prompt-resolution.ts",
        "recovery-routing.ts",
        "run-completion.ts",
        "spec-selection.ts",
        "verification-worktree-cleanup.ts",
        "verification-worktree-paths.ts",
        "workflow-completion.ts",
      ]) {
        await cp(
          path.join(root, ".sandcastle", filename),
          path.join(tempRoot, ".sandcastle", filename)
        );
      }
      await cp(
        path.join(root, ".sandcastle", "defaults"),
        path.join(tempRoot, ".sandcastle", "defaults"),
        { recursive: true }
      );
      await cp(
        path.join(root, ".sandcastle", ".gitignore"),
        path.join(tempRoot, ".sandcastle", ".gitignore")
      );
    }
    await cp(
      path.join(root, "CODING_STANDARDS.md"),
      path.join(tempRoot, "CODING_STANDARDS.md")
    );
    if (setupProject !== undefined) {
      await setupProject(tempRoot);
    }
    if (createRunnerConfig) {
      await mkdir(path.join(tempRoot, ".sandcastle"), { recursive: true });
      await writeFile(
        path.join(tempRoot, ".sandcastle", "sandcastle.env"),
        runnerConfig
      );
    }
    if (typeof agentEnvironment === "string" && createRunnerConfig) {
      await writeFile(
        path.join(tempRoot, ".sandcastle", ".env"),
        agentEnvironment
      );
    }
    await symlink(
      path.join(root, "node_modules"),
      path.join(tempRoot, "node_modules")
    );

    const binPath = path.join(tempRoot, "bin");
    const ghPath = path.join(binPath, "gh");
    await mkdir(binPath);
    await writeFile(ghPath, ghScript);
    await chmod(ghPath, 0o755);
    if (dockerScript !== undefined) {
      const dockerPath = path.join(binPath, "docker");
      await writeFile(dockerPath, dockerScript);
      await chmod(dockerPath, 0o755);
    }
    if (gitScript !== undefined) {
      const gitPath = path.join(binPath, "git");
      await writeFile(gitPath, gitScript);
      await chmod(gitPath, 0o755);
    }

    execFileSync("git", ["init", "--quiet"], { cwd: tempRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempRoot,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tempRoot });
    execFileSync("git", ["add", "."], { cwd: tempRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: tempRoot,
    });
    if (setupRepository !== undefined) {
      await setupRepository(tempRoot);
    }

    const invocationDirectory =
      outsideDirectory ??
      (invokeFromNestedDirectory
        ? path.join(tempRoot, "nested", "directory")
        : tempRoot);
    if (invokeFromNestedDirectory) {
      await mkdir(invocationDirectory, { recursive: true });
    }

    let code = 0;
    let stdout = "";
    let stderr = "";
    for (let invocation = 0; invocation < invocationCount; invocation += 1) {
      const mainPath = workflowInProject
        ? path.join(tempRoot, ".sandcastle", "main.ts")
        : path.join(root, ".sandcastle", "main.ts");
      const childEnvironment = {
        ...process.env,
        FORCE_COLOR: "1",
        PATH: `${binPath}:${process.env.PATH ?? ""}`,
        SANDCASTLE_EXPECTED_ROOT: tempRoot,
        SANDCASTLE_DOCKER_CAPTURE: path.join(tempRoot, "docker-args"),
        SANDCASTLE_REAL_GIT: execFileSync("which", ["git"], {
          encoding: "utf8",
        }).trim(),
      };
      if (hostGhToken === undefined) {
        delete childEnvironment.GH_TOKEN;
      } else {
        childEnvironment.GH_TOKEN = hostGhToken;
      }
      const child = spawn(process.execPath, [mainPath, ...args], {
        cwd: invocationDirectory,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let signalSent = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (signal && !signalSent && stdout.includes("=== Iteration")) {
          signalSent = true;
          child.kill(signal);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      [code] = await once(child, "close");
      if (code !== 0) {
        break;
      }
    }
    const outsideEntries =
      outsideDirectory === undefined
        ? undefined
        : await readdir(outsideDirectory);
    const projectInspection =
      inspectProject === undefined ? undefined : await inspectProject(tempRoot);
    return { code, stdout, stderr, outsideEntries, projectInspection };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    if (outsideDirectory !== undefined) {
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  }
}

async function signalFixture(signal) {
  const child = spawn(process.execPath, [fixturePath, "wait"], {
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let signalSent = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!signalSent && stdout.includes("READY")) {
      signalSent = true;
      child.kill(signal);
    }
  });
  const [code] = await once(child, "close");
  return { code, stdout };
}

describe("Sandcastle run completion reporting", () => {
  it("builds the derived image from the minimal built-in Docker context", async () => {
    const result = await runMain({
      args: ["build-image"],
      dockerScript:
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$SANDCASTLE_DOCKER_CAPTURE"\n',
      workflowInProject: false,
      inspectProject: async (projectRoot) => ({
        projectRoot,
        dockerArgs: (
          await readFile(path.join(projectRoot, "docker-args"), "utf8")
        )
          .trim()
          .split("\n"),
      }),
    });

    const projectName = path
      .basename(result.projectInspection.projectRoot)
      .toLowerCase();
    const imageName = `sandcastle:${projectName}`;
    const dockerfilePath = path.join(
      process.cwd(),
      ".sandcastle",
      "defaults",
      "docker",
      "Dockerfile"
    );
    const contextPath = path.dirname(dockerfilePath);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Docker image: ${imageName}`));
    assert.match(result.stdout, new RegExp(`Dockerfile: ${dockerfilePath}`));
    assert.match(result.stdout, new RegExp(`Build context: ${contextPath}`));
    assert.deepEqual(result.projectInspection.dockerArgs, [
      "build",
      "--build-arg",
      `AGENT_UID=${process.getuid?.() ?? 1000}`,
      "--build-arg",
      `AGENT_GID=${process.getgid?.() ?? 1000}`,
      "--file",
      dockerfilePath,
      "--tag",
      imageName,
      contextPath,
    ]);
  });

  it("builds an explicit registry image from a safe project Dockerfile override", async () => {
    const imageName = "registry.example.com/team/agent:release-1";
    const result = await runMain({
      args: ["build-image"],
      dockerScript:
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$SANDCASTLE_DOCKER_CAPTURE"\n',
      runnerConfig: `${validRunnerConfig}DOCKER_IMAGE=${imageName}\n`,
      setupProject: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".sandcastle", "Dockerfile"),
          "FROM scratch\n"
        );
      },
      inspectProject: async (projectRoot) => ({
        projectRoot,
        dockerArgs: (
          await readFile(path.join(projectRoot, "docker-args"), "utf8")
        )
          .trim()
          .split("\n"),
      }),
    });

    const dockerfilePath = path.join(
      result.projectInspection.projectRoot,
      ".sandcastle",
      "Dockerfile"
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Docker image: ${imageName}`));
    assert.match(
      result.stdout,
      new RegExp(`Dockerfile: ${dockerfilePath} \\(project override\\)`)
    );
    assert.match(
      result.stdout,
      new RegExp(`Build context: ${result.projectInspection.projectRoot}`)
    );
    assert.deepEqual(result.projectInspection.dockerArgs.slice(-5), [
      "--file",
      dockerfilePath,
      "--tag",
      imageName,
      result.projectInspection.projectRoot,
    ]);
  });

  it("rejects an empty configured image and ad hoc build overrides", async () => {
    const emptyImage = await runMain({
      args: ["build-image"],
      runnerConfig: `${validRunnerConfig}DOCKER_IMAGE=\n`,
      dockerScript: "#!/bin/sh\nexit 99\n",
    });
    const adHocOverride = await runMain({
      args: ["build-image", "--image-name", "other:image"],
      dockerScript: "#!/bin/sh\nexit 99\n",
    });

    assert.equal(emptyImage.code, 1);
    assert.match(emptyImage.stderr, /DOCKER_IMAGE must not be empty/);
    assert.equal(adHocOverride.code, 1);
    assert.match(
      adHocOverride.stderr,
      /does not accept arguments or image-name overrides/
    );
  });

  it("rejects unsafe project Dockerfile overrides", async () => {
    const escapingSymlink = await runMain({
      args: ["build-image"],
      dockerScript: "#!/bin/sh\nexit 99\n",
      setupProject: async (projectRoot) => {
        await symlink(
          "/etc/hosts",
          path.join(projectRoot, ".sandcastle", "Dockerfile")
        );
      },
    });
    const directory = await runMain({
      args: ["build-image"],
      dockerScript: "#!/bin/sh\nexit 99\n",
      setupProject: async (projectRoot) => {
        await mkdir(path.join(projectRoot, ".sandcastle", "Dockerfile"));
      },
    });

    assert.equal(escapingSymlink.code, 1);
    assert.match(
      escapingSymlink.stderr,
      /Project Dockerfile override resolves outside the active Git worktree/
    );
    assert.equal(directory.code, 1);
    assert.match(
      directory.stderr,
      /Project Dockerfile override must resolve to a regular file/
    );
  });

  it("shows help and version without configuration, credentials, or Docker", async () => {
    const [help, version] = await Promise.all([
      runMain({
        args: ["--help"],
        createRunnerConfig: false,
        dockerScript: "#!/bin/sh\nexit 99\n",
        ghScript: "#!/bin/sh\nexit 99\n",
        workflowInProject: false,
      }),
      runMain({
        args: ["--version"],
        createRunnerConfig: false,
        dockerScript: "#!/bin/sh\nexit 99\n",
        ghScript: "#!/bin/sh\nexit 99\n",
        workflowInProject: false,
      }),
    ]);

    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Usage: pnpm sandcastle/);
    assert.match(help.stdout, /build-image/);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), "1");
  });

  it("initializes sanitized project-local configuration without active or runtime state", async () => {
    const result = await runMain({
      args: ["init"],
      createRunnerConfig: false,
      ghScript: "#!/bin/sh\nexit 99\n",
      workflowInProject: false,
      inspectProject: async (projectRoot) => {
        const sandcastleRoot = path.join(projectRoot, ".sandcastle");
        const ignoreMatches = [
          ".sandcastle/.env",
          ".sandcastle/sandcastle.env",
          ".sandcastle/logs/run.log",
          ".sandcastle/worktrees/issue",
          ".sandcastle/node-modules-overlays/overlay",
          ".sandcastle/merger-recovery.json",
          ".sandcastle/.gitignore",
          ".sandcastle/.env.example",
          ".sandcastle/sandcastle.env.example",
        ].filter((candidate) => {
          try {
            execFileSync(
              "git",
              ["check-ignore", "--quiet", "--no-index", candidate],
              { cwd: projectRoot }
            );
            return true;
          } catch {
            return false;
          }
        });
        return {
          projectRoot,
          ignore: await readFile(
            path.join(sandcastleRoot, ".gitignore"),
            "utf8"
          ),
          runnerExample: await readFile(
            path.join(sandcastleRoot, "sandcastle.env.example"),
            "utf8"
          ),
          agentExample: await readFile(
            path.join(sandcastleRoot, ".env.example"),
            "utf8"
          ),
          entries: await readdir(sandcastleRoot),
          ignoreMatches,
        };
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Created .*\/\.sandcastle$/m);
    assert.match(result.stdout, /Created .*\.sandcastle\/\.gitignore/);
    assert.match(
      result.stdout,
      /Created .*\.sandcastle\/sandcastle\.env\.example/
    );
    assert.match(result.stdout, /Created .*\.sandcastle\/\.env\.example/);
    assert.match(result.stdout, /Next steps:/);

    const inspection = result.projectInspection;
    assert.match(inspection.ignore, /^\.env$/m);
    assert.match(inspection.ignore, /^sandcastle\.env$/m);
    assert.match(inspection.ignore, /^logs\/$/m);
    assert.match(inspection.ignore, /^worktrees\/$/m);
    assert.match(inspection.ignore, /^node-modules-overlays\/$/m);
    assert.match(inspection.ignore, /^merger-recovery\.json$/m);
    assert.match(
      inspection.runnerExample,
      /^# Runner-only agent configuration\. These values are not forwarded to agents\.$/m
    );
    for (const key of [
      "IMPLEMENTER_MODEL",
      "IMPLEMENTER_EFFORT",
      "REVIEWER_MODEL",
      "REVIEWER_EFFORT",
      "MERGER_MODEL",
      "MERGER_EFFORT",
      "FINAL_SPEC_REVIEWER_MODEL",
      "FINAL_SPEC_REVIEWER_EFFORT",
      "MAX_ITERATIONS",
    ]) {
      assert.match(inspection.runnerExample, new RegExp(`^${key}=$`, "m"));
    }
    assert.match(
      inspection.runnerExample,
      /^# DOCKER_IMAGE=sandcastle:<project>$/m
    );
    assert.match(
      inspection.agentExample,
      /forwarded to agents for GitHub Issues access/
    );
    assert.match(
      inspection.agentExample,
      /Leave empty to use a non-empty GH_TOKEN from the host environment/
    );
    assert.match(inspection.agentExample, /^GH_TOKEN=$/m);
    assert.doesNotMatch(inspection.agentExample, /^GH_TOKEN=.+$/m);
    assert.deepEqual(inspection.ignoreMatches, [
      ".sandcastle/.env",
      ".sandcastle/sandcastle.env",
      ".sandcastle/logs/run.log",
      ".sandcastle/worktrees/issue",
      ".sandcastle/node-modules-overlays/overlay",
      ".sandcastle/merger-recovery.json",
    ]);
    for (const absentEntry of [
      ".env",
      "sandcastle.env",
      "logs",
      "worktrees",
      "node-modules-overlays",
      "merger-recovery.json",
    ]) {
      assert.ok(!inspection.entries.includes(absentEntry), absentEntry);
    }
  });

  it("preserves existing initialization files across repeated nested invocations", async () => {
    const result = await runMain({
      args: ["init"],
      createRunnerConfig: false,
      invocationCount: 2,
      invokeFromNestedDirectory: true,
      setupProject: async (projectRoot) => {
        const sandcastleRoot = path.join(projectRoot, ".sandcastle");
        await writeFile(
          path.join(sandcastleRoot, ".gitignore"),
          "custom ignore rules\n"
        );
        await writeFile(
          path.join(sandcastleRoot, "sandcastle.env.example"),
          "custom runner example\n"
        );
        await writeFile(
          path.join(sandcastleRoot, ".env.example"),
          "custom agent example\n"
        );
      },
      inspectProject: async (projectRoot) => {
        const sandcastleRoot = path.join(projectRoot, ".sandcastle");
        return {
          projectRoot,
          ignore: await readFile(
            path.join(sandcastleRoot, ".gitignore"),
            "utf8"
          ),
          runnerExample: await readFile(
            path.join(sandcastleRoot, "sandcastle.env.example"),
            "utf8"
          ),
          agentExample: await readFile(
            path.join(sandcastleRoot, ".env.example"),
            "utf8"
          ),
        };
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.match(/Sandcastle project root:/g)?.length, 2);
    assert.equal(
      result.stdout.match(
        new RegExp(
          `Sandcastle project root: ${result.projectInspection.projectRoot.replaceAll("\\", "\\\\")}`,
          "g"
        )
      )?.length,
      2
    );
    assert.equal(result.projectInspection.ignore, "custom ignore rules\n");
    assert.equal(
      result.projectInspection.runnerExample,
      "custom runner example\n"
    );
    assert.equal(
      result.projectInspection.agentExample,
      "custom agent example\n"
    );
    assert.equal(result.stdout.match(/Preserved .*\.gitignore/g)?.length, 2);
    assert.equal(
      result.stdout.match(/Preserved .*sandcastle\.env\.example/g)?.length,
      2
    );
    assert.equal(
      result.stdout.match(/Preserved .*\/\.env\.example/g)?.length,
      2
    );
  });

  it("rejects a symbolic Sandcastle directory before writing outside the project", async () => {
    let redirectedRoot;

    try {
      const result = await runMain({
        args: ["init"],
        createRunnerConfig: false,
        workflowInProject: false,
        setupProject: async (projectRoot) => {
          redirectedRoot = await mkdtemp(
            path.join(os.tmpdir(), "sandcastle-init-redirect-")
          );
          await symlink(redirectedRoot, path.join(projectRoot, ".sandcastle"));
        },
        inspectProject: async () => ({
          redirectedEntries: await readdir(redirectedRoot),
        }),
      });

      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /Refusing to initialize through symbolic Sandcastle directory/
      );
      assert.deepEqual(result.projectInspection.redirectedEntries, []);
    } finally {
      if (redirectedRoot !== undefined) {
        await rm(redirectedRoot, { recursive: true, force: true });
      }
    }
  });

  it("reports all seven built-in prompt defaults through absolute paths", async () => {
    const result = await runMain({});

    assert.equal(result.code, 0, result.stderr);
    for (const filename of [
      "implement-prompt.md",
      "review-prompt.md",
      "merge-prompt.md",
      "standalone-implement-prompt.md",
      "standalone-review-prompt.md",
      "standalone-merge-prompt.md",
      "final-spec-prompt.md",
    ]) {
      assert.match(
        result.stdout,
        new RegExp(
          `Prompt ${filename}: built-in .*/\\.sandcastle/defaults/prompts/${filename}`
        )
      );
    }
  });

  it("selects and reports one matching project prompt override independently", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        const filename = "review-prompt.md";
        const builtInPath = path.join(
          projectRoot,
          ".sandcastle",
          "defaults",
          "prompts",
          filename
        );
        const contents = await readFile(builtInPath, "utf8");
        await writeFile(
          path.join(projectRoot, ".sandcastle", filename),
          contents.replace(
            "Review the code changes on branch `{{BRANCH}}` for the selected ready-for-agent executable child issue. Check spec conformance, documented standards, and maintainability.",
            "Audit branch `{{BRANCH}}` using this project's customized review prose."
          )
        );
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Prompt review-prompt.md: project override .*\/\.sandcastle\/review-prompt.md/
    );
    assert.match(
      result.stdout,
      /Prompt implement-prompt.md: built-in .*\/\.sandcastle\/defaults\/prompts\/implement-prompt.md/
    );
  });

  it("rejects an incompatible override with its missing contract and workflow version", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        const filename = "merge-prompt.md";
        const builtInPath = path.join(
          projectRoot,
          ".sandcastle",
          "defaults",
          "prompts",
          filename
        );
        const contents = await readFile(builtInPath, "utf8");
        await writeFile(
          path.join(projectRoot, ".sandcastle", filename),
          contents.replaceAll("{{VERIFICATION_WORKTREE_PATH}}", "worktree")
        );
      },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Prompt override merge-prompt.md is incompatible with Sandcastle workflow version 1/
    );
    assert.match(
      result.stderr,
      /Missing contract elements: placeholder \{\{VERIFICATION_WORKTREE_PATH\}\}/
    );
    assert.doesNotMatch(result.stdout, /=== Iteration/);
  });

  it("derives terminal protocol requirements from each matching built-in prompt", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        const filename = "standalone-implement-prompt.md";
        const builtInPath = path.join(
          projectRoot,
          ".sandcastle",
          "defaults",
          "prompts",
          filename
        );
        const contents = await readFile(builtInPath, "utf8");
        await writeFile(
          path.join(projectRoot, ".sandcastle", filename),
          contents.replaceAll("<promise>COMPLETE</promise>", "complete")
        );
      },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Missing contract elements: terminal marker <promise>COMPLETE<\/promise>/
    );
  });

  it("ignores unsupported aliases and arbitrary prompt search paths", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".sandcastle", "implementation-prompt.md"),
          "This unsupported alias has no prompt contract."
        );
        await mkdir(path.join(projectRoot, "prompts"));
        await writeFile(
          path.join(projectRoot, "prompts", "review-prompt.md"),
          "This arbitrary search path has no prompt contract."
        );
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Prompt implement-prompt.md: built-in .*\/defaults\/prompts\/implement-prompt.md/
    );
    assert.match(
      result.stdout,
      /Prompt review-prompt.md: built-in .*\/defaults\/prompts\/review-prompt.md/
    );
    assert.doesNotMatch(result.stdout, /implementation-prompt.md/);
  });

  it("accepts an override symlink only when its regular-file target stays in the worktree", async () => {
    const accepted = await runMain({
      setupProject: async (projectRoot) => {
        const filename = "standalone-review-prompt.md";
        const targetDirectory = path.join(projectRoot, "workflow-prompts");
        const targetPath = path.join(targetDirectory, filename);
        await mkdir(targetDirectory);
        await cp(
          path.join(
            projectRoot,
            ".sandcastle",
            "defaults",
            "prompts",
            filename
          ),
          targetPath
        );
        await symlink(
          path.relative(path.join(projectRoot, ".sandcastle"), targetPath),
          path.join(projectRoot, ".sandcastle", filename)
        );
      },
    });
    const rejected = await runMain({
      setupProject: async (projectRoot) => {
        await symlink(
          "/etc/hosts",
          path.join(projectRoot, ".sandcastle", "final-spec-prompt.md")
        );
      },
    });

    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(
      accepted.stdout,
      /Prompt standalone-review-prompt.md: project override .*\/workflow-prompts\/standalone-review-prompt.md/
    );
    assert.equal(rejected.code, 1);
    assert.match(
      rejected.stderr,
      /Prompt override final-spec-prompt.md resolves outside the active Git worktree/
    );
    assert.doesNotMatch(rejected.stdout, /=== Iteration/);
  });

  it("rejects broken and non-file prompt overrides", async () => {
    const broken = await runMain({
      setupProject: async (projectRoot) => {
        await symlink(
          "../missing-review-prompt.md",
          path.join(projectRoot, ".sandcastle", "review-prompt.md")
        );
      },
    });
    const directory = await runMain({
      setupProject: async (projectRoot) => {
        await mkdir(path.join(projectRoot, ".sandcastle", "review-prompt.md"));
      },
    });

    assert.equal(broken.code, 1);
    assert.match(
      broken.stderr,
      /Prompt override review-prompt.md must be a readable regular file/
    );
    assert.equal(directory.code, 1);
    assert.match(
      directory.stderr,
      /Prompt override review-prompt.md must resolve to a regular file/
    );
  });

  it("requires the authoritative root coding standards document", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        await rm(path.join(projectRoot, "CODING_STANDARDS.md"));
      },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Root project coding standards CODING_STANDARDS.md must be a readable regular file/
    );
    assert.doesNotMatch(result.stdout, /=== Iteration/);
  });

  it("retains strict runner configuration validation", async () => {
    const cases = [
      {
        contents: validRunnerConfig.replace(
          "IMPLEMENTER_MODEL=test-model",
          "IMPLEMENTER_MODEL"
        ),
        diagnostic: /expected a KEY=value assignment/,
      },
      {
        contents: `${validRunnerConfig}IMPLEMENTER_MODEL=duplicate\n`,
        diagnostic: /duplicate configuration key IMPLEMENTER_MODEL/,
      },
      {
        contents: `${validRunnerConfig}UNKNOWN_SETTING=value\n`,
        diagnostic: /unknown configuration key UNKNOWN_SETTING/,
      },
      {
        contents: validRunnerConfig.replace(
          "IMPLEMENTER_EFFORT=low",
          "IMPLEMENTER_EFFORT="
        ),
        diagnostic: /IMPLEMENTER_EFFORT must not be empty/,
      },
      {
        contents: validRunnerConfig.replace("MERGER_MODEL=test-model\n", ""),
        diagnostic: /missing required configuration: MERGER_MODEL/,
      },
    ];
    const [missing, ...invalid] = await Promise.all([
      runMain({ createRunnerConfig: false }),
      ...cases.map(({ contents }) => runMain({ runnerConfig: contents })),
    ]);

    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /sandcastle\.env is required/);
    for (const [index, result] of invalid.entries()) {
      assert.equal(result.code, 1);
      assert.match(result.stderr, cases[index].diagnostic);
      assert.doesNotMatch(result.stdout, /=== Iteration/);
    }
  });

  it("reports a clean no-work dry run through the runner entry point", async () => {
    const result = await runMain({});

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /No open ready-for-agent issues found/);
    assert.equal(result.stdout.match(/SANDCASTLE RUN:/g)?.length, 1);
    assert.ok(result.stdout.includes(`${ansi.green}COMPLETED`));
  });

  it("requires agent credentials only for commands that can launch agents", async () => {
    const agentRun = await runMain({ agentEnvironment: null, args: [] });
    const dryRun = await runMain({
      agentEnvironment: null,
      args: ["--dry-run"],
    });

    assert.equal(agentRun.code, 1);
    assert.match(
      agentRun.stderr,
      /\.sandcastle\/\.env is required before launching agents/
    );
    assert.doesNotMatch(agentRun.stderr, /GH_TOKEN=.*$/m);
    assert.doesNotMatch(agentRun.stdout, /=== Iteration/);
    assert.equal(dryRun.code, 0, dryRun.stderr);
  });

  it("diagnoses a missing configured image without starting a build", async () => {
    const imageName = "registry.example.com/team/agent:missing";
    const result = await runMain({
      args: [],
      dockerScript:
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$SANDCASTLE_DOCKER_CAPTURE"\nexit 1\n',
      runnerConfig: `${validRunnerConfig}DOCKER_IMAGE=${imageName}\n`,
      ghScript: `#!/bin/sh
if [ "$1 $2" = "issue list" ]; then
  printf '%s\n' '[{"id":"42","title":"Standalone","createdAt":"2026-01-01T00:00:00Z","parentId":null}]'
elif [ "$1" = "api" ]; then
  printf '[]\n'
elif [ "$1 $2" = "issue view" ]; then
  printf '%s\n' '{"parent":null,"blockedBy":{"nodes":[]},"blocking":{"nodes":[]}}'
else
  exit 1
fi
`,
      inspectProject: async (projectRoot) => ({
        dockerArgs: (
          await readFile(path.join(projectRoot, "docker-args"), "utf8")
        )
          .trim()
          .split("\n"),
      }),
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      new RegExp(`Docker image '${imageName}' is not available`)
    );
    assert.match(result.stderr, /pnpm sandcastle build-image/);
    assert.deepEqual(result.projectInspection.dockerArgs, [
      "image",
      "inspect",
      imageName,
    ]);
  });

  it("accepts a file credential or the documented host fallback without printing either value", async () => {
    const fromFile = await runMain({
      agentEnvironment: "GH_TOKEN=file-secret\n",
      args: [],
    });
    const fromHost = await runMain({
      agentEnvironment: "GH_TOKEN=\n",
      args: [],
      hostGhToken: "host-secret",
    });

    assert.equal(fromFile.code, 0, fromFile.stderr);
    assert.equal(fromHost.code, 0, fromHost.stderr);
    for (const result of [fromFile, fromHost]) {
      assert.doesNotMatch(result.stdout, /file-secret|host-secret/);
      assert.doesNotMatch(result.stderr, /file-secret|host-secret/);
    }
  });

  it("rejects malformed, duplicate, missing, and unusable agent credentials safely", async () => {
    const cases = [
      {
        contents: "GH_TOKEN\n",
        diagnostic: /expected a KEY=value assignment/,
      },
      {
        contents: "GH_TOKEN=first-secret\nGH_TOKEN=second-secret\n",
        diagnostic: /duplicate environment key GH_TOKEN/,
      },
      {
        contents: "OTHER=value\n",
        diagnostic: /must declare GH_TOKEN/,
      },
      {
        contents: "GH_TOKEN=\n",
        diagnostic: /no usable credential was provided/,
      },
      {
        contents: 'GH_TOKEN="   "\n',
        diagnostic: /no usable credential was provided/,
      },
    ];
    const results = await Promise.all(
      cases.map(({ contents }) =>
        runMain({ agentEnvironment: contents, args: [] })
      )
    );

    for (const [index, result] of results.entries()) {
      assert.equal(result.code, 1);
      assert.match(result.stderr, cases[index].diagnostic);
      assert.doesNotMatch(result.stdout, /first-secret|second-secret/);
      assert.doesNotMatch(result.stderr, /first-secret|second-secret/);
      assert.doesNotMatch(result.stdout, /=== Iteration/);
    }
  });

  it("rejects missing effective Git ignore protection before workflow planning", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".sandcastle", ".gitignore"),
          [
            ".env",
            "sandcastle.env",
            "logs/",
            "node-modules-overlays/",
            "",
          ].join("\n")
        );
      },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Git ignore protection is required for \.sandcastle\/worktrees\//
    );
    assert.match(
      result.stderr,
      /Add an effective ignore rule before launching agents/
    );
    assert.doesNotMatch(result.stdout, /=== Iteration/);
  });

  it("rejects effective ignore rules that hide trackable workflow files", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".gitignore"),
          ".sandcastle/implement-prompt.md\n"
        );
      },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Workflow file \.sandcastle\/implement-prompt\.md must remain trackable/
    );
    assert.doesNotMatch(result.stdout, /=== Iteration/);
  });

  it("accepts runtime protection supplied by another effective Git ignore source", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".sandcastle", ".gitignore"),
          "# Project keeps Sandcastle rules in the root ignore file.\n"
        );
        await writeFile(
          path.join(projectRoot, ".gitignore"),
          [
            ".sandcastle/.env",
            ".sandcastle/sandcastle.env",
            ".sandcastle/logs/",
            ".sandcastle/worktrees/",
            ".sandcastle/node-modules-overlays/",
            ".sandcastle/merger-recovery.json",
            "",
          ].join("\n")
        );
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /No open ready-for-agent issues found/);
  });

  it("rejects protected paths that are already tracked despite matching ignore rules", async () => {
    const result = await runMain({
      setupProject: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".sandcastle", ".gitignore"),
          [
            "sandcastle.env",
            "logs/",
            "worktrees/",
            "node-modules-overlays/",
            "merger-recovery.json",
            "",
          ].join("\n")
        );
      },
      setupRepository: async (projectRoot) => {
        await writeFile(
          path.join(projectRoot, ".git", "info", "exclude"),
          ".sandcastle/.env\n"
        );
      },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Git ignore rules cannot protect tracked Sandcastle paths: \.sandcastle\/\.env/
    );
    assert.match(
      result.stderr,
      /Remove them from the Git index without deleting the local files/
    );
    assert.doesNotMatch(result.stdout, /=== Iteration/);
  });

  it("leaves existing and absent runtime state unchanged after failed preflight", async () => {
    const staleOverlay = "99999999-stale";
    const result = await runMain({
      agentEnvironment: null,
      args: [],
      setupProject: async (projectRoot) => {
        await mkdir(
          path.join(
            projectRoot,
            ".sandcastle",
            "node-modules-overlays",
            staleOverlay
          ),
          { recursive: true }
        );
      },
      inspectProject: async (projectRoot) => {
        const sandcastleRoot = path.join(projectRoot, ".sandcastle");
        return {
          entries: await readdir(sandcastleRoot),
          overlays: await readdir(
            path.join(sandcastleRoot, "node-modules-overlays")
          ),
        };
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /is required before launching agents/);
    assert.deepEqual(result.projectInspection.overlays, [staleOverlay]);
    for (const absentEntry of ["logs", "worktrees", "merger-recovery.json"]) {
      assert.ok(
        !result.projectInspection.entries.includes(absentEntry),
        absentEntry
      );
    }
  });

  it("anchors nested dry runs and GitHub operations to the Git root", async () => {
    const result = await runMain({
      invokeFromNestedDirectory: true,
      gitScript: `#!/bin/sh
state="$0.state"
if [ "$1 $2" = "rev-parse --show-toplevel" ]; then
  if [ -f "$state" ]; then
    printf 'repository root was discovered more than once\\n' >&2
    exit 9
  fi
  : > "$state"
elif [ "$PWD" != "$SANDCASTLE_EXPECTED_ROOT" ]; then
  printf 'unexpected Git working directory: %s\\n' "$PWD" >&2
  exit 10
fi
exec "$SANDCASTLE_REAL_GIT" "$@"
`,
      ghScript: `#!/bin/sh
if [ "$PWD" != "$SANDCASTLE_EXPECTED_ROOT" ]; then
  printf 'unexpected working directory: %s\\n' "$PWD" >&2
  exit 8
fi
if [ "$1 $2" = "issue list" ]; then
  printf '[]\\n'
else
  exit 1
fi
`,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /No open ready-for-agent issues found/);
  });

  it("fails outside a Git worktree before creating runtime state", async () => {
    const result = await runMain({ invokeOutsideWorktree: true });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /must be run inside a Git worktree/);
    assert.deepEqual(result.outsideEntries, []);
  });

  it("stops for an invalid issue graph through the runner entry point", async () => {
    const result = await runMain({
      ghScript: `#!/bin/sh
if [ "$1 $2" = "issue list" ]; then
  printf '%s\\n' '[{"id":"1","title":"Spec","createdAt":"2026-01-01T00:00:00Z","parentId":null},{"id":"2","title":"Child","createdAt":"2026-01-01T00:01:00Z","parentId":"1"}]'
elif [ "$1" = "api" ]; then
  printf '%s\\n' '[{"number":2,"title":"Child","state":"open","labels":[{"name":"ready-for-agent"}]}]'
elif [ "$1 $2" = "issue view" ]; then
  printf '%s\\n' '{"parent":{"number":3},"blockedBy":{"nodes":[]},"blocking":{"nodes":[]}}'
else
  exit 1
fi
`,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(result.stdout, /sub-issue validation failed/);
  });

  it("stops when a stale standalone selection disappears during replanning", async () => {
    const result = await runMain({
      args: [],
      ghScript: `#!/bin/sh
state="$0.state"
if [ "$1 $2" = "issue list" ]; then
  count=0
  [ -f "$state" ] && count=$(cat "$state")
  count=$((count + 1))
  printf '%s' "$count" > "$state"
  if [ "$count" -eq 1 ]; then
    printf '%s\\n' '[{"id":"1","title":"Standalone","createdAt":"2026-01-01T00:00:00Z","parentId":null}]'
  else
    printf '[]\\n'
  fi
elif [ "$1" = "api" ]; then
  printf '[]\\n'
else
  exit 1
fi
`,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(result.stdout, /stale selections were replanned/);
  });

  it("aborts unexpected runner errors with their diagnostics", async () => {
    const result = await runMain({ ghScript: "#!/bin/sh\nexit 7\n" });

    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(`${ansi.red}ABORTED`));
    assert.ok(result.stderr.includes(ansi.red));
    assert.match(result.stderr, /Command failed: gh issue list/);
  });

  it("preserves signal exit status through the runner entry point", async () => {
    const result = await runMain({
      ghScript:
        '#!/bin/sh\nif [ "$1 $2" = "issue list" ]; then sleep 2; printf "[]\\n"; else exit 1; fi\n',
      signal: "SIGINT",
    });

    assert.equal(result.code, 130, result.stderr);
    assert.ok(result.stdout.includes(`${ansi.red}ABORTED`));
    assert.match(result.stdout, /Received SIGINT/);
  });

  it("prints one colored completed summary", async () => {
    const result = await runFixture("completed-twice");

    assert.equal(result.code, 0);
    assert.equal(result.stdout.match(/SANDCASTLE RUN:/g)?.length, 1);
    assert.ok(result.stdout.includes(`${ansi.blue}SANDCASTLE RUN:`));
    assert.ok(result.stdout.includes(`${ansi.green}COMPLETED`));
    assert.ok(result.stdout.includes(`${ansi.green}yes`));
  });

  it("prints stopped and aborted outcomes with their status colors", async () => {
    const stopped = await runFixture("stopped");
    const aborted = await runFixture("aborted");

    assert.ok(stopped.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.ok(aborted.stdout.includes(`${ansi.red}ABORTED`));
  });

  it("prints non-success phase diagnostics immediately and in the final summary", async () => {
    const result = await runFixture("phase-failure");

    for (const output of [result.stderr, result.stdout]) {
      assert.match(output, /Reviewer for issue #42/);
      assert.match(output, /Tests failed/);
      assert.match(output, /.sandcastle\/logs\/reviewer.log/);
    }
  });

  it("stops for invalid issue graphs and stale standalone exhaustion", async () => {
    const invalidGraph = await runFixture("invalid-graph");
    const staleEmpty = await runFixture("stale-empty");
    const empty = await runFixture("empty");

    assert.ok(invalidGraph.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(invalidGraph.stdout, /sub-issue validation failed/);
    assert.ok(staleEmpty.stdout.includes(`${ansi.yellow}STOPPED`));
    assert.match(staleEmpty.stdout, /stale selections were replanned/);
    assert.ok(empty.stdout.includes(`${ansi.green}COMPLETED`));
  });

  it("preserves Error stacks and inspects circular rejection values", async () => {
    const error = await runFixture("throw-error");
    const object = await runFixture("reject-object");

    assert.equal(error.code, 1);
    assert.ok(error.stderr.includes(ansi.red));
    assert.match(error.stderr, /Error: fixture failure/);
    assert.match(error.stderr, /run-completion\.fixture\.ts/);
    assert.equal(object.code, 1);
    assert.match(object.stderr, /code: 'fixture-rejection'/);
    assert.match(object.stderr, /Circular/);
    assert.doesNotMatch(object.stderr, /\[object Object\]/);
  });

  for (const [signal, exitCode] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    it(`preserves the conventional ${signal} exit status`, async () => {
      const result = await signalFixture(signal);

      assert.equal(result.code, exitCode);
      assert.equal(result.stdout.match(/SANDCASTLE RUN:/g)?.length, 1);
      assert.ok(result.stdout.includes(`${ansi.red}ABORTED`));
      assert.ok(result.stdout.includes(`Received ${signal}`));
    });
  }
});
