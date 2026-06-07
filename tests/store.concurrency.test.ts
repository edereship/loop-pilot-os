import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "helpers", "run-lock-worker.ts");

interface WorkerResult {
  pid: number;
  acquired: boolean;
  error: string | null;
}

function spawnWorker(dbPath: string, pid: number, goFile: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, dbPath, String(pid), goFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error(`worker pid=${pid} produced no output (code=${code}): ${err}`));
        return;
      }
      resolve(JSON.parse(line) as WorkerResult);
    });
  });
}

describe("SqliteStore.acquireRunLock — クロスプロセス競合（単一インスタンス不変条件）", () => {
  // 2 プロセスがほぼ同時に空ロックを奪いに来ても、ロックを取れるのは高々 1 つ。
  // 非トランザクション実装では両者が空を読んで両者取得（TOCTOU）するため、
  // この不変条件が複数トライアルにわたり成り立つことで原子性を担保する。
  it("ほぼ同時起動した 2 プロセスのうちロック取得に成功するのは高々 1 つ", async () => {
    const trials = 8;
    for (let t = 0; t < trials; t++) {
      const dir = mkdtempSync(path.join(tmpdir(), "looppilot-lock-"));
      const dbPath = path.join(dir, "looppilot-os.db");
      const goFile = path.join(dir, "go");
      try {
        // スキーマ作成（run_lock 空）
        new SqliteStore(dbPath).close();

        // 2 ワーカーを起動（go 待ちでスピン）→ 少し待って go を一斉解放
        const w1 = spawnWorker(dbPath, 1111, goFile);
        const w2 = spawnWorker(dbPath, 2222, goFile);
        await new Promise((r) => setTimeout(r, 250)); // 両者を起動・スピン状態にする
        writeFileSync(goFile, "go");

        const results = await Promise.all([w1, w2]);
        for (const r of results) {
          expect(r.error).toBeNull();
        }
        const acquiredCount = results.filter((r) => r.acquired).length;
        expect(acquiredCount).toBeLessThanOrEqual(1);
      } finally {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60000);
});
