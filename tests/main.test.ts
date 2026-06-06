import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mainTsPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main.ts",
);

describe("main.ts CLI エントリ — bin 起動契約", () => {
  // package.json の bin は dist/main.js を指す。shebang が無い bin スクリプトは
  // POSIX で npx / npm link 経由の起動に失敗する（OS が node で実行することを知れない）。
  // tsc は .ts 先頭行の shebang をそのまま emit するため、src 側の先頭行を固定する。
  it("先頭行が #!/usr/bin/env node である", () => {
    const firstLine = readFileSync(mainTsPath, "utf8").split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});
