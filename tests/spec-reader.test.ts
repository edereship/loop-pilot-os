import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSpecContent } from "../src/spec-reader.js";

function makeTmpSpecDir(files: Record<string, string>): { repoPath: string; specDir: string } {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), "spec-reader-"));
  const specDir = "docs/specs";
  const absDir = path.join(repoPath, specDir);
  mkdirSync(absDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(absDir, name), content, "utf-8");
  }
  return { repoPath, specDir };
}

describe("loadSpecContent", () => {
  it("requirements.md を全文読み込む", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "# 要求\n\nプロダクトの要求仕様。",
    });
    const result = loadSpecContent(repoPath, specDir);
    expect(result.requirements).toBe("# 要求\n\nプロダクトの要求仕様。");
    expect(result.domainSpecs).toEqual([]);
  });

  it("requirements.md が無いとき文脈付きエラーを投げる", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "design.md": "要件定義。",
    });
    expect(() => loadSpecContent(repoPath, specDir)).toThrow(/requirements\.md.*mandatory/);
  });

  it("requirements.md が空のとき文脈付きエラーを投げる", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "",
    });
    expect(() => loadSpecContent(repoPath, specDir)).toThrow(/empty/);
  });

  it("requirements.md が空白のみのとき文脈付きエラーを投げる", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "   \n\n  ",
    });
    expect(() => loadSpecContent(repoPath, specDir)).toThrow(/empty/);
  });

  it("spec_dir が存在しないとき文脈付きエラーを投げる", () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), "spec-reader-"));
    expect(() => loadSpecContent(repoPath, "nonexistent/dir")).toThrow(/product\.spec_dir/);
  });

  it("spec_dir が絶対パスのとき拒否する", () => {
    const { repoPath } = makeTmpSpecDir({ "requirements.md": "要求" });
    expect(() => loadSpecContent(repoPath, "/docs/specs")).toThrow(/relative/);
  });

  it("spec_dir が .. でリポジトリ外に逃げるとき拒否する", () => {
    const { repoPath } = makeTmpSpecDir({ "requirements.md": "要求" });
    expect(() => loadSpecContent(repoPath, "../outside")).toThrow(/outside/);
  });

  it("spec_dir が .. を含むがリポジトリ内に留まるとき許可する（パス解決後にリポジトリ外へ出ない）", () => {
    const { repoPath } = makeTmpSpecDir({ "requirements.md": "要求" });
    // docs/../docs/specs resolves to docs/specs which exists with requirements.md → succeeds
    const result = loadSpecContent(repoPath, "docs/../docs/specs");
    expect(result.requirements).toBe("要求");
  });

  it("README.md を領域ファイルから除外する", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "要求",
      "README.md": "インデックス（注入しない）",
      "core-loop.md": "コアループ仕様。",
    });
    const result = loadSpecContent(repoPath, specDir);
    expect(result.domainSpecs).toHaveLength(1);
    expect(result.domainSpecs[0].name).toBe("core-loop");
  });

  it("非 .md ファイルを領域ファイルから除外する", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "要求",
      "core-loop.md": "仕様",
      "notes.txt": "テキストファイル",
      "data.json": "{}",
    });
    const result = loadSpecContent(repoPath, specDir);
    expect(result.domainSpecs).toHaveLength(1);
    expect(result.domainSpecs[0].name).toBe("core-loop");
  });

  it("領域ファイルをアルファベット順で返す", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "要求",
      "z-notifications.md": "通知仕様。",
      "a-auth.md": "認証仕様。",
      "m-monitor.md": "モニタ仕様。",
    });
    const result = loadSpecContent(repoPath, specDir);
    expect(result.domainSpecs.map((s) => s.name)).toEqual([
      "a-auth",
      "m-monitor",
      "z-notifications",
    ]);
  });

  it("領域ファイルの name は .md 拡張子なし", () => {
    const { repoPath, specDir } = makeTmpSpecDir({
      "requirements.md": "要求",
      "design-spec-v1-core-loop.md": "仕様内容。",
    });
    const result = loadSpecContent(repoPath, specDir);
    expect(result.domainSpecs[0].name).toBe("design-spec-v1-core-loop");
    expect(result.domainSpecs[0].content).toBe("仕様内容。");
  });
});
