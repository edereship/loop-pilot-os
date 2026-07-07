import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { loadSpecContent, loadSpecContentAtRef } from "../src/spec-reader.js";
import { RealCommandRunner } from "../src/exec.js";
import { FakeCommandRunner } from "./fakes.js";

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

  it("spec_dir がリポジトリ外へのシンボリックリンクのとき拒否する", () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), "spec-reader-"));
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "spec-outside-"));
    writeFileSync(path.join(outsideDir, "requirements.md"), "要求", "utf-8");
    const linkPath = path.join(repoPath, "docs");
    symlinkSync(outsideDir, linkPath);
    expect(() => loadSpecContent(repoPath, "docs")).toThrow(/outside|symlink/);
  });

  it("requirements.md がリポジトリ外へのシンボリックリンクのとき拒否する", () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), "spec-reader-"));
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "spec-outside-"));
    writeFileSync(path.join(outsideDir, "secret.md"), "外部ファイル", "utf-8");
    const specDirAbs = path.join(repoPath, "docs", "specs");
    mkdirSync(specDirAbs, { recursive: true });
    symlinkSync(path.join(outsideDir, "secret.md"), path.join(specDirAbs, "requirements.md"));
    expect(() => loadSpecContent(repoPath, "docs/specs")).toThrow(/outside|symlink/);
  });

  it("領域ファイルがリポジトリ外へのシンボリックリンクのとき拒否する", () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), "spec-reader-"));
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "spec-outside-"));
    writeFileSync(path.join(outsideDir, "secret.md"), "外部ファイル", "utf-8");
    const specDirAbs = path.join(repoPath, "docs", "specs");
    mkdirSync(specDirAbs, { recursive: true });
    writeFileSync(path.join(specDirAbs, "requirements.md"), "要求", "utf-8");
    symlinkSync(path.join(outsideDir, "secret.md"), path.join(specDirAbs, "external.md"));
    expect(() => loadSpecContent(repoPath, "docs/specs")).toThrow(/outside|symlink/);
  });
});

describe("loadSpecContentAtRef（ES-521: handoff 基点の trusted spec 読み）", () => {
  it("ls-tree（非再帰）のファイル一覧から requirements.md と domain specs をアルファベット順で読む", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt", "ls-tree", "--name-only", "abc123", "--", "docs/specs/"], {
      code: 0,
      stdout: "docs/specs/zebra.md\ndocs/specs/requirements.md\ndocs/specs/alpha.md\ndocs/specs/note.txt\n",
    });
    runner.on(["git", "-C", "/wt", "show", "abc123:docs/specs/requirements.md"], { code: 0, stdout: "REQ" });
    runner.on(["git", "-C", "/wt", "show", "abc123:docs/specs/alpha.md"], { code: 0, stdout: "A" });
    runner.on(["git", "-C", "/wt", "show", "abc123:docs/specs/zebra.md"], { code: 0, stdout: "Z" });

    const spec = await loadSpecContentAtRef("/wt", "docs/specs", "abc123", runner);

    expect(spec).toEqual({
      requirements: "REQ",
      domainSpecs: [
        { name: "alpha", content: "A" },
        { name: "zebra", content: "Z" },
      ],
    });
  });

  it("README.md とネストした .md（ls-tree 非再帰では拡張子なしのディレクトリ名として現れる）が除外される", async () => {
    const runner = new FakeCommandRunner();
    // ls-tree --name-only（非再帰）はサブディレクトリを拡張子なしの名前で返す。
    // README.md は working tree 版と同じ規則（basename 一致）で除外する。
    runner.on(["git", "-C", "/wt", "ls-tree", "--name-only", "abc123", "--", "docs/specs/"], {
      code: 0,
      stdout: "docs/specs/requirements.md\ndocs/specs/README.md\ndocs/specs/core-loop.md\ndocs/specs/nested\n",
    });
    runner.on(["git", "-C", "/wt", "show", "abc123:docs/specs/requirements.md"], { code: 0, stdout: "REQ" });
    runner.on(["git", "-C", "/wt", "show", "abc123:docs/specs/core-loop.md"], { code: 0, stdout: "CORE" });

    const spec = await loadSpecContentAtRef("/wt", "docs/specs", "abc123", runner);

    expect(spec).toEqual({
      requirements: "REQ",
      domainSpecs: [{ name: "core-loop", content: "CORE" }],
    });
  });

  it("requirements.md が存在しない ref では null を返す", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt", "ls-tree"], { code: 0, stdout: "docs/specs/alpha.md\n" });
    expect(await loadSpecContentAtRef("/wt", "docs/specs", "abc123", runner)).toBeNull();
  });

  it("requirements.md が空（空白のみ含む）のとき null を返す", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt", "ls-tree", "--name-only", "abc123", "--", "docs/specs/"], {
      code: 0,
      stdout: "docs/specs/requirements.md\n",
    });
    runner.on(["git", "-C", "/wt", "show", "abc123:docs/specs/requirements.md"], { code: 0, stdout: "   \n\n  " });

    expect(await loadSpecContentAtRef("/wt", "docs/specs", "abc123", runner)).toBeNull();
  });

  it("git 失敗（ls-tree 非0 / show 非0 / throw）では null を返す", async () => {
    const runner = new FakeCommandRunner();
    runner.on(["git", "-C", "/wt", "ls-tree"], { code: 128, stderr: "bad ref" });
    expect(await loadSpecContentAtRef("/wt", "docs/specs", "bad", runner)).toBeNull();

    const runner2 = new FakeCommandRunner();
    runner2.on(["git", "-C", "/wt", "ls-tree"], { code: 0, stdout: "docs/specs/requirements.md\n" });
    runner2.on(["git", "-C", "/wt", "show"], { code: 128, stderr: "missing object" });
    expect(await loadSpecContentAtRef("/wt", "docs/specs", "abc123", runner2)).toBeNull();

    const runner3 = new FakeCommandRunner(); // 未登録 → reject
    expect(await loadSpecContentAtRef("/wt", "docs/specs", "abc123", runner3)).toBeNull();
  });

  describe("実 git 統合テスト（fake の git 挙動誤スタブでは検知できなかった regression の再発防止）", () => {
    let tmpRepo: string | undefined;

    afterEach(() => {
      if (tmpRepo !== undefined) {
        rmSync(tmpRepo, { recursive: true, force: true });
        tmpRepo = undefined;
      }
    });

    it("実 git バイナリで requirements.md と直下 domain specs を読み、README/nested は除外する", async () => {
      tmpRepo = mkdtempSync(path.join(os.tmpdir(), "spec-ref-"));
      const specDirAbs = path.join(tmpRepo, "docs", "specs");
      mkdirSync(path.join(specDirAbs, "sub"), { recursive: true });
      writeFileSync(path.join(specDirAbs, "requirements.md"), "REQ", "utf-8");
      writeFileSync(path.join(specDirAbs, "alpha.md"), "A", "utf-8");
      writeFileSync(path.join(specDirAbs, "README.md"), "index, not injected", "utf-8");
      writeFileSync(path.join(specDirAbs, "sub", "nested.md"), "nested, not injected", "utf-8");

      execFileSync("git", ["init"], { cwd: tmpRepo });
      execFileSync("git", ["add", "-A"], { cwd: tmpRepo });
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x"],
        { cwd: tmpRepo },
      );
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo })
        .toString()
        .trim();

      const runner = new RealCommandRunner();
      const spec = await loadSpecContentAtRef(tmpRepo, "docs/specs", sha, runner);

      expect(spec).toEqual({
        requirements: "REQ",
        domainSpecs: [{ name: "alpha", content: "A" }],
      });
    });
  });
});
