# docs/specs — 要求 / 要件定義（2層ドキュメント運用）

このディレクトリは LoopPilot OS の**プロダクト仕様の正本（canonical）**である。ループは worktree（= repo）から直接ここを読むため、**repo を正とし Linear はミラーにしない**（古いミラーで旧仕様のまま無人走行する silent な事故を原理的に消すため）。

## 2層モデル

| 層 | 性質 | 正本 | 編集 | セッション注入 |
| -- | -- | -- | -- | -- |
| **要求**（WHY/WHAT・North Star） | ほぼ不変 | `requirements.md` | 人間のみ・PR 経由 | **毎セッション必ず全文** |
| **要件定義**（HOW・領域別仕様） | 実装中に変化 | `<領域>.md`（capability 単位） | 人間 + PM(Codex) 提案・PR 経由 | **全領域（B1-a: 選別なし）** |

* **要求**は不変の錨。LLM の減衰記憶（直近 PR 要約）でなく、減衰しない要求/要件定義へ権威を移すのが狙い（B1 グラウンディング）。
* **要件定義**は実装中に育つ。**機能ドメイン（capability）単位**で切る。**コードのモジュール単位では切らない**（リファクタで陳腐化するため）。
* 最初から細かく割らず**最小限から遅延成長（YAGNI）**。必要になった領域だけファイルを足す。

## セッション注入レイアウト（B1）

毎セッション、以下の順でプロンプトを組む（`src/context-bundle.ts buildPrompt`）:

1. **要求**（`requirements.md` 全文）— 不変の錨・必須
2. **要件定義**（領域ファイル全件）— B1-a: 選別なし・全領域注入
3. **チケット / brief**（A2 濃化出力）— 今回やること
4. **最近の変更アウェアネス（digest）**— 軽い手がかり・最小・任意

> 作業規約（このリポでの作業ルール）は `CLAUDE.md` が worktree で agent に自動的に入るため、要求とは混ぜない。

## 現在のファイル

| ファイル | 層 | 領域 | 備考 |
| -- | -- | -- | -- |
| `requirements.md` | 要求 | プロダクト全体 | Linear「要求仕様書」を反映。以後 repo が正本 |
| `design-spec-v1-core-loop.md` | 要件定義 | コアループ（SELECT→…→DONE） | v1 設計仕様のスナップショット |

> ドッグフード対象 = LoopPilot OS 自身。よって要件定義の領域はループのフェーズ（GROOM/SELECT/CLAIM/DESIGN/DESIGN REVIEW/IMPLEMENT/SELF-REVIEW/HANDOFF/MONITOR/DONE）や v2/v3 機能（A1/A2/B1/R1・GROOM/横断メモリ）に概ね揃う。

## 関連

* ロードマップ & v2/v3+ スコープ（living）: Linear「[LoopPilot OS ロードマップ & スコープ（v2 / v3+）](https://linear.app/edereship/document/looppilot-os-ロードマップ-and-スコープv2-v3-3f38a59ae90d)」
* 各機能の設計ドキュメント（v2/v3/v3.5 の HOW）: `docs/superpowers/specs/`（例: `2026-06-22-v3-pm-autonomy-design.md`, `2026-06-27-v35-self-driving-hardening-design.md`）
* 運用モード = ship-and-correct（薄いチケットも人間ゲートで止めず妥当解釈で出荷、ズレは事後チケットで修正）。
