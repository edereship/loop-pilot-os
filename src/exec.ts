import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

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
        const text = stdoutDecoder.write(chunk);
        stdout += text;
        if (opts.onStdoutLine) {
          lineBuffer += text;
          emitLines();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += stderrDecoder.write(chunk);
      });

      child.on("error", (err: Error) => {
        settle(() => reject(err));
      });

      child.on("close", (code: number | null) => {
        const stdoutTail = stdoutDecoder.end();
        if (stdoutTail.length > 0) {
          stdout += stdoutTail;
          if (opts.onStdoutLine) lineBuffer += stdoutTail;
        }
        stderr += stderrDecoder.end();
        flushLines();
        settle(() => resolve({ code: code ?? -1, stdout, stderr }));
      });
    });
  }
}
