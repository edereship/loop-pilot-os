import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner, RunOptions } from "./types.js";

export class RealCommandRunner implements CommandRunner {
  run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let settled = false;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        fn();
      };

      if (opts.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          child.kill("SIGKILL");
          settle(() =>
            reject(
              new Error(
                `command "${cmd}" timed out after ${String(opts.timeoutMs)}ms`,
              ),
            ),
          );
        }, opts.timeoutMs);
      }

      const emitLines = (): void => {
        if (!opts.onStdoutLine) return;
        let newlineIndex = lineBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          opts.onStdoutLine(lineBuffer.slice(0, newlineIndex));
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          newlineIndex = lineBuffer.indexOf("\n");
        }
      };

      const flushLines = (): void => {
        if (opts.onStdoutLine && lineBuffer.length > 0) {
          opts.onStdoutLine(lineBuffer);
          lineBuffer = "";
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (opts.onStdoutLine) {
          lineBuffer += text;
          emitLines();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err: Error) => {
        settle(() => reject(err));
      });

      child.on("close", (code: number | null) => {
        flushLines();
        settle(() => resolve({ code: code ?? -1, stdout, stderr }));
      });
    });
  }
}
