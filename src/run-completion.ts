import chalk, { type ChalkInstance } from "chalk";
import { inspect } from "node:util";

export type RunEndStatus = {
  kind: "completed" | "stopped" | "aborted";
  reason: string;
};

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

type Signal = (typeof signals)[number];

const signalExitCodes: Record<Signal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function formatDiagnostic(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return typeof value === "string" ? value : inspect(value);
}

const summaryColors: Record<RunEndStatus["kind"], ChalkInstance> = {
  completed: chalk.green,
  stopped: chalk.yellow,
  aborted: chalk.red,
};

function formatSummary(status: RunEndStatus): string {
  const color = summaryColors[status.kind];
  const divider = "=".repeat(72);
  const successful = status.kind === "completed" ? "yes" : "no";

  return `\n${chalk.blue(divider)}\n${chalk.blue("SANDCASTLE RUN:")} ${color(status.kind.toUpperCase())}\n${chalk.blue("Successful:")} ${color(successful)}\n${chalk.blue("Reason:")} ${status.reason}\n${chalk.blue(divider)}\n`;
}

function writeAndFlush(
  stream: NodeJS.WriteStream,
  contents: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(contents, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export function createRunCompletionReporter(
  getExternalStatus: () => RunEndStatus | undefined
): {
  setStatus: (status: RunEndStatus) => void;
  printSummary: () => Promise<void>;
  installProcessHandlers: () => void;
} {
  let status: RunEndStatus | undefined;
  let summaryPrinted = false;
  let terminating = false;

  const getStatus = (): RunEndStatus =>
    status ??
    getExternalStatus() ?? {
      kind: "aborted",
      reason:
        "The run ended unexpectedly before reporting a completion reason.",
    };

  const takeSummary = (): string | undefined => {
    if (summaryPrinted) {
      return undefined;
    }
    summaryPrinted = true;
    return formatSummary(getStatus());
  };

  const printSummary = async (): Promise<void> => {
    const summary = takeSummary();
    if (summary !== undefined) {
      await writeAndFlush(process.stdout, summary);
    }
  };

  const terminate = (
    terminalStatus: RunEndStatus,
    exitCode: number,
    diagnostic?: unknown
  ): void => {
    if (terminating) {
      return;
    }
    terminating = true;
    status = terminalStatus;

    const summary = takeSummary();
    const flushTerminationOutput = async (): Promise<void> => {
      if (diagnostic !== undefined) {
        await writeAndFlush(
          process.stderr,
          `${chalk.red(formatDiagnostic(diagnostic))}\n`
        );
      }
      if (summary !== undefined) {
        await writeAndFlush(process.stdout, summary);
      }
    };

    void flushTerminationOutput().then(
      () => process.exit(exitCode),
      (error: unknown) => {
        process.exitCode = exitCode;
        process.stderr.write(
          `${chalk.red(`Failed to flush Sandcastle termination output: ${formatDiagnostic(error)}`)}\n`,
          () => process.exit(exitCode)
        );
      }
    );
  };

  const installProcessHandlers = (): void => {
    process.once("beforeExit", () => {
      void printSummary().catch((error: unknown) => {
        process.exitCode = 1;
        process.stderr.write(
          `${chalk.red(`Failed to flush the Sandcastle run summary: ${formatDiagnostic(error)}`)}\n`
        );
      });
    });
    process.once("uncaughtException", (error) => {
      terminate(
        {
          kind: "aborted",
          reason: error.message,
        },
        1,
        error
      );
    });
    process.once("unhandledRejection", (reason) => {
      terminate(
        {
          kind: "aborted",
          reason: formatDiagnostic(reason),
        },
        1,
        reason
      );
    });
    for (const signal of signals) {
      process.once(signal, () => {
        terminate(
          {
            kind: "aborted",
            reason: `Received ${signal}.`,
          },
          signalExitCodes[signal]
        );
      });
    }
  };

  return {
    setStatus: (nextStatus) => {
      status = nextStatus;
    },
    printSummary,
    installProcessHandlers,
  };
}
