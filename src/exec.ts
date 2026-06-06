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
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("error", (err: Error) => {
        settle(() => reject(err));
      });

      child.on("close", (code: number | null) => {
        settle(() => resolve({ code: code ?? -1, stdout, stderr }));
      });
    });
  }
}
