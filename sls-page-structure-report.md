# SLS 全ページ構造レポート

> 生成日時: 2026-03-10
> 総ページ数: **23**
> 総APIエンドポイント数: **22** (26メソッド)

---

## / (ルート)
**ファイル:** `frontend/src/app/page.tsx`

- [ ] `/casts` へ自動リダイレクトするだけのページ

---

## /casts — 自社キャスト管理一覧
**ファイル:** `frontend/src/app/casts/page.tsx`

### コンポーネント一覧
- [ ] **Header+AccountSelector** — アカウント切替ドロップダウン + キャスト追加ボタン / `accounts`
- [ ] **RegistrationForm** — 新規キャスト登録フォーム（名前/表示名/メモ） / `registered_casts INSERT`
- [ ] **SummaryKPICards** — 30日売上, 今週売上, 前週比, 登録キャスト数, 配信中, VIPアラート, DM送信数 / `RPC:get_weekly_coin_stats`, `coin_transactions`, `chat_logs`, `dm_send_log`
- [ ] **LiveCastsBar** — 配信中キャストのリアルタイム表示バー / `chat_logs`
- [ ] **CastListTable** — キャスト一覧テーブル（ランク/名前/タグ/今日/今週/前週比/最終活動/SS間隔/操作） / `registered_casts`, `RPC:get_cast_stats`

### アクション
- [ ] キャスト追加 → `registered_casts INSERT`
- [ ] キャスト編集（インライン） → `registered_casts UPDATE`
- [ ] キャスト無効化 → `registered_casts UPDATE is_active=false`

---

## /casts/[castName] — キャスト詳細ページ
**ファイル:** `frontend/src/app/casts/[castName]/page.tsx` (6772行)

### タブ構成: overview | sessions | dm | analytics | reports | settings | competitors

### overview タブ
- [ ] **WeeklyRevenueKPIs** — 今週/先週の売上・前週比 / `coin_transactions`
- [ ] **StatsCards** — 総メッセージ数, ユニークユーザー数 / `RPC:get_cast_stats`

### sessions タブ
- [ ] **SessionListAccordion** — セッション一覧（展開でチャットログ表示） / `sessions`, `chat_logs`
- [ ] **BroadcastAnalysis** — 配信日選択 + セッション詳細分析（コイン内訳/前回比較） / `RPC:get_session_list_v2`
- [ ] セッション展開/閉じる → `chat_logs SELECT`
- [ ] セッション詳細遷移 → `/casts/[castName]/sessions/[sessionId]`

### dm タブ
- [ ] **DMQueueStatus** — DM送信キュー状態（success/sending/queued/error） / `dm_send_log`
- [ ] **DMSectionTabs** — 6サブタブ: ユーザー別, DM送信, セグメント別, キャンペーン, シナリオ, 効果測定 / `dm_send_log`, `dm_scenarios`, `dm_scenario_enrollments`, `paid_users`
- [ ] DM送信 → `dm_send_log INSERT` + Stripchat API
- [ ] DMスケジュール → `dm_schedules INSERT`

### analytics タブ
- [ ] **UserSegmentAnalysis** — ユーザーセグメント分布（S1-S10+churned） / `RPC:get_cast_segments`
- [ ] **HourlyPerformance** — 時間帯別パフォーマンス（配信時間/視聴者/トークン） / `RPC:get_hourly_perf_stats`
- [ ] **SalesRevenue** — 売上一覧・課金ユーザーテーブル / `coin_transactions`, `RPC:get_cast_paid_users`, `RPC:get_dm_campaign_cvr`
- [ ] **AcquisitionAnalysis** — 新規ユーザー獲得分析 / `RPC:get_cast_acquisition_users`
- [ ] セグメント更新ボタン → `RPC:get_cast_segments`

### reports タブ
- [ ] **CastReportsTab** — AIレポート表示（外部コンポーネント） / `cast_knowledge`

### settings タブ
- [ ] **BasicInfoEditor** — 表示名/プラットフォーム/モデルID/アバター編集 / `registered_casts`
- [ ] **HealthScore** — キャスト健全度スコア（5軸レーダー: スケジュール安定度/売上トレンド/配信品質/自力集客力/組織依存度） / `RPC:get_cast_health_score`
- [ ] **CoinRateSettings** — コインレート・手数料設定 / `cast_cost_settings`
- [ ] 基本情報保存 → `registered_casts UPDATE`

### competitors タブ
- [ ] **CompetitorList** — 競合キャスト一覧 + 分析ボタン / `competitor_benchmarks`
- [ ] **CompetitorDiffReport** — Claude AIによる競合差分分析結果（revenue_gap/timing_gap/audience_gap/actionable_insights） / `API:POST /api/analysis/run-competitor-diff`
- [ ] 競合分析実行 → Claude API呼び出し（約30秒）

---

## /casts/[castName]/sessions — セッション一覧
**ファイル:** `frontend/src/app/casts/[castName]/sessions/page.tsx`

### コンポーネント一覧
- [ ] **PeriodFilter** — 今週/先週/今月/先月/全期間/カスタム切替 / state
- [ ] **SummaryKPICards** — セッション数, 平均配信時間, 総売上, 平均売上/配信, 総MSG数 / `RPC:get_session_list_v2`
- [ ] **TrendChart** — 売上棒グラフ + ユーザー数/DM送信数折れ線（Recharts ComposedChart） / `RPC:get_session_list_v2`, `dm_send_log`
- [ ] **SessionList** — セッションカード一覧（コイン内訳ミニバー/LIVE/統合バッジ付き） / `RPC:get_session_list_v2`
- [ ] **Pagination** — ページネーション

### アクション
- [ ] 期間フィルタ変更 → state→再取得
- [ ] CSV出力 → CSVファイルダウンロード
- [ ] 配信準備 → `/casts/[castName]/sessions/[sessionId]?mode=pre`

---

## /casts/[castName]/sessions/[sessionId] — セッション詳細
**ファイル:** `frontend/src/app/casts/[castName]/sessions/[sessionId]/page.tsx`
**モード:** `?mode=pre|live|post`

### コンポーネント一覧
- [ ] **SessionSummaryHeader** — 配信グループ情報/タイトル/売上/コイン内訳 / `RPC:get_session_summary`
- [ ] **TopUsers** — トップチッパー一覧 / `RPC:get_session_actions`
- [ ] **FirstTimePayers** — 初回応援ユーザー（DM送信状態付き） / `RPC:get_session_actions`
- [ ] **HighSpenders** — 高額応援ユーザー / `RPC:get_session_actions`
- [ ] **VisitedNoAction** — 訪問のみユーザー / `RPC:get_session_actions`
- [ ] **DMFollowupQueue** — DMフォローアップキュー / `dm_send_log`
- [ ] **SegmentBreakdown** — セグメント別DM送信/訪問/課金分布 / `user_profiles`
- [ ] **LiveChatTimeline** — リアルタイムチャットタイムライン（liveモードのみ） / `Realtime:chat_logs`
- [ ] **TranscriptTimeline** — 配信文字起こし+イベントタイムライン / `cast_transcripts`

### アクション
- [ ] 初応援ユーザーへお礼DM → `dm_send_log INSERT`
- [ ] 高額応援ユーザーへ特別DM → `dm_send_log INSERT`
- [ ] フォローDM一括送信 → `RPC:queueDmBatch`
- [ ] テンプレートで一括送信 → `dm_send_log INSERT`
- [ ] シナリオ登録 → `dm_scenario_enrollments INSERT`

---

## /spy — SPYリアルタイム監視ダッシュボード
**ファイル:** `frontend/src/app/spy/page.tsx` (3200行)

### タブ構成: 自社キャスト | 競合分析
### サブタブ
- 自社キャスト → リアルタイム | キャスト一覧 | レポート
- 競合分析 → リアルタイム | キャスト一覧 | 型カタログ | マーケット

### 自社キャスト/リアルタイム
- [ ] **RealtimeTab** — リアルタイムチャット監視 + メッセージフィルタ + CVR計算 / `Realtime:chat_logs`, `use_realtime_spy`

### 自社キャスト/キャスト一覧
- [ ] **OwnCastListTab** — 自社キャスト管理一覧 + 型割り当て / `RPC:get_registered_casts`

### 自社キャスト/レポート
- [ ] **FBReportsTab** — AIフィードバックレポート一覧 / `ai_reports`

### 競合分析/キャスト一覧
- [ ] **SpyListTab** — 競合キャスト監視リスト + インライン編集 / `spy_casts`, `RPC:get_spy_cast_stats`

### アクション
- [ ] 新規キャスト追加 → `registered_casts/spy_casts INSERT`
- [ ] Chrome拡張で全タブ開く → 外部リンク
- [ ] キャスト編集（インライン） → `spy_casts UPDATE`
- [ ] 消滅判定トグル → `spy_casts UPDATE is_extinct`

---

## /spy/[castName] — SPYキャスト別詳細
**ファイル:** `frontend/src/app/spy/[castName]/page.tsx`

### タブ構成: 概要 | 配信ログ | ユーザー分析 | フォーマット

### 概要タブ
- [ ] **OverviewCards** — メッセージ/チップ/コイン/ユニークユーザー + 型情報カード / `RPC:get_spy_cast_stats`, `cast_types`

### 配信ログタブ
- [ ] **SessionsTab** — 配信セッション一覧（アコーディオン展開） / `RPC:get_session_list_v2`, `chat_logs`

### ユーザー分析タブ
- [ ] **UsersTab** — 応援ユーザーランキング + ステータスバッジ（アクティブ/新規/リスク/離脱/無料） / `RPC:get_user_retention_status`

### フォーマットタブ
- [ ] **FormatTab** — フォーマット分析（プレースホルダー）

---

## /spy/users/[username] — SPYユーザー横断分析
**ファイル:** `frontend/src/app/spy/users/[username]/page.tsx`

### コンポーネント一覧
- [ ] **UserSummaryCards** — 合計コイン/合計メッセージ/訪問日数/最終確認 / `RPC:get_user_activity`
- [ ] **CastActivityTable** — キャスト別活動テーブル（COINS/MSG/訪問日/最終） / `RPC:get_user_activity`
- [ ] **RecentMessages** — 最近のメッセージ50件（全キャスト横断） / `chat_logs`

---

## /spy/analysis — 競合分析ダッシュボード
**ファイル:** `frontend/src/app/spy/analysis/page.tsx`

- [ ] **PlaceholderCard** — 「SPYデータを蓄積中です」プレースホルダーのみ

---

## /alerts — VIP入室アラート
**ファイル:** `frontend/src/app/alerts/page.tsx`

### コンポーネント一覧
- [ ] **LeftPanel:TriggerSettings** — CRITICAL/WARNING閾値スライダー + 休眠判定日数 / state
- [ ] **CenterPanel:AlertList** — 入室アラートカード一覧（VIPアイコン/レベル/コイン/キャスト名） / `Realtime:chat_logs(enter)`, `chat_logs`
- [ ] **RightPanel:UserDetails** — 選択ユーザー詳細（累計コイン/Lv/最終応援日/DM履歴） / `user_profiles`, `dm_send_log`

### アクション
- [ ] 閾値変更 → state
- [ ] ユーザー選択 → 右パネル詳細表示
- [ ] DM送信 → `/dm` 遷移
- [ ] デモデータ挿入 → `chat_logs INSERT`

---

## /alerts/system — システム通知
**ファイル:** `frontend/src/app/alerts/system/page.tsx`

### コンポーネント一覧
- [ ] **StatsCards** — 未読/重大/合計/種類カウント / `alerts`
- [ ] **FilterControls** — 重要度（全/重大/警告/情報）+ 種類 + 既読フィルタ / state
- [ ] **AlertListCards** — アラートカード一覧（タイプアイコン/メタデータタグ/未読ドット） / `alerts`, `Realtime:alerts`
- [ ] **Pagination** — ページネーション

### アクション
- [ ] 既読にする → `alerts UPDATE`
- [ ] 全て既読 → `alerts UPDATE(bulk)`

---

## /feed — SNS投稿管理+分析
**ファイル:** `frontend/src/app/feed/page.tsx`

### タブ構成: 投稿一覧 | 分析

### 投稿一覧タブ
- [ ] **PostCards** — 投稿カード一覧（タイプアイコン/キャスト名/内容/いいね/コメント） / `feed_posts`

### 分析タブ
- [ ] **PeriodSelector** — 7日/14日/30日切替
- [ ] **AnalyticsCards** — 合計投稿数/今週の投稿/平均いいね数 / `feed_posts`
- [ ] **WeeklyBarChart** — 週別投稿数棒グラフ / `feed_posts`
- [ ] **PostTypeBreakdown** — 投稿タイプ別カード（text/image/video） / `feed_posts`
- [ ] **CorrelationTable** — 投稿→次セッション相関テーブル / `feed_posts`

### モーダル
- [ ] **CreatePostModal** — 新規投稿記録（タイプ/キャスト名/内容/メディアURL/日時）

---

## /reports — AIレポート一覧
**ファイル:** `frontend/src/app/reports/page.tsx`

### コンポーネント一覧
- [ ] **AccountSelector** — アカウント切替 / `accounts`
- [ ] **ReportCards** — レポートカード（展開式、Markdown表示、コスト/トークン表示） / `ai_reports`, `sessions`

---

## /admin/command-center — コマンドセンター
**ファイル:** `frontend/src/app/admin/command-center/page.tsx`

- [ ] **無効化済み** — `notFound()` を返す

---

## /admin/health — 品質チェック+同期ヘルス
**ファイル:** `frontend/src/app/admin/health/page.tsx`

### コンポーネント一覧
- [ ] **SummaryBadges** — OK/warn/errorカウントバッジ / `coin_transactions`, `chat_logs`, `dm_send_log`, `spy_viewers`, `user_profiles`
- [ ] **QualityChecks(Accordion)** — 品質チェック結果一覧 / 同上
- [ ] **SyncHealthTable** — Collector同期ヘルステーブル / `RPC:get_sync_health`

---

## /admin/casts — キャスト管理（自社+他社）
**ファイル:** `frontend/src/app/admin/casts/page.tsx`

### タブ構成: 自社キャスト | 他社キャスト

### 自社キャストタブ
- [ ] **StatsCards** — アクティブ/非アクティブ/合計カウント / `registered_casts`
- [ ] **ActiveCastsTable** — 自社キャスト詳細テーブル（インライン編集対応） / `registered_casts`, `cast_cost_settings`

### 他社キャストタブ
- [ ] **QuickAddInput** — SPYキャスト追加入力 / `spy_casts INSERT`
- [ ] **SpyCastsTable** — 他社キャストテーブル（インライン編集対応） / `spy_casts`

### アクション
- [ ] 自社キャスト登録 → `/admin/casts/new`
- [ ] 編集（インライン） → `UPDATE`
- [ ] 無効化/有効化 → `UPDATE is_active`
- [ ] 削除 → `DELETE`

---

## /admin/casts/new — 新規キャスト登録
**ファイル:** `frontend/src/app/admin/casts/new/page.tsx`

### コンポーネント一覧
- [ ] **RegistrationForm** — キャスト名/表示名/プラットフォーム/モデルID/ジャンル/ベンチマーク/カテゴリ/SS間隔/GCレート/収益シェア/メモ / `accounts`, `registered_casts`, `cast_cost_settings`

### アクション
- [ ] キャストを登録 → `registered_casts INSERT` + `cast_cost_settings UPSERT`
- [ ] キャンセル → `/admin/casts` 遷移

---

## /admin/scenarios — DMシナリオ管理
**ファイル:** `frontend/src/app/admin/scenarios/page.tsx`

### タブ構成: シナリオ一覧 | エンロールメント監視

### シナリオ一覧タブ
- [ ] **ScenarioGrid** — シナリオカード一覧（トリガータイプ/ステップ/登録数） / `dm_scenarios`, `dm_scenario_enrollments`

### エンロールメント監視タブ
- [ ] **EnrollmentTable** — ユーザーエンロールメント進捗テーブル（7日停滞ハイライト） / `dm_scenario_enrollments`

### モーダル
- [ ] **ScenarioEditModal** — シナリオ作成/編集（名前/トリガー/セグメント/送信上限/ステップ配列）

### アクション
- [ ] キュー処理実行 → `API:POST /api/scenario/process`
- [ ] 新規シナリオ作成 → `dm_scenarios INSERT`
- [ ] AI文面プレビュー → `API:POST /api/persona`
- [ ] 削除 → `dm_scenarios + dm_scenario_enrollments DELETE`

---

## /admin/test-data — テストデータ管理
**ファイル:** `frontend/src/app/admin/test-data/page.tsx`

### コンポーネント一覧
- [ ] **TableCards** — 対象テーブル別カード（dm_send_log/chat_logs/dm_trigger_logs） / `RPC:count_test_data`

### アクション
- [ ] 全テーブルスキャン → `RPC:count_test_data`
- [ ] テストデータ削除 → `RPC:delete_test_data`

---

## /admin/data-quality — データ品質チェック
**ファイル:** `frontend/src/app/admin/data-quality/page.tsx`

### コンポーネント一覧
- [ ] **SummaryBadges** — OK/warn/errorカウント / `RPC:check_spy_data_quality`
- [ ] **CheckResults(Accordion)** — 品質チェック結果（RPC失敗時はクライアントフォールバック） / `RPC:check_spy_data_quality`, `chat_logs`, `spy_casts`, `registered_casts`, `coin_transactions`

---

## /admin/revenue — 収益シェア計算
**ファイル:** `frontend/src/app/admin/revenue/page.tsx`

### コンポーネント一覧
- [ ] **FilterBar** — キャスト選択/期間指定/計算ボタン/CSV出力 / `registered_casts`
- [ ] **ResultsTable** — 週次分解テーブル（TX数/トークン/Gross/手数料/Net/支払い） / `RPC:calculate_revenue_share`
- [ ] **FormulaDetails** — 4ステップ計算式展開行 / 同上
- [ ] **SummaryCards** — 合計4カード（Gross/PF手数料/Net/Cast支払い） / 同上

### アクション
- [ ] 計算する → `RPC:calculate_revenue_share`
- [ ] CSV出力 → CSVファイルダウンロード

---

## /login — ログイン
**ファイル:** `frontend/src/app/login/page.tsx`

- [ ] **LoginForm** — メール+パスワード入力 / `Supabase Auth:signInWithPassword`

---

## /signup — 新規登録
**ファイル:** `frontend/src/app/signup/page.tsx`

- [ ] **SignupForm** — メール+パスワード+確認入力 / `Supabase Auth:signUp`
- [ ] **ConfirmationMessage** — 確認メール送信完了画面

---

# API エンドポイント一覧

| URL | メソッド | 説明 | テーブル/RPC | 認証 |
|-----|---------|------|-------------|------|
| `/api/ai-report` | POST | Claude APIで配信データの分析レポート生成 | sessions, chat_logs, user_profiles | Bearer JWT |
| `/api/analyze-session` | POST | タイムライン統合・配信構成分類・応援トリガー特定（ルールベース） | chat_logs, cast_transcripts, coin_transactions | service_role |
| `/api/dm/send` | POST | Stripchat APIで単発DM送信（安全ゲート付き） | accounts, stripchat_sessions, registered_casts, dm_send_log, user_profiles, coin_transactions | Cookie session |
| `/api/dm/batch` | POST | バッチDM送信（キャスト身元検証・レート制限） | accounts, stripchat_sessions, registered_casts, dm_send_log | Cookie session |
| `/api/persona` | GET | キャストペルソナデータ取得 | cast_personas | Bearer JWT |
| `/api/persona` | PUT | キャストペルソナのアップサート | cast_personas | Bearer JWT |
| `/api/persona` | POST | DM生成・FBレポート・採用コピー（Phase 1/2/3後方互換） | cast_personas, cast_persona, chat_logs, spy_messages, coin_transactions, user_profiles, dm_send_log | Bearer JWT |
| `/api/persona/engine` | POST | 統一クリエイティブエンジン（DM/X投稿/採用/コンテンツ生成） | cast_personas, cast_persona, persona_feedback | Bearer JWT |
| `/api/persona/feedback` | POST | 生成結果+実績データをpersona_feedbackに記録 | persona_feedback | Bearer JWT |
| `/api/persona/feedback` | GET | フィードバック一覧取得（スコアフィルタ対応） | persona_feedback | Bearer JWT |
| `/api/scenario/goal` | POST | ユーザーイベント→ゴール到達チェック | dm_scenario_enrollments | Bearer JWT |
| `/api/scenario/process` | POST | シナリオキュー処理・期日到来DM登録 | dm_scenario_enrollments, dm_send_log | Bearer JWT |
| `/api/screenshot` | GET | Stripchat CDNサムネイル画像プロキシ | — | 不要 |
| `/api/screenshot` | POST | サムネイル取得→cast_screenshots保存 | cast_screenshots | Bearer JWT |
| `/api/stripchat/test` | GET | Stripchat公開API/セッション接続テスト | accounts, stripchat_sessions | optional |
| `/api/transcribe` | POST | Whisper APIで音声文字起こし→cast_transcripts保存 | accounts, cast_transcripts | Cookie session |
| `/api/data/sessions` | GET | AIエージェント用セッション一覧取得 | sessions | service_role |
| `/api/data/chat-logs` | GET | AIエージェント用チャットログ取得 | chat_logs | service_role |
| `/api/data/cast-profile` | GET | キャストプロフィール取得（fallback付き） | cast_profiles, spy_casts | service_role |
| `/api/data/snapshots` | GET | キャストスナップショット取得 | cast_snapshots | service_role |
| `/api/data/spy-summary` | GET | キャスト集計サマリー（期間別） | sessions, coin_transactions | service_role |
| `/api/data/competitors` | GET | 競合キャスト一覧取得 | competitor_benchmarks | 不要 |
| `/api/analysis/session-report` | POST | Claude APIで配信終了時の自動分析レポート生成 | sessions, chat_logs, coin_transactions, cast_knowledge | service_role |
| `/api/analysis/competitor-diff` | POST | Claude APIで競合差分分析レポート生成 | competitor_benchmarks, sessions, cast_knowledge | service_role |
| `/api/analysis/run-competitor-diff` | POST | クライアント向け競合差分分析プロキシ | 内部で↑を呼び出し | 不要(内部proxy) |
| `/api/analysis/run-session-report` | POST | クライアント向け総合分析レポートプロキシ | 内部で↑を呼び出し | 不要(内部proxy) |
