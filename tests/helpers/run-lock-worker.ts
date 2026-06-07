// クロスプロセスのロック競合テスト用ワーカー（tests/store.concurrency.test.ts から spawn）。
// argv: <dbPath> <pid> <goFile>
// goFile が現れるまでスピンして待機（バリア）→ acquireRunLock を 1 回実行 → 結果を stdout に JSON 出力。
import { existsSync } from "node:fs";
import { SqliteStore } from "../../src/store.js";

const [dbPath, pidStr, goFile] = process.argv.slice(2);
const pid = Number(pidStr);

const store = new SqliteStore(dbPath);

// バリア: go ファイル出現までタイトにスピン（2 ワーカーの acquire を近接させる）。
const deadline = Date.now() + 10000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) break;
}

// isPidAlive=()=>true: 別 pid のロックは奪えない。空ロックを 2 者が同時取得できれば bug。
let acquired = false;
let error: string | null = null;
try {
  acquired = store.acquireRunLock(pid, () => true, new Date().toISOString());
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
}
store.close();

process.stdout.write(JSON.stringify({ pid, acquired, error }) + "\n");
