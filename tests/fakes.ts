import type { CommandResult, CommandRunner, RunOptions } from "../src/types.js";

type StubResponder =
  | Partial<CommandResult>
  | ((args: string[], opts: RunOptions) => Partial<CommandResult>);

interface Stub {
  prefix: string[];
  responder: StubResponder;
}

export class FakeCommandRunner implements CommandRunner {
  private stubs: Stub[] = [];
  calls: Array<{ cmd: string; args: string[]; opts: RunOptions }> = [];

  /** ルール: [cmd, ...args] の前方一致で応答を返す。未登録は throw */
  on(cmdPrefix: string[], result: StubResponder): void {
    this.stubs.push({ prefix: cmdPrefix, responder: result });
  }

  run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult> {
    this.calls.push({ cmd, args, opts });
    const full = [cmd, ...args];

    let best: Stub | undefined;
    for (const stub of this.stubs) {
      if (!matchesPrefix(full, stub.prefix)) continue;
      if (best === undefined || stub.prefix.length > best.prefix.length) {
        best = stub;
      }
    }
    if (best === undefined) {
      return Promise.reject(
        new Error(`no FakeCommandRunner stub for: ${full.join(" ")}`),
      );
    }

    const partial =
      typeof best.responder === "function"
        ? best.responder(args, opts)
        : best.responder;
    const result: CommandResult = {
      code: partial.code ?? 0,
      stdout: partial.stdout ?? "",
      stderr: partial.stderr ?? "",
    };

    if (opts.onStdoutLine && result.stdout.length > 0) {
      const lines = result.stdout.split("\n");
      // 末尾が改行で終わる場合、split は末尾に空文字を生むので落とす
      if (lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) opts.onStdoutLine(line);
    }

    return Promise.resolve(result);
  }
}

function matchesPrefix(full: string[], prefix: string[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (full[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * 決定的クロック（§6）。呼ぶ度に +1s 進んだ ISO 文字列を返す。
 * 初回は start（省略時は固定の既定基準）をそのまま返す。
 */
export function fixedClock(start = "2026-01-01T00:00:00.000Z"): () => string {
  let next = Date.parse(start);
  return (): string => {
    const iso = new Date(next).toISOString();
    next += 1000;
    return iso;
  };
}

/**
 * 即 resolve する sleep（§6）。実時間を待たず、呼び出された ms を
 * 返り値関数の `.calls` 配列に順に記録する。
 */
export function instantSleep(): ((ms: number) => Promise<void>) & {
  calls: number[];
} {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  sleep.calls = calls;
  return sleep;
}
