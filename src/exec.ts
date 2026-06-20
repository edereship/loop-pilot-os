import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CommandResult, CommandRunner, RunOptions } from "./types.js";

// Wraps a single token for use inside a cmd.exe /s /c "..." command string.
// Interior double-quotes are doubled ("") per cmd.exe convention, then the
// token is wrapped in double-quotes to neutralise metacharacters (&, |, >,
// <, ^, etc.) that cmd.exe would otherwise interpret as shell operators.
// Percent signs are doubled (%%) before quoting: cmd.exe expands %VAR% during
// a pre-processing pass that runs even inside double-quoted strings, so a
// ticket-derived prompt containing %PATH% or %TEMP% would be rewritten before
// Codex receives it. Doubling prevents that expansion.
function quoteCmdExeToken(token: string): string {
  return `"${token.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

export class RealCommandRunner implements CommandRunner {
  run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      // On Windows, .cmd shims must go through cmd.exe. Passing individual
      // args as separate spawn elements lets Node.js build the CreateProcess
      // command line, but Node.js does not escape cmd.exe metacharacters
      // (& | > < ^) so an arg like "x&whoami" would be split by cmd.exe and
      // run as two commands. Instead, build a fully-quoted command string
      // ourselves and use windowsVerbatimArguments to pass it verbatim.
      // Format: cmd.exe /d /s /c "<tok1> <tok2> ..." where /s strips the
      // outermost quotes and executes the inner quoted-token string, keeping
      // metacharacters inside the per-token quotes inert.
      let spawnCmd = cmd;
      let spawnArgs = args;
      let windowsVerbatimArguments = false;
      if (process.platform === "win32" && cmd.endsWith(".cmd")) {
        spawnCmd = "cmd.exe";
        const innerTokens = [cmd, ...args].map(quoteCmdExeToken).join(" ");
        spawnArgs = ["/d", "/s", "/c", `"${innerTokens}"`];
        windowsVerbatimArguments = true;
      }
      const child = spawn(spawnCmd, spawnArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });

      if (opts.stdin === "ignore") {
        child.stdin?.end();
      }

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
          if (process.platform === "win32" && windowsVerbatimArguments && child.pid !== undefined) {
            // On Windows the tracked child is cmd.exe, not the Codex process
            // started by the .cmd shim. child.kill() only kills cmd.exe; the
            // real subprocess keeps running. Use taskkill /T to terminate the
            // entire process tree rooted at cmd.exe.
            spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
          } else {
            child.kill("SIGKILL");
          }
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
