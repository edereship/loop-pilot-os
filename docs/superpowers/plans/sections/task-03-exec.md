### Task 3: CommandRunner + FakeCommandRunner

**目的**: 全外部 CLI（git / gh / claude）呼び出しの唯一の土台となる `CommandRunner` を実装する。`node:child_process` の `spawn`（`shell: false`）で外部プロセスを起動し、stdout/stderr を蓄積、`onStdoutLine` でチャンク跨ぎの行バッファリングを伴う逐次行コールバックを供給し、`timeoutMs` 超過で kill→reject、終了コードは（非0でも）resolve する。あわせて以降の全タスクが DI に使うモジュール境界フェイク `FakeCommandRunner`、および Orchestrator 系タスク（最初の消費者は Task 6/12）が import する `fixedClock` / `instantSleep`（カーネル §6 シグネチャ）を `tests/fakes.ts` に新設する（§6 の他クラスは各タスクが追加）。

**依存タスク**: Task 1（リポ雛形・`npm run check`・vitest 設定・ESM/NodeNext）、Task 2（`src/types.ts` の `CommandResult` / `RunOptions` / `CommandRunner`）。

**カーネル契約（一字一句一致させる対象）**:
- `src/types.ts`（§2）:
  ```typescript
  export interface CommandResult { code: number; stdout: string; stderr: string; }
  export interface RunOptions {
    cwd: string;
    env?: Record<string, string>;
    onStdoutLine?: (line: string) => void;  // stream-json 進捗用
    timeoutMs?: number;                      // 超過時 kill して reject
  }
  export interface CommandRunner {
    run(cmd: string, args: string[], opts: RunOptions): Promise<CommandResult>;
  }
  ```
- `tests/fakes.ts`（§6）:
  ```typescript
  export class FakeCommandRunner implements CommandRunner {
    /** ルール: [cmd, ...args] の前方一致で応答を返す。未登録は throw */
    on(cmdPrefix: string[], result: Partial<CommandResult> | ((args: string[], opts: RunOptions) => Partial<CommandResult>)): void;
    calls: Array<{ cmd: string; args: string[]; opts: RunOptions }>;
    run(cmd, args, opts): Promise<CommandResult>;
  }
  ```

**設計メモ（検証済みの node:child_process 事実、v24.15.0）**:
- `spawn(cmd, args, { cwd, env, shell: false })` の `close` イベントは `(code: number | null, signal: NodeJS.Signals | null)` を渡す。正常終了は `code` が数値（非0でもそのまま resolve する）、シグナル kill 時は `code=null, signal="SIGKILL"`。
- 存在しないバイナリは `error` イベント（`code:"ENOENT"`）が先に発火し、その後 `close`（code=-2）も発火し得る。よって **`settled` フラグで二重 settle を防ぐ**。
- stdout はチャンク跨ぎで途中改行になり得る（例: `"line1\nli"`, `"ne2\nline3\n"`）。`onStdoutLine` は **完全な1行ごと**に呼ぶ必要があり、不完全な末尾はバッファに残す。close 時に残バッファ（非空）を最後の1行として flush する。
- `timeoutMs` は `setTimeout` で計測し、超過時 `child.kill("SIGKILL")` → reject。close での通常 settle は `settled` フラグで抑止。タイマは settle 時に必ず `clearTimeout` する。

---

#### サブタスク 3a: RealCommandRunner（正常系: 出力蓄積 + 終了コード resolve）

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/src/exec.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

- [ ] **Step 1: 失敗するテストを書く（正常出力 + 非0コード）**
  `tests/exec.test.ts` を新規作成し、実プロセス（`node -e`）で stdout/stderr の蓄積と終了コードの resolve を検証する。

  `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts` を作成:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { RealCommandRunner } from "../src/exec.js";

  describe("RealCommandRunner", () => {
    const runner = new RealCommandRunner();

    // 仕様: 外部プロセスの stdout/stderr を蓄積し、終了コードは resolve する（§5 外部コマンド契約の土台）
    it("正常終了で stdout/stderr を蓄積し code=0 で resolve する", async () => {
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('out-data'); process.stderr.write('err-data')"],
        { cwd: process.cwd() },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("out-data");
      expect(result.stderr).toBe("err-data");
    });

    // 仕様: 非0終了コードでも reject せず、code を載せて resolve する（git diff --quiet 等の判定に必須）
    it("非0終了コードでも reject せず code を載せて resolve する", async () => {
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('partial'); process.exit(3)"],
        { cwd: process.cwd() },
      );
      expect(result.code).toBe(3);
      expect(result.stdout).toBe("partial");
      expect(result.stderr).toBe("");
    });
  });
  ```

- [ ] **Step 2: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: `Failed to resolve import "../src/exec.js"`（`src/exec.ts` がまだ無いため import 解決エラー）。

- [ ] **Step 3: RealCommandRunner の最小実装を書く（正常系のみ）**
  `/home/racoma-dev/loop-pilot-os/src/exec.ts` を作成:
  ```typescript
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
  ```

- [ ] **Step 4: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 2 tests passed（`正常終了で...` と `非0終了コードでも...`）。

- [ ] **Step 5: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: tsc（src）+ tsc（test）+ vitest が全てグリーン。

- [ ] **Step 6: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/exec.ts tests/exec.test.ts && git commit -m "feat: RealCommandRunner accumulates output and resolves with exit code"`

---

#### サブタスク 3b: 行ストリーミング（onStdoutLine: チャンク跨ぎの行バッファリング）

**Files:**
- Modify: `/home/racoma-dev/loop-pilot-os/src/exec.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

- [ ] **Step 7: 失敗するテストを追加する（複数行 + チャンク分割 + 末尾 flush）**
  `tests/exec.test.ts` の `describe("RealCommandRunner", ...)` ブロック内、`非0終了コード...` の `it` の直後に以下 2 つの `it` を追加する。

  追加する `old_string`（直前の閉じ行を含めて一意に特定）:
  ```typescript
      expect(result.stderr).toBe("");
    });
  });
  ```
  を次に置換:
  ```typescript
      expect(result.stderr).toBe("");
    });

    // 仕様: stream-json 進捗用。完全な1行ごとに onStdoutLine を呼ぶ（複数行を順に供給）
    it("onStdoutLine に完全な行を順に供給する（複数行・全文も stdout に蓄積）", async () => {
      const lines: string[] = [];
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('a\\nb\\nc\\n')"],
        { cwd: process.cwd(), onStdoutLine: (line) => lines.push(line) },
      );
      expect(lines).toEqual(["a", "b", "c"]);
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.code).toBe(0);
    });

    // 仕様: チャンク境界が行の途中に来てもバッファリングして1行に再構成する。
    // 末尾に改行が無い最終行は close 時に flush する。
    it("チャンク跨ぎの行を再構成し、改行無しの末尾も最終行として供給する", async () => {
      const lines: string[] = [];
      // 1チャンク目 'line1\nli' → 'line1' を供給し 'li' をバッファ
      // 2チャンク目（遅延）'ne2\nline3' → 'line2','line3' を供給（'line3' は close で flush）
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('line1\\nli'); setTimeout(() => process.stdout.write('ne2\\nline3'), 50)"],
        { cwd: process.cwd(), onStdoutLine: (line) => lines.push(line) },
      );
      expect(lines).toEqual(["line1", "line2", "line3"]);
      expect(result.stdout).toBe("line1\nline2\nline3");
    });
  });
  ```

- [ ] **Step 8: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: 新規 2 テストが失敗。`onStdoutLine` がまだ呼ばれないため `lines` が `[]` のままで `expected [] to deeply equal [ 'a', 'b', 'c' ]`（および2件目で `[ 'line1', 'line2', 'line3' ]`）の AssertionError。

- [ ] **Step 9: 行バッファリングを実装する**
  `src/exec.ts` の stdout `data` ハンドラを、行分割と flush を伴うものに差し替える。

  `old_string`:
  ```typescript
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
  ```
  を次に置換:
  ```typescript
        let stdout = "";
        let stderr = "";
        let lineBuffer = "";
        let settled = false;

        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

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
  ```

- [ ] **Step 10: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 4 tests passed（正常出力2件 + 行ストリーミング2件）。

- [ ] **Step 11: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: 全てグリーン。

- [ ] **Step 12: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/exec.ts tests/exec.test.ts && git commit -m "feat: RealCommandRunner streams stdout lines with cross-chunk buffering"`

---

#### サブタスク 3c: timeoutMs 超過で kill→reject

**Files:**
- Modify: `/home/racoma-dev/loop-pilot-os/src/exec.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

- [ ] **Step 13: 失敗するテストを追加する（timeout kill）**
  `tests/exec.test.ts` の `describe("RealCommandRunner", ...)` ブロック末尾、最後の `it`（チャンク跨ぎ…）の閉じ `});` の直後・`describe` の閉じ `});` の直前に以下を追加する。

  `old_string`（最後の `it` の末尾と describe 閉じを含めて一意に特定）:
  ```typescript
      expect(result.stdout).toBe("line1\nline2\nline3");
    });
  });
  ```
  を次に置換:
  ```typescript
      expect(result.stdout).toBe("line1\nline2\nline3");
    });

    // 仕様: timeoutMs 超過時はプロセスを kill して reject する（claude/gh のハング対策）
    it("timeoutMs 超過時にプロセスを kill して reject する", async () => {
      await expect(
        runner.run(
          "node",
          ["-e", "setTimeout(() => {}, 10000)"],
          { cwd: process.cwd(), timeoutMs: 100 },
        ),
      ).rejects.toThrow(/timed out after 100ms/);
    });

    // 仕様: timeoutMs を設定しても、その範囲内に終わるプロセスは通常どおり resolve する
    it("timeoutMs 内に終わるプロセスは正常に resolve する", async () => {
      const result = await runner.run(
        "node",
        ["-e", "process.stdout.write('quick')"],
        { cwd: process.cwd(), timeoutMs: 5000 },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("quick");
    });
  });
  ```

- [ ] **Step 14: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: `timeoutMs 超過時に...` が失敗。timeout 未実装のためプロセスは 10s 走り続け、vitest のテストタイムアウトで `Test timed out in 5000ms`（reject も `timed out after 100ms` の throw も起きない）。

- [ ] **Step 15: timeout（kill→reject）を実装する**
  `src/exec.ts` に timeout タイマを追加し、`settle` 時にタイマをクリアする。

  `old_string`:
  ```typescript
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };
  ```
  を次に置換:
  ```typescript
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
  ```

  注: `setTimeout` のコールバックは `settle` を呼ぶが、`settle` 内で `clearTimeout(timeoutHandle)` を呼んでも既に発火済みのタイマには無害。`child.kill("SIGKILL")` 後の `close`（code=null, signal="SIGKILL"）は `settled=true` により無視される。

- [ ] **Step 16: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 6 tests passed（正常2 + 行ストリーミング2 + timeout2）。

- [ ] **Step 17: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: 全てグリーン。

- [ ] **Step 18: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add src/exec.ts tests/exec.test.ts && git commit -m "feat: RealCommandRunner kills and rejects on timeoutMs"`

---

#### サブタスク 3d: FakeCommandRunner + fixedClock / instantSleep（tests/fakes.ts、カーネル §6 シグネチャ）

**Files:**
- Create: `/home/racoma-dev/loop-pilot-os/tests/fakes.ts`
- Test: `/home/racoma-dev/loop-pilot-os/tests/exec.test.ts`

注: `tests/fakes.ts` は後続タスク（12/13/14 等）が他のフェイク（FakeTaskSource 等）を追記する共有ファイル。このタスクでは `FakeCommandRunner` と `fixedClock` / `instantSleep` を定義する（§6 の他クラスは各タスクが追加）。`fixedClock` / `instantSleep` は最初の消費者が Task 6（および Task 12）であり、ここで実装しておかないと import が解決できず red→green が成立しないため、本タスクで先取りして定義する。

- [ ] **Step 19: 失敗するテストを追加する（FakeCommandRunner の前方一致・未登録 throw・calls 記録・行供給）**
  `tests/exec.test.ts` の末尾（`describe("RealCommandRunner", ...)` の閉じ `});` の後、ファイル末尾）に新しい `describe` を追加する。import 行も先頭に追記する。

  まず import を更新する。`old_string`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { RealCommandRunner } from "../src/exec.js";
  ```
  を次に置換:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { RealCommandRunner } from "../src/exec.js";
  import { FakeCommandRunner, fixedClock, instantSleep } from "./fakes.js";
  ```

  次にファイル末尾（`RealCommandRunner` の `describe` 閉じ `});` の直後）に追加:
  ```typescript

  describe("FakeCommandRunner", () => {
    // 仕様(§6): [cmd, ...args] の前方一致で登録応答を返し、欠落フィールドは既定値で埋める
    it("前方一致で登録した応答を返し、欠落フィールドを既定値で埋める", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["gh", "pr", "view"], { stdout: '{"state":"OPEN"}' });

      const result = await fake.run(
        "gh",
        ["pr", "view", "42", "--json", "state"],
        { cwd: "/repo" },
      );
      expect(result).toEqual({ code: 0, stdout: '{"state":"OPEN"}', stderr: "" });
    });

    // 仕様(§6): 関数レスポンダは実引数と opts を受け取り Partial<CommandResult> を返す
    it("関数レスポンダに実引数と opts を渡す", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["git", "rev-list"], (args) => ({ stdout: String(args.length) }));

      const result = await fake.run(
        "git",
        ["rev-list", "--count", "origin/main..HEAD"],
        { cwd: "/repo" },
      );
      expect(result.stdout).toBe("3");
      expect(result.code).toBe(0);
    });

    // 仕様(§6): 全呼び出しを calls に記録する
    it("全呼び出しを calls に記録する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["git"], { stdout: "ok" });

      await fake.run("git", ["status", "--porcelain"], { cwd: "/repo" });

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toEqual({
        cmd: "git",
        args: ["status", "--porcelain"],
        opts: { cwd: "/repo" },
      });
    });

    // 仕様(§6): 未登録の呼び出しは throw する（テストが想定外コマンドに気づける）
    it("未登録の呼び出しは throw する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["git"], { stdout: "ok" });

      await expect(
        fake.run("gh", ["pr", "view"], { cwd: "/repo" }),
      ).rejects.toThrow(/no FakeCommandRunner stub/);
    });

    // 仕様(§6): より長い前方一致が優先される（具体的な登録が一般的な登録を上書き）
    it("より長い前方一致を優先する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["gh"], { stdout: "generic" });
      fake.on(["gh", "pr", "merge"], { stdout: "specific" });

      const result = await fake.run(
        "gh",
        ["pr", "merge", "42", "--squash"],
        { cwd: "/repo" },
      );
      expect(result.stdout).toBe("specific");
    });

    // 仕様(§6): onStdoutLine が設定されていれば stub の stdout を改行で分割して逐次供給する
    it("onStdoutLine に stub stdout の各行を供給する", async () => {
      const fake = new FakeCommandRunner();
      fake.on(["claude"], { stdout: '{"type":"system"}\n{"type":"result"}\n' });

      const lines: string[] = [];
      await fake.run("claude", ["-p", "hi"], {
        cwd: "/wt",
        onStdoutLine: (line) => lines.push(line),
      });
      expect(lines).toEqual(['{"type":"system"}', '{"type":"result"}']);
    });
  });

  describe("fixedClock", () => {
    // 仕様(§6): clock() は呼ぶ度に +1s 進んだ ISO 文字列を返す（決定的タイムスタンプ）
    it("連続呼び出しで 1 秒ずつ進む ISO 文字列を返す", () => {
      const clock = fixedClock("2026-06-06T00:00:00.000Z");
      expect(clock()).toBe("2026-06-06T00:00:00.000Z");
      expect(clock()).toBe("2026-06-06T00:00:01.000Z");
      expect(clock()).toBe("2026-06-06T00:00:02.000Z");
    });

    // 仕様(§6): start 引数で初回の基準時刻を指定できる
    it("start 引数で初回の基準時刻を指定できる", () => {
      const clock = fixedClock("2030-01-01T12:00:00.000Z");
      expect(clock()).toBe("2030-01-01T12:00:00.000Z");
      expect(clock()).toBe("2030-01-01T12:00:01.000Z");
    });

    // 仕様(§6): start 省略時も決定的な既定基準から +1s で進む
    it("start 省略時も決定的な既定基準から +1s で進む", () => {
      const clock = fixedClock();
      const first = clock();
      const second = clock();
      expect(Date.parse(second) - Date.parse(first)).toBe(1000);
    });
  });

  describe("instantSleep", () => {
    // 仕様(§6): sleep(ms) は即 resolve する（実時間待たない）
    it("即 resolve する（実時間を待たない）", async () => {
      const sleep = instantSleep();
      const before = Date.now();
      await sleep(60_000);
      expect(Date.now() - before).toBeLessThan(50);
    });

    // 仕様(§6): 呼び出された ms を calls に順に記録する
    it("呼び出された ms を calls に順に記録する", async () => {
      const sleep = instantSleep();
      await sleep(1000);
      await sleep(60_000);
      await sleep(300_000);
      expect(sleep.calls).toEqual([1000, 60_000, 300_000]);
    });
  });
  ```

- [ ] **Step 20: 実行して失敗を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される失敗: `Failed to resolve import "./fakes.js"`（`tests/fakes.ts` がまだ無く、`FakeCommandRunner` / `fixedClock` / `instantSleep` のいずれも解決できないため import 解決エラー）。

- [ ] **Step 21: FakeCommandRunner を実装する**
  `/home/racoma-dev/loop-pilot-os/tests/fakes.ts` を作成:
  ```typescript
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
  ```

- [ ] **Step 22: 実行して成功を確認する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npx vitest run tests/exec.test.ts`
  期待される成功: 17 tests passed（RealCommandRunner 6 + FakeCommandRunner 6 + fixedClock 3 + instantSleep 2）。

- [ ] **Step 23: `npm run check` を実行する**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && npm run check`
  期待: tsc（src）+ tsc（test、`tests/fakes.ts` を含む）+ vitest 全てグリーン。

- [ ] **Step 24: コミットする**
  コマンド: `cd /home/racoma-dev/loop-pilot-os && git add tests/fakes.ts tests/exec.test.ts && git commit -m "test: FakeCommandRunner with prefix-match stubbing plus fixedClock and instantSleep"`
