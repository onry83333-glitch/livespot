# SLS ユースケースドリブン全ページ再整理レポート

> 生成日時: 2026-03-10
> 基準: sls-page-structure-report.md + コード実調査
> 目的: 属性別ユースケース×ページ構造の再整理、不要・重複の検出、改善提案

---

## 1. 属性別ユースケース × ページ マトリクス

### A) 「もしキャストだったら」

| ユースケース | ページ | タブ/セクション | 操作 |
|---|---|---|---|
| 自分の売上を確認したい | `/casts/[castName]` | `?tab=analytics` → 売上一覧セクション | coin_transactions テーブル + `get_cast_paid_users` RPC で課金ユーザー×金額一覧 |
| 今週/先週の売上概要 | `/casts/[castName]` | `?tab=overview` → WeeklyRevenueKPIs | 今週/先週売上・前週比カード |
| 配信セッション一覧で売上推移 | `/casts/[castName]/sessions` | メイン画面 | TrendChart（棒グラフ+折れ線）+ セッション別売上カード |
| 今日の配信の振り返りをしたい | `/casts/[castName]/sessions/[sessionId]` | `?mode=post` | 配信後モード: トップチッパー/初応援/高額応援/訪問のみ/フォローDMキュー |
| タイムラインで配信を再確認 | `/casts/[castName]/sessions/[sessionId]` | TranscriptTimeline | 文字起こし+チャット+課金の時刻突合タイムライン |
| 自分のDMの効果を知りたい | `/casts/[castName]` | `?tab=dm` → 効果測定サブタブ | `get_dm_campaign_effectiveness` RPC → キャンペーン別CVR/再課金率 |
| DM送信履歴を見たい | `/casts/[castName]` | `?tab=dm` → ユーザー別サブタブ | dm_send_log一覧 + ステータス（success/error/pending） |
| AIに次の配信のアドバイスをもらいたい | `/casts/[castName]` | `?tab=reports` | CastReportsTab → AIフィードバックレポート表示 |
| 配信前にDM準備したい | `/casts/[castName]/sessions/[sessionId]` | `?mode=pre` | セグメント別DM準備画面 + テンプレート選択 + 一括送信 |
| 競合と比較したい | `/casts/[castName]` | `?tab=competitors` | CompetitorList + CompetitorDiffReport（Claude AIによる差分分析） |
| 時間帯別パフォーマンスを知りたい | `/casts/[castName]` | `?tab=analytics` → 時間帯パフォーマンス | `get_hourly_perf_stats` RPC → 配信時間/視聴者/トークン |
| ペルソナ（AI人格）を設定したい | `/casts/[castName]` | `?tab=settings` | BasicInfoEditor + PersonaTab（cast_personas 3層設定） |

### B) 「もし事務所（石村）だったら」

| ユースケース | ページ | タブ/セクション | 操作 |
|---|---|---|---|
| 全キャストの今週の売上を一目で見たい | `/casts` | SummaryKPICards | 30日売上/今週売上/前週比/登録数/配信中/VIP/DM送信数 の7枚KPIカード |
| キャスト別ランキングで比較 | `/casts` | CastListTable | ランク/名前/今日/今週/前週比/最終活動 のテーブル |
| 誰がLIVE中か確認したい | `/casts` | LiveCastsBar | 配信中キャストのリアルタイム表示バー（chat_logsベース） |
| SPY画面でも確認 | `/spy` | 自社キャスト → リアルタイム | Realtimeチャット監視 + LIVE判定 |
| 特定キャストのDMを代理送信したい | `/casts/[castName]` | `?tab=dm` → DM送信サブタブ | ユーザー選択 → メッセージ入力 → Stripchat API経由送信 |
| DM一括送信（セグメント別） | `/casts/[castName]/sessions/[sessionId]` | `?mode=pre` or `?mode=post` | セグメント選択 → テンプレート → `queueDmBatch` RPC |
| 新キャストを登録したい | `/admin/casts/new` | RegistrationForm | cast_name/表示名/PF/モデルID/ジャンル/収益シェア率 入力 → registered_casts INSERT |
| 既存キャスト一覧管理 | `/admin/casts` | 自社キャストタブ | インライン編集 + 有効化/無効化/削除 |
| 収益シェアを計算したい | `/admin/revenue` | FilterBar + ResultsTable | キャスト選択 → 期間指定 → `calculate_revenue_share` RPC → 週次分解テーブル + CSV出力 |
| DMシナリオを管理したい | `/admin/scenarios` | シナリオ一覧タブ | ScenarioGrid（トリガー/ステップ/登録数）+ 作成/編集モーダル |
| キャストの健全度を見たい | `/casts/[castName]` | `?tab=settings` → HealthScore | 5軸レーダー（スケジュール安定度/売上トレンド/配信品質/自力集客力/組織依存度） |

### C) 「もし代理店・外部（YUUTA）だったら」

| ユースケース | ページ | タブ/セクション | 操作 |
|---|---|---|---|
| 事業全体の健全性をチェックしたい | `/admin/health` | SummaryBadges + QualityChecks | OK/warn/errorカウント + 品質チェックアコーディオン |
| データ品質を詳細チェック | `/admin/data-quality` | CheckResults | `check_spy_data_quality` RPC → Gap/Duplicate/鮮度検出 |
| Collector同期状態を確認 | `/admin/health` | SyncHealthTable | `get_sync_health` RPC → spy_chat/spy_viewer/coin_sync/screenshotの同期状態 |
| 他社キャストをSPYしたい | `/spy` | 競合分析タブ → リアルタイム | 他社チャット監視 + 型カタログ + マーケット分析 |
| 競合キャスト管理 | `/spy` | 競合分析 → キャスト一覧 | spy_casts インライン編集 + 消滅判定トグル |
| 競合キャスト別詳細分析 | `/spy/[castName]` | 4タブ: 概要/配信ログ/ユーザー/フォーマット | `get_spy_cast_stats` + セッション一覧 + ユーザーランキング |
| ユーザーの横断行動を追跡 | `/spy/users/[username]` | 全セクション | キャスト別活動テーブル + 最近メッセージ50件 |
| AIの分析精度を確認・改善したい | `/casts/[castName]` | `?tab=reports` | AIレポート表示 + persona_feedback でスコア確認 |
| ペルソナ生成品質を評価 | `/api/persona/feedback` (API) | — | GET: フィードバック一覧（スコアフィルタ） |
| システムの異常を検知したい | `/alerts/system` | FilterControls + AlertListCards | 重要度/種類/既読フィルタ + Realtimeアラート購読 |
| テストデータを管理したい | `/admin/test-data` | TableCards | dm_send_log/chat_logs/dm_trigger_logs のテスト行カウント+削除 |
| マーケット全体のトレンド | `/spy` | 競合分析 → マーケット | `get_market_trend` RPC → 自社vs他社の日次シェア推移 |

---

## 2. クリック連動性マップ（ページ → 遷移先）

### サイドバー（全ページ共通）
| リンク | 遷移先 |
|---|---|
| ダッシュボード | `/casts`（`/` は `/casts` へリダイレクト） |
| SPY | `/spy` |
| アラート | `/alerts` |
| キャスト管理 | `/admin/casts` |
| DMシナリオ | `/admin/scenarios` |
| テストデータ | `/admin/test-data` |

### `/casts` — キャスト一覧
| 操作 | 遷移先/動作 |
|---|---|
| キャスト名クリック | → `/casts/[castName]?tab=sessions` |
| 「キャスト登録」ボタン | → モーダル展開（RegistrationForm） |
| キャスト編集アイコン | → インライン編集モード |
| アカウント切替 | → state更新 → データ再取得 |

### `/casts/[castName]` — キャスト詳細（7タブ）
| 操作 | 遷移先/動作 |
|---|---|
| タブ: overview | → KPIカード + トップチッパー + 最近メッセージ |
| タブ: sessions | → SessionListAccordion + BroadcastAnalysis |
| タブ: dm | → 6サブタブ（ユーザー別/送信/セグメント/キャンペーン/シナリオ/効果測定） |
| タブ: analytics | → セグメント分布 + 時間帯 + 売上 + 新規獲得 |
| タブ: reports | → AIレポート一覧 |
| タブ: settings | → 基本情報 + 健全度 + コインレート |
| タブ: competitors | → 競合リスト + AI差分分析 |
| セッション行クリック | → `/casts/[castName]/sessions/[sessionId]` |
| ユーザー名クリック | → `/users/[username]` |
| DM送信ボタン | → インラインDMコンポーザー展開 |
| 「← キャスト」パンくず | → `/casts` |
| Stripchatリンク | → 外部: stripchat.com (新タブ) |

### `/casts/[castName]/sessions` — セッション一覧
| 操作 | 遷移先/動作 |
|---|---|
| セッション行クリック | → `/casts/[castName]/sessions/[sessionId]?mode=pre` |
| 「最新セッションを開く」 | → 最新sessionIdへ自動遷移 |
| 期間フィルタ変更 | → state更新 → データ再取得 |
| CSV出力ボタン | → CSVファイルダウンロード |
| 「← [castName]」パンくず | → `/casts/[castName]` |

### `/casts/[castName]/sessions/[sessionId]` — セッション詳細
| 操作 | 遷移先/動作 |
|---|---|
| モード切替: pre | → DM準備画面（セグメント別+テンプレート） |
| モード切替: live | → リアルタイムチャット+統計 |
| モード切替: post | → 振り返り（トップチッパー/初応援/高額） |
| ユーザー名クリック | → `/users/[username]` |
| DM送信 | → dm_send_log INSERT + Stripchat API |
| フォローDM一括 | → `queueDmBatch` RPC |
| 「← セッション一覧」パンくず | → `/casts/[castName]/sessions` |

### `/spy` — SPYダッシュボード
| 操作 | 遷移先/動作 |
|---|---|
| メインタブ: 自社キャスト | → サブタブ3つ（リアルタイム/キャスト一覧/レポート） |
| メインタブ: 競合分析 | → サブタブ4つ（リアルタイム/キャスト一覧/型カタログ/マーケット） |
| キャスト行クリック | → `/spy/[castName]?tab=overview` |
| ユーザー名クリック | → `/spy/users/[username]` |
| 「全タブオープン」ボタン | → Chrome拡張メッセージ |
| Stripchatリンク | → 外部: stripchat.com (新タブ) |

### `/spy/[castName]` — SPYキャスト別
| 操作 | 遷移先/動作 |
|---|---|
| タブ: 概要 | → 統計カード + 型情報 |
| タブ: 配信ログ | → セッション一覧アコーディオン |
| タブ: ユーザー分析 | → ユーザーランキング + ステータスバッジ |
| タブ: フォーマット | → プレースホルダー |
| ユーザー名クリック | → `/spy/users/[username]` |
| 「← SPY」パンくず | → `/spy` |

### `/spy/users/[username]` — SPYユーザー横断
| 操作 | 遷移先/動作 |
|---|---|
| キャスト名クリック | → `/spy/[castName]` |
| 「← SPY」パンくず | → `/spy` |

### `/alerts` — VIP入室アラート
| 操作 | 遷移先/動作 |
|---|---|
| ユーザー選択 | → 右パネルに詳細表示（累計コイン/Lv/DM履歴） |
| DM送信ボタン | → `/dm` 遷移 |
| 閾値スライダー | → state更新（localStorage保存） |
| 「システム通知」リンク | → `/alerts/system` |

### `/alerts/system` — システム通知
| 操作 | 遷移先/動作 |
|---|---|
| 既読にする | → alerts UPDATE |
| 全て既読 | → alerts UPDATE(bulk) |
| 「← アラート」パンくず | → `/alerts` |

### `/feed` — SNS投稿管理
| 操作 | 遷移先/動作 |
|---|---|
| タブ: 投稿一覧 | → PostCards一覧 |
| タブ: 分析 | → 投稿数/いいね/タイプ別チャート |
| 「新規投稿作成」ボタン | → CreatePostModalモーダル |

### `/reports` — AIレポート
| 操作 | 遷移先/動作 |
|---|---|
| レポートカードクリック | → アコーディオン展開（Markdown表示） |
| アカウント切替 | → state更新 → データ再取得 |

### `/admin/casts` — キャスト管理
| 操作 | 遷移先/動作 |
|---|---|
| タブ: 自社キャスト | → ActiveCastsTable（インライン編集） |
| タブ: 他社キャスト | → SpyCastsTable（インライン編集） |
| 「新規キャスト追加」 | → `/admin/casts/new?account=...` |
| キャスト名クリック | → `/casts/[castName]` |
| SPYリンク | → `/spy/[castName]` |

### `/admin/casts/new` — 新規キャスト登録
| 操作 | 遷移先/動作 |
|---|---|
| 「登録」ボタン | → INSERT成功後 → `/admin/casts` |
| 「キャンセル」 | → `/admin/casts` |

### `/admin/scenarios` — DMシナリオ管理
| 操作 | 遷移先/動作 |
|---|---|
| タブ: シナリオ一覧 | → ScenarioGridカード |
| タブ: エンロールメント監視 | → ユーザー進捗テーブル |
| シナリオ編集 | → ScenarioEditModalモーダル |
| 「キュー処理実行」 | → POST /api/scenario/process |

### `/admin/health` — 品質チェック
| 操作 | 遷移先/動作 |
|---|---|
| 品質チェックアコーディオン | → 詳細結果展開 |
| 「データ品質チェック」リンク | → `/admin/data-quality` |

### `/admin/data-quality` — データ品質
| 操作 | 遷移先/動作 |
|---|---|
| 「チェック実行」ボタン | → RPC実行 → 結果表示 |
| 「← ヘルス」パンくず | → `/admin/health` |

### `/admin/revenue` — 収益シェア
| 操作 | 遷移先/動作 |
|---|---|
| 「計算する」ボタン | → `calculate_revenue_share` RPC実行 |
| 週次行展開 | → 計算式詳細アコーディオン |
| 「エクスポート」 | → CSVダウンロード |

### `/admin/test-data` — テストデータ
| 操作 | 遷移先/動作 |
|---|---|
| 「全テーブルスキャン」 | → `count_test_data` RPC |
| 「テストデータ削除」 | → `delete_test_data` RPC |

### `/login` → `/signup` → `/casts`（認証フロー）
| 操作 | 遷移先 |
|---|---|
| ログイン成功 | → `/casts` |
| 「新規登録」リンク | → `/signup` |
| サインアップ成功 | → 確認メール画面 → `/login` |

---

## 3. 不要・重複リスト

### 3-A. 同じデータを複数ページで表示

| データソース | 表示ページ | 問題 |
|---|---|---|
| `coin_transactions` | `/casts`(3箇所), `/casts/[castName]`(9箇所), `/admin/data-quality` | **最重複**: [castName]内で9回個別クエリ。共通hookなし |
| `registered_casts` | `/casts`(4回), `/spy`(5回), `/casts/[castName]`(4回), `/admin/casts`(3回) | 16回クエリ。useRegisteredCasts() hook不在 |
| `dm_send_log` | `/casts`(1), `/alerts`(1), `/casts/[castName]`(7), `/sessions/[sessionId]`(2), `/admin/health`(1), `/admin/test-data`(1) | 16回。[castName]のDMタブだけで7回 |
| `chat_logs` | `/casts`(1), `/spy`(Realtime), `/alerts`(2), `/admin/health`(1), `/admin/test-data`(1) | Realtime+SELECT混在 |
| `get_cast_stats` RPC | `/casts`(一覧), `/casts/[castName]`(詳細) | 一覧→詳細遷移でキャッシュせず再取得 |
| `get_session_list_v2` RPC | `/casts/[castName]?tab=sessions`, `/casts/[castName]/sessions` | 同じセッション一覧を2ページで独立取得 |

### 3-B. Dead Code / プレースホルダー

| ページ/機能 | 状態 | 推奨 |
|---|---|---|
| `/spy/analysis/page.tsx` (13行) | 「SPYデータを蓄積中です」プレースホルダーのみ | **削除**: `/spy` のマーケットサブタブに統合済み |
| `/admin/command-center/page.tsx` (5行) | `notFound()` を返すだけ | **削除**: 機能未実装、ルート不要 |
| `/page.tsx` (5行) | `/casts` へリダイレクトのみ | **統合**: middleware.tsでリダイレクト |
| `/casts/[castName]` line 1966 | `alert('この機能は準備中です')` | **削除or実装**: プレースホルダーalert |
| `/spy/[castName]` フォーマットタブ | FormatTab — プレースホルダー | **削除**: 実質空タブ |

### 3-C. 未使用API Routes

| Route | 行数 | 理由 |
|---|---|---|
| `/api/data/cast-profile` | 57行 | フロントから呼び出しなし（Persona Engine用だが未接続） |
| `/api/data/snapshots` | 57行 | フロントから呼び出しなし |
| `/api/scenario/goal` | 50行 | ゴール検出エンドポイント、フロントから未使用 |
| `/api/dm/batch` | 317行 | Supabase RPC (`create_dm_batch`) に置換済み |
| `/api/stripchat/test` | 114行 | デバッグ用、本番不要 |
| `/api/data/sessions` | — | service_role専用、フロント未使用 |
| `/api/data/chat-logs` | — | service_role専用、フロント未使用 |

### 3-D. 未使用RPC関数（定義済み・フロント未呼出）

| RPC | 定義SQL | 理由 |
|---|---|---|
| `arpu_trend` | 002 | 旧分析。新RPCに置換 |
| `daily_sales` | 002 | 旧分析。coin_transactions直クエリに置換 |
| `hourly_revenue` | 002 | 旧分析 |
| `revenue_breakdown` | 002 | 旧分析 |
| `retention_cohort` | 002 | 旧分析 |
| `top_users_detail` | 002 | 旧分析 |
| `dm_effectiveness` | 002 | `get_dm_campaign_effectiveness` に置換 |
| `get_hourly_heatmap` | — | 未使用 |
| `get_tip_clustering` | — | 未使用 |
| `get_dm_funnel` | — | 未使用 |
| `get_success_patterns` | — | 未使用 |
| `get_competitor_overview` | — | 競合分析だがフロント未接続 |
| `get_session_comparison` | — | 未使用 |
| `check_spy_data_integrity` | — | admin/data-quality の RPC版だがフォールバック実装で実質未使用 |

**合計: 85定義中38が未使用（45%）**

### 3-E. 詰め込みすぎ（過密ページ）

| ページ | 行数 | 問題 |
|---|---|---|
| `/casts/[castName]/page.tsx` | **6,635行** | 7タブ+25+状態変数+15+コールバック。DMタブだけで2,792行（42%） |
| `/spy/page.tsx` | **3,200行** | SpyListTabが2,040行（64%）。マーケット分析+キャストランキング混在 |
| `/casts/[castName]/sessions/[sessionId]/page.tsx` | **3,302行** | 3モード（pre/live/post）が1ファイル。pre=DM準備、live=Realtime、post=振り返り |
| `/admin/casts/page.tsx` | **928行** | 自社+他社キャスト管理の2テーブル+インライン編集 |

### 3-F. 薄すぎ（独立ページ不要）

| ページ | 行数 | 推奨 |
|---|---|---|
| `/page.tsx` | 5行 | middleware.tsリダイレクトで代替 |
| `/admin/command-center/page.tsx` | 5行 | 削除 |
| `/spy/analysis/page.tsx` | 13行 | 削除（SPYマーケットタブに統合済み） |
| `/reports/page.tsx` | 小規模 | `/casts/[castName]?tab=reports` に統合検討 |

---

## 4. コード改善提案リスト

### 4-A. page.tsx 6,635行の分割案

**現状のタブ別行数:**
| タブ | 行数 | 割合 |
|---|---|---|
| DM | 2,792 | 42% |
| Analytics | 1,637 | 25% |
| Reports | 412 | 6% |
| Sessions | 362 | 5% |
| Persona | 216 | 3% |
| Competitors | 177 | 3% |
| Settings | 154 | 2% |
| Overview | 43 | 1% |
| 共通（state/hooks/types） | ~800 | 12% |

**分割提案:**

```
frontend/src/app/casts/[castName]/
  page.tsx              # 親ルート: タブ切替 + 共通state (~300行)
  components/
    cast-overview.tsx    # overview タブ (~200行)
    cast-sessions.tsx    # sessions タブ (~400行)
    cast-dm/
      index.tsx          # DM タブルート (~300行)
      dm-send-panel.tsx  # DM送信UI (~600行)
      dm-campaign.tsx    # キャンペーン履歴 (~400行)
      dm-scenario.tsx    # シナリオ管理 (~300行)
      dm-effectiveness.tsx # 効果測定 (~200行)
      dm-user-history.tsx  # ユーザー別履歴 (~500行)
      dm-segment.tsx     # セグメント別 (~400行)
    cast-analytics/
      index.tsx          # analytics タブルート (~200行)
      segment-analysis.tsx # セグメント分析 (~400行)
      hourly-perf.tsx    # 時間帯パフォーマンス (~300行)
      sales-table.tsx    # 売上テーブル (~400行)
      acquisition.tsx    # 新規獲得 (~300行)
    cast-reports.tsx     # reports タブ (~400行)
    cast-settings.tsx    # settings タブ (~200行)
    cast-competitors.tsx # competitors タブ (~200行)
  hooks/
    use-cast-data.ts     # 共通データ取得hook (~150行)
```

**効果**: page.tsx は300行以下に。各コンポーネントが独立してテスト可能。

### 4-B. spy/page.tsx 3,200行の分割案

```
frontend/src/app/spy/
  page.tsx              # 親ルート: ビュー切替 (~200行)
  components/
    realtime-tab.tsx     # リアルタイム監視 (~660行)
    own-cast-list.tsx    # 自社キャスト一覧 (~170行)
    fb-reports-tab.tsx   # FBレポート (~120行)
    spy-list/
      index.tsx          # 競合キャスト一覧ルート (~300行)
      cast-ranking.tsx   # ランキング表示 (~400行)
      market-stats.tsx   # マーケット統計 (~400行)
      cast-metadata.tsx  # メタデータ編集 (~300行)
    market-analysis.tsx  # マーケット分析 (~400行)
    type-catalog.tsx     # 型カタログ (~200行)
```

### 4-C. RPC統合提案

| 現在 | 統合先 | 理由 |
|---|---|---|
| `daily_sales` + `revenue_breakdown` + `hourly_revenue` | 削除（未使用） | フロントから呼ばれていない |
| `arpu_trend` + `retention_cohort` + `top_users_detail` | 削除（未使用） | 002系は全て旧世代 |
| `get_session_list` + `get_session_list_v2` | `get_session_list_v2` のみ残す | v1は不要 |
| `get_session_summary` + `get_session_summary_v2` | `get_session_summary_v2` のみ残す | v1は不要 |
| `get_spy_market_now` + `get_spy_viewer_trends` + `get_spy_revenue_types` | 1つの `get_spy_market_dashboard` に統合 | 常にセットで呼ばれる |
| `check_data_integrity` + `check_spy_data_quality` | 1つの `check_all_data_quality` に統合 | admin/healthとadmin/data-qualityで冗長 |

**削減効果**: 85 RPC → 推定 55 RPC（30関数削減）

### 4-D. API Route統合提案

| 現在 | 提案 | 理由 |
|---|---|---|
| `/api/data/sessions` + `/api/data/chat-logs` + `/api/data/cast-profile` + `/api/data/snapshots` + `/api/data/spy-summary` | 1つの `/api/data/[resource]` dynamic route | 全て同パターン（service_role + フィルタ）。6→1 |
| `/api/analysis/session-report` + `/api/analysis/run-session-report` | `/api/analysis/session-report` のみ | run- プロキシ不要（認証をroute内で解決） |
| `/api/analysis/competitor-diff` + `/api/analysis/run-competitor-diff` | `/api/analysis/competitor-diff` のみ | 同上 |
| `/api/dm/send` + `/api/dm/batch` | `/api/dm/batch` を削除 | Supabase RPC `create_dm_batch` に置換済み |
| `/api/stripchat/test` | 削除 | デバッグ用 |

**削減効果**: 22 API → 推定 14 API（8エンドポイント削減）

### 4-E. 共通Hook抽出提案

```typescript
// hooks/use-registered-casts.ts — 16回の個別クエリを1つに
export function useRegisteredCasts(accountId: string) {
  // SWR or React Query でキャッシュ
  // 全ページで共有、5分キャッシュ
}

// hooks/use-coin-stats.ts — coin_transactions の共通集計
export function useCoinStats(accountId: string, castName?: string, period?: string) {
  // 週次/月次/日次の売上をキャッシュ付きで取得
}

// hooks/use-cast-data.ts — キャスト詳細の共通データ
export function useCastData(castName: string) {
  // registered_casts + get_cast_stats + coin基本統計をまとめて取得
}
```

**効果**: ネットワークリクエスト数を約40%削減。コード行数を約20%削減。

### 4-F. その他の改善

| 項目 | 現状 | 提案 |
|---|---|---|
| タブ管理 | URLパラメータ `?tab=` とstate混在 | 統一: 全てURLパラメータで（ブックマーク可能に） |
| Realtime購読 | 各ページでバラバラに購読 | 共通RealtimeProvider contextで一元管理 |
| エラーハンドリング | `try/catch` → `console.error` パターンの繰返し | ErrorBoundary + toast通知の共通化 |
| ページネーション | 各ページで独自実装 | 共通 `usePagination` hook |
| Backend FastAPI | フロントから直接呼ばれていない（全てSupabase経由） | 廃止検討 or Collector専用に整理 |

---

## 5. サマリー

### 数値サマリー

| 項目 | 現状 | 改善後（推定） |
|---|---|---|
| 総ページ数 | 23 | 20（3ページ削除） |
| 最大ファイル行数 | 6,635行 | ~600行（分割後） |
| RPC関数 | 85 | ~55（30削減） |
| API Routes | 22 | ~14（8削減） |
| 未使用API | 7 | 0 |
| プレースホルダーページ | 3 | 0 |
| coin_transactions個別クエリ | 13回 | ~4回（hook共有） |
| registered_castsクエリ | 16回 | ~4回（hook共有） |

### 優先度マトリクス

| 優先度 | 改善項目 | 工数 | 効果 |
|---|---|---|---|
| **P0** | page.tsx DMタブ分割（2,792行→5ファイル） | 4h | 保守性大幅改善 |
| **P0** | 未使用API Route削除（7本） | 30min | コード衛生 |
| **P0** | 死んだページ3つ削除 | 15min | ルート整理 |
| **P1** | page.tsx 残りタブ分割 | 4h | 全タブ独立化 |
| **P1** | spy/page.tsx 分割 | 3h | 3,200行→200行 |
| **P1** | 共通Hook 3つ抽出 | 3h | クエリ40%削減 |
| **P2** | 旧RPC 30関数削除 | 2h | DB整理 |
| **P2** | Backend FastAPI整理 | 2h | 不要コード削減 |
| **P2** | タブ管理統一 | 2h | UX改善 |
| **P3** | Realtime購読一元化 | 4h | メモリリーク防止 |
| **P3** | エラーハンドリング統一 | 3h | 品質向上 |
