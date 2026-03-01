# LiveSpot - Premium Agency OS

## プロジェクト概要
ライブ配信エージェンシー（Stripchat）向けSaaS管理プラットフォーム。
旧名 MorningHook（ローカル版 Streamlit + SQLite）を Next.js + Supabase + FastAPI で SaaS 化。

---

## 🤖 Multi-Poller チーム情報

このプロジェクトは **北関東OS Multi-Poller** の自律実行対象チームです。

| 項目 | 値 |
|---|---|
| チーム名 | 💻 SLS |
| Notionプロジェクトフィルタ | `💻 SLS`, `🧠 Persona Agent` |
| CWD | `C:\dev\livespot` |
| タスクボード | collection://48e5a7f8-642b-476b-98b2-2f0f0baba967 |
| task_queue source tag | `notion:{page_id}:sls` |

### ポーラー経由実行時の動作
- `claude.cmd --print --dangerously-skip-permissions` で実行される
- タスクのinstructionはNotionのメモ欄（なければタスク名）
- 完了後: Notion ✅ Done → git push → Telegram通知
- 失敗時: Notion ⏸ Blocked → Telegram通知
- **確認なしで自走する**（--printモード）

### ポーラー経由の安全ルール
- git pushは絶対に実行しない。コミットまで。
- SQLマイグレーションファイルには必ずROLLBACK手順をコメントで含めること。
- SQLマイグレーションはレビュー済みファイルをSupabase SQL Editor API経由で適用してよい。適用前に冪等性・破壊的変更の有無を確認すること。
- 3ファイル以上の変更が必要な場合、まず変更計画を出力して実行しない。
- .envファイルは読み取りのみ。編集禁止。
- RPCの引数を変える場合、呼び出し元のフロントエンドもセットで修正すること。

---

## ワークフローのオーケストレーション

### 0. 運用ルール
- すべて日本語で回答する
- 技術用語は使わない（使う場合は必ず言い換えを先に置く）
- 作業はゴールまで自走する。途中で止まるな
- エラーに遭遇したら、自分で原因を特定して直す
- YUUTAに手動作業をさせない
- ポーラー経由（--printモード）の場合は確認なしで自走する

### 1. Planノード（デフォルト）
- 3ステップ以上の作業はまず計画を立てる
- おかしくなったらすぐに止まって再計画（押し切らない）
- plan モードは「作る」だけでなく「確かめる手順」にも使う
- 曖昧さを減らすため、最初に詳細な仕様を書く

### 2. サブエージェント戦略（役割分担）
- 調査・探索・並列作業は別の担当に任せる
- 複雑な問題は担当を増やして同時に進める
- 1担当につき1タスク（同時に抱えない）

### 3. 自己改善ループ
- 修正が入ったらその学びを tasks/lessons.md に記録
- 同じミスを防ぐためのルールを書く
- セッション開始時に関係する学びを見直す

### 4. 完了前の検証
- 動くことを証明するまで完了扱いにしない
- npm run build 成功が完了の最低条件
- 自問: 「経験豊富な人が見てもOKと言えるか？」

### 5. エレガンス要求
- 手順が多い変更では立ち止まり、もっとスッキリした方法はないか問う
- 修正が無理やり感あるなら、自然な解決にする
- 単純で明らかな修正は深追いしない（やりすぎない）
- 提出前に自分で厳しく見直す

### 6. 自律的バグ修正
- バグ報告を受けたらそのまま直しに行く（手取り足取りを求めない）
- 「どこが変/何が起きているか」を示し、その上で解決する
- YUUTAに余計な切り替え作業を要求しない
- 指示されなくても、失敗している自動チェックを直しに行く

### 7. コア原則
- シンプル最優先: 最小限の手数で最大効果
- 怠けない: 根本原因を見つける。一時しのぎ禁止
- 最小影響: 必要な箇所だけ触る。新しい問題を持ち込まない

### 8. 安全ルール
- 既存ファイルの上書き前にバックアップを作成（.bak）
- 削除系コマンドは原則実行しない（settings.local.jsonで物理ブロック済み）
- パッケージ追加前に何を・なぜ・どこにを説明
- 不明なコマンドは実行前に日本語で説明
- vercel.jsonを作成・変更・削除しないこと。VercelはRoot Directory=frontendでダッシュボード管理

### 9. DB絶対ルール（SLS固有）
- paid_usersのクエリにはcast_name条件必須
- coin_transactionsは tokensカラムで集計（amountは使うな）
- 2025-02-15以降のデータのみ使用
- 「課金」→「応援」表記統一

### 10. タスク管理
1. まず計画: チェックできる項目で plan を tasks/todo.md に書く
2. 計画の確認: 実装を始める前にチェックイン
3. 進捗の追跡: 進めながら項目を完了にしていく
4. 変更の説明: 各ステップで高レベルの要約を書く
5. 結果の文書化: tasks/todo.md にレビューセクションを追加
6. 学びの記録: 修正が入った後に tasks/lessons.md を更新

### 11. ポーラー経由の安全ルール
- git pushは絶対に実行しない。コミットまで。
- SQLマイグレーションファイルには必ずROLLBACK手順をコメントで含めること。
- SQLマイグレーションはレビュー済みファイルをSupabase SQL Editor API経由で適用してよい。適用前に冪等性・破壊的変更の有無を確認すること。
- 3ファイル以上の変更が必要な場合、まず変更計画を出力して実行しない。
- .envファイルは読み取りのみ。編集禁止。
- RPCの引数を変える場合、呼び出し元のフロントエンドもセットで修正すること。

### 12. タスク完了時の記録義務
- タスク完了時、成果レポートをNotionタスクページの本文に必ず記録すること
- Telegram通知だけでは不可。Notionが正式な記録先
- 調査タスク: 発見事項・原因・修正方針を記録
- 修正タスク: 変更ファイル一覧・変更内容・ビルド結果を記録

### 13. タスク実行ルール
- タスクの完了条件は「実装が完了し、ビルド成功したこと」である
- 調査結果の報告だけでDoneにしない
- 実装が不可能な場合はBlockedにして理由をブロック理由欄に記載
- 「何を進めますか？」とYUUTAに聴かない。メモ欄の指示に従って実装までやり切る
- メモ欄に完了条件がない場合は、タスク名から判断して実装まで行う

---

## 技術スタック
| レイヤー | 技術 | パス |
|---|---|---|
| Frontend | Next.js 14 (App Router) + Tailwind CSS 3 | `C:\dev\livespot\frontend` |
| Backend | FastAPI + Uvicorn | `C:\dev\livespot\backend` |
| DB | PostgreSQL (Supabase) | `C:\dev\livespot\supabase` |
| Chrome拡張 | Manifest V3 | `C:\dev\livespot\chrome-extension` |
| デザイン | Ultra-Dark Glassmorphism | globals.css |

---

## プロジェクト構造

### frontend/src/
```
app/
  layout.tsx          # RootLayout — AuthProvider + AppShell を組み込み
  globals.css         # デザインシステム全体（glass-card, btn-*, bg-mesh 等）
  page.tsx            # / — コントロールセンター（ダッシュボード）
  login/page.tsx      # /login — メール+パスワードログイン
  signup/page.tsx     # /signup — 新規登録 + 確認メール画面
  casts/page.tsx      # /casts — キャスト一覧（RPC集計、登録管理）
  casts/[castName]/page.tsx  # /casts/[castName] — キャスト個別（タブ: 概要/配信/DM/分析/売上/リアルタイム）
  spy/page.tsx        # /spy — リアルタイムSPYログ（Realtime購読）
  spy/[castName]/page.tsx    # /spy/[castName] — キャスト別SPYログ
  spy/users/[username]/page.tsx  # /spy/users/[username] — ユーザー別SPYログ
  dm/page.tsx         # /dm — DM一斉送信（API連携 + Realtime購読）
  alerts/page.tsx     # /alerts — VIP入室アラート
  analytics/page.tsx  # /analytics — 売上分析・給与計算
  analytics/compare/page.tsx  # /analytics/compare — キャスト横並び比較
  sessions/page.tsx   # /sessions — 配信セッション一覧
  users/page.tsx      # /users — ユーザー一覧（paid_users）
  users/[username]/page.tsx  # /users/[username] — ユーザー詳細
  reports/page.tsx    # /reports — AIレポート
  feed/page.tsx       # /feed — フィード
  settings/page.tsx   # /settings — セキュリティ・レート制限設定
  casts/[castName]/sessions/[sessionId]/page.tsx  # セッション詳細（配信前/中/後3モード）
  spy/analysis/page.tsx  # SPY分析
  admin/command-center/page.tsx  # /admin/command-center — Wisteria コマンドセンター（4タブ: コマンド/戦略/オペレーション/アセット）
  admin/health/page.tsx  # /admin/health — 品質チェックダッシュボード（5項目ワンクリック）
  api/transcribe/route.ts  # POST Whisper API文字起こし
  api/screenshot/route.ts  # GET Stripchat CDNプロキシ+DB保存
  api/analyze-session/route.ts  # POST 配信AI分析（ルールベース）
  api/persona/route.ts  # GET/POST/PUT ペルソナCRUD+DM生成
  api/dm/send/route.ts  # POST DM送信（サーバーサイド）
  api/dm/batch/route.ts  # POST DM一括送信
  api/ai-report/route.ts  # POST AIレポート生成
  api/stripchat/test/route.ts  # GET Stripchat API接続テスト
components/
  auth-provider.tsx   # AuthContext (user, session, loading, signOut) + リダイレクト制御
  app-shell.tsx       # publicページ判定、サイドバー表示/非表示、ローディングスピナー
  sidebar.tsx         # 左220px固定ナビ、キャストサブメニュー、user.email表示
  chat-message.tsx    # SPYメッセージ1行表示（msg_type別色分け、VIPハイライト）
  vip-alert-card.tsx  # VIPアラートカード
hooks/
  use-realtime-spy.ts # spy_messages Realtime購読、初回50件ロード、デモデータ挿入
  use-dm-queue.ts     # dm_send_log Realtime購読（ステータス監視）
lib/
  supabase/client.ts  # createBrowserClient (@supabase/ssr)
  api.ts              # 認証付きfetch wrapper (Bearer token自動付与)
  api-auth.ts         # API Route認証ユーティリティ（JWT検証+account_id検証+レート制限）
  dm-sender.ts        # DM送信キュー汎用ユーティリティ（RPC+フォールバックINSERT）
  scenario-engine.ts  # DMシナリオエンジン（ステップ進行+ゴール検出+AI文面生成）
  stripchat-api.ts    # Stripchat API統合クライアント（モデル情報/視聴者/DM送信/サムネイル）
  cvr-calculator.ts   # CVR計算ユーティリティ
  realtime-helpers.ts # Realtime購読ヘルパー
  stripchat-levels.ts # Stripchatレベル判定
  ticket-show-detector.ts  # チケットショー検出
  utils.ts            # cn(), formatTokens(), tokensToJPY(), formatJST(), timeAgo(), COIN_RATE
types/
  index.ts            # 全TypeScript型定義
```

### frontend/ ルート設定ファイル
```
.env.local            # NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_BASE_URL
next.config.js        # Next.js設定
tailwind.config.js    # Tailwind CSS v3 設定
tsconfig.json         # TypeScript設定
postcss.config.js     # PostCSS設定
package.json          # morninghook-frontend@1.0.0
```

### backend/
```
main.py               # FastAPIアプリ本体、CORS設定、7ルーター登録、/health エンドポイント
config.py             # Settings (pydantic-settings)、get_supabase_admin()、get_supabase_for_user()
requirements.txt      # fastapi, uvicorn, supabase, PyJWT, anthropic, pydantic-settings 等
.env                  # SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_JWT_SECRET, ANTHROPIC_API_KEY 等
Dockerfile            # コンテナビルド用
routers/
  auth.py             # JWT検証 get_current_user(), /me, /accounts CRUD
  dm.py               # DM一斉送信キュー, バッチステータス, 履歴, テンプレート, 効果測定
  spy.py              # チャットメッセージ受信/検索, VIPアラート, コメントピックアップ
  sync.py             # CSV/JSON インポート, 同期ステータス
  analytics.py        # 日別売上, 累計, ランキング, 収入源, ARPU, LTV, リテンション
  ai.py               # Claude AIライブアシスト, デイリーレポート生成
  scripts.py          # 配信台本 CRUD
models/
  schemas.py          # 全Pydanticモデル定義
services/
  llm_engine.py       # Claude Sonnet 4 API呼び出し（ライブアシスト/デイリーレポート）
  vip_checker.py      # VIP検出（1000+tk=whale, Lv70+=high_level）、ライフサイクル分類
```

### chrome-extension/
```
manifest.json         # Manifest V3, name: "Morning Hook - Stripchat Manager" v2.0.0
background.js         # Service Worker — API中継、DMキューポーリング(10秒間隔)
```
※ content_scripts (ws_interceptor.js, ws_relay.js, dm_executor.js) と popup.html は manifest に定義されているが、ファイルは未作成

### supabase/
```
migrations/
  001_initial_schema.sql      # 全テーブル、RLS、Realtime、ヘルパー関数
  002_analytics_functions.sql  # 8 RPC関数（売上分析・ARPU・リテンション等）
  003_add_sessions_viewerstats.sql  # sessions + viewer_stats テーブル
  003_refresh_mv_and_user_summary_rpc.sql  # MVリフレッシュ + ユーザーサマリーRPC
  004_registered_casts.sql    # registered_casts テーブル
  005_cast_stats_rpc.sql      # get_cast_stats RPC
  006_analytics_rpc.sql       # 追加分析RPC（retention, campaign effectiveness, segments）
  007_dm_send_log_cast_name.sql  # dm_send_log に cast_name カラム追加
  008_spy_casts.sql           # spy_casts テーブル
  009_coin_schema_update.sql  # コインスキーマ更新
  010_user_segments_rpc.sql   # get_user_segments RPC
  012_dm_schedules.sql        # dm_schedules テーブル + RLS + Realtime
  013_detect_new_paying_users.sql  # detect_new_paying_users RPC
  014_alert_rules.sql         # alert_rules テーブル + RLS
  015_user_acquisition_dashboard.sql  # get_user_acquisition_dashboard RPC
  016_dashboard_improvements.sql  # dashboard v2 (p_max_coins) + search_user_detail
  017_search_users_bulk.sql   # search_users_bulk RPC（完全一致 + 該当なし対応）
  018_dm_campaign_cvr.sql     # DMキャンペーンCVR計算
  018_get_cast_paid_users.sql # キャスト別課金ユーザーRPC
  019_coin_tx_cast_name_and_reassign.sql  # coin_transactions cast_name再割当
  020_check_data_integrity.sql  # check_data_integrity RPC（16項目データ整合性チェック）
  021_fix_dm_send_log_cast_name.sql  # dm_send_log cast_name NULL修正（2,309行バックフィル）
  022_dedup_coin_transactions.sql  # coin_transactions重複削除 + ユニークインデックス
  023_pipeline_status.sql     # pipeline_status テーブル + 自動検出RPC（update_pipeline_auto_status）
  024_coin_tx_tokens_positive_check.sql  # coin_transactions tokens正値チェック
  025_competitive_analysis_rpc.sql  # 他社SPY分析RPC
  026_thankyou_dm_and_churn.sql  # お礼DM + 離脱防止RPC
  027_spy_user_color.sql      # SPYユーザーカラー設定
  028_spy_user_league_level.sql  # SPYユーザーリーグ・レベル
  029_viewer_stats_breakdown.sql  # 視聴者統計内訳
  030_cast_tags.sql           # キャストタグ管理
  031_session_broadcast_title.sql  # セッション配信タイトル
  032_cast_profiles_feeds_survival.sql  # キャストプロフィール・フィード・生存率
  033_ticket_show_analysis.sql  # チケットショー分析
  034_screenshots.sql         # スクリーンショットテーブル
  035_cast_types.sql          # キャスト種別
  035_screenshots_thumbnail_url.sql  # スクリーンショットサムネイルURL追加
  036_coin_sync_status_rpc.sql  # コイン同期ステータスRPC
  037_screenshot_interval.sql  # スクリーンショット間隔設定
  038_refresh_segments.sql    # セグメントリフレッシュ
  039_cast_persona.sql        # キャストペルソナ（初期版）
  040_gc_rate_per_minute.sql  # GCレート（分単位）
  041_dm_scenarios.sql        # DMシナリオテーブル
  042_dm_send_log_ai_columns.sql  # dm_send_log AI関連カラム追加
  043_stripchat_sessions.sql  # Stripchatセッション同期テーブル
  044_spy_viewers.sql         # spy_viewers テーブル（視聴者リアルタイム取得）
  045_create_dm_batch_rpc.sql  # create_dm_batch RPC（プラン上限チェック+一括INSERT）
  046_spy_messages_bigint.sql  # spy_messages ID bigint化
  047_get_new_users_by_session.sql  # セッション別新規ユーザーRPC
  048_get_session_revenue_breakdown.sql  # セッション売上内訳RPC
  049_get_session_list_and_summary.sql  # セッション一覧+サマリーRPC
  050_fix_session_rpcs.sql    # セッションRPC修正
  051_get_session_actions.sql  # 配信後アクションRPC
  052_cast_transcripts.sql    # 文字起こしテーブル
  053_session_merge_and_coin_match.sql  # セッション統合+コイン突合
  054_cast_screenshots.sql    # キャストスクリーンショット管理
  055_transcript_timeline.sql  # 時刻突合タイムラインRPC（文字起こし+チャット+課金）
  056_cast_personas.sql       # cast_personas テーブル + デフォルトデータ（Phase 3）
  057_dm_scenarios_v2.sql     # DMシナリオv2（steps+enrollments+初期3件）
  058_spy_market_analysis.sql  # 他社SPYマーケット分析RPC 3関数
  059_fix_dm_batch_cast_name.sql  # create_dm_batch RPC cast_name パラメータ追加
  064_dm_triggers.sql           # DMトリガーエンジン（dm_triggers + dm_trigger_logs + デフォルト7件）
  065_spy_analysis_rpcs.sql      # SPY集計・トレンド分析RPC 5関数（配信/課金パターン/成長曲線/ゴール/マーケットトレンド）
  098_v2_schema.sql              # SLS v2 新テーブル（chat_logs + viewer_snapshots + user_profiles）+ sessions補強
```

---

## Supabase設定

- **Project ID**: ujgbhkllfeacbgpdbjto
- **Region**: ap-northeast-1 (東京)
- **URL**: https://ujgbhkllfeacbgpdbjto.supabase.co
- **Auth**: メール + パスワード認証
- **Realtime**: spy_messages, dm_send_log が有効
- **RLS**: 全テーブルに有効（`user_account_ids()` 関数でアカウントスコープ）

### テーブル一覧

| テーブル | 主キー | 説明 |
|---|---|---|
| profiles | id (UUID, FK→auth.users) | ユーザープロフィール、プラン、使用量カウンター |
| accounts | id (UUID) | Stripchatアカウント（user_id + account_name でUNIQUE） |
| paid_users | id (UUID) | ユーザー別累計課金情報 |
| coin_transactions | id (BIGSERIAL) | 個別課金トランザクション |
| paying_users | — (MATERIALIZED VIEW) | coin_transactions の集計ビュー |
| dm_send_log | id (BIGSERIAL) | DM送信キュー・履歴（cast_name付き） |
| dm_templates | id (UUID) | DMテンプレート |
| dm_schedules | id (UUID) | DM予約送信スケジュール |
| spy_messages | id (BIGSERIAL) | チャットログ（リアルタイム監視） |
| sessions | session_id (UUID) | 配信セッション記録 |
| viewer_stats | id (BIGSERIAL) | 視聴者統計 |
| registered_casts | id (UUID) | 登録キャスト管理 |
| alert_rules | id (UUID) | ポップアラートルール（5種類） |
| broadcast_scripts | id (UUID) | 配信台本 |
| ai_reports | id (UUID) | AI生成レポート |
| audio_recordings | id (UUID) | 音声録音 |
| pipeline_status | id (SERIAL) | パイプライン稼働状態（10プロセス、自動検出RPC連携） |
| cast_transcripts | id (UUID) | 文字起こしセグメント（Whisper API結果） |
| cast_screenshots | id (UUID) | キャストスクリーンショット（CDNプロキシ） |
| cast_personas | id (UUID) | キャストペルソナ設定（System Prompt 3層） |
| dm_scenarios | id (UUID) | DMシナリオ定義（お礼/離脱防止/復帰等） |
| dm_scenario_steps | id (UUID) | シナリオ内ステップ定義 |
| dm_scenario_enrollments | id (UUID) | ユーザーのシナリオ進行状態 |
| spy_viewers | id (UUID) | 視聴者リアルタイム取得結果 |
| stripchat_sessions | id (UUID) | Stripchatセッション同期 |
| dm_triggers | id (UUID) | DM自動トリガー定義（7種） |
| dm_trigger_logs | id (BIGSERIAL) | トリガー発火ログ（クールダウン管理） |
| chat_logs | id (BIGSERIAL) | v2チャットログ（session_id UUID FK、Realtime有効） |
| viewer_snapshots | id (BIGSERIAL) | v2視聴者スナップショット（viewers JSONB） |
| user_profiles | id (UUID) | v2ユーザープロフィール（UNIQUE(account_id, cast_name, username)） |

### spy_messages カラム
```
id BIGSERIAL PK, account_id UUID FK, cast_name TEXT, message_time TIMESTAMPTZ,
msg_type TEXT, user_name TEXT, message TEXT, tokens INTEGER DEFAULT 0,
is_vip BOOLEAN DEFAULT false, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ
```

### dm_send_log カラム
```
id BIGSERIAL PK, account_id UUID FK, user_name TEXT, profile_url TEXT,
message TEXT, image_sent BOOLEAN, status TEXT ('success'|'error'|'pending'|'queued'|'sending'),
error TEXT, sent_at TIMESTAMPTZ, queued_at TIMESTAMPTZ, campaign TEXT, template_name TEXT,
created_at TIMESTAMPTZ
```

### accounts カラム
```
id UUID PK, user_id UUID FK, account_name TEXT, stripchat_cookie_encrypted TEXT,
is_active BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
UNIQUE(user_id, account_name)
```

### profiles カラム
```
id UUID PK FK→auth.users, display_name TEXT, plan TEXT, stripe_customer_id TEXT,
stripe_subscription_id TEXT, max_casts INTEGER, max_dm_per_month INTEGER,
max_ai_per_month INTEGER, dm_used_this_month INTEGER, ai_used_this_month INTEGER,
created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
```

### RPC関数（002_analytics_functions.sql）
| 関数 | 引数 | 説明 |
|---|---|---|
| daily_sales | (account_id, since) | 日別売上集計 |
| revenue_breakdown | (account_id, since) | 収入源内訳（タイプ別） |
| hourly_revenue | (account_id, since) | 時間帯別売上（JST変換） |
| arpu_trend | (account_id) | 月別ARPU推移 |
| retention_cohort | (account_id) | リテンション（最終支払月別コホート） |
| revenue_trend | (account_id) | 月別×タイプ別収入源推移 |
| top_users_detail | (account_id, limit) | 太客詳細（累計tk, 初回/最終支払, 活動月数, 主要収入源） |
| dm_effectiveness | (account_id, window_days) | DM効果測定（送信後N日以内の再課金率） |

### RPC関数（追加分 006〜017）
| 関数 | 引数 | 説明 |
|---|---|---|
| get_cast_stats | (account_id, cast_names[]) | キャスト別集計（メッセージ/チップ/コイン/ユニークユーザー） |
| get_user_retention_status | (account_id, cast_name) | ユーザーリテンションステータス |
| get_dm_campaign_effectiveness | (account_id, cast_name, window_days) | DMキャンペーン効果（来訪率/課金率/売上貢献） |
| get_user_segments | (account_id, cast_name) | 10セグメント分類（コイン×最終課金日2軸） |
| detect_new_paying_users | (account_id, cast_name, since) | 新規課金ユーザー検出 |
| get_user_acquisition_dashboard | (account_id, cast_name, days, min_coins, max_coins) | ユーザー獲得ダッシュボード（DM効果+セグメント） |
| search_users_bulk | (account_id, cast_name, user_names[]) | 複数ユーザー一括検索（完全一致+該当なし対応） |
| check_data_integrity | (p_valid_since) | 16項目データ整合性チェック（JSONB返却） |
| update_pipeline_auto_status | () | SPY/コイン同期/DM最新タイムスタンプから pipeline_status 自動更新 |
| update_pipeline_timestamp | () | pipeline_status updated_at 自動更新トリガー関数 |

### RPC関数（追加分 024〜059）
| 関数 | 引数 | 説明 |
|---|---|---|
| get_cast_paid_users | (account_id, cast_name) | キャスト別課金ユーザー一覧 |
| create_dm_batch | (account_id, cast_name, targets[], message, template_name) | DM一括キュー登録（プラン上限チェック付き） |
| get_new_users_by_session | (account_id, cast_name, session_id) | セッション別新規課金ユーザー |
| get_session_revenue_breakdown | (account_id, session_id) | セッション売上内訳（タイプ別） |
| get_session_list | (account_id, cast_name, limit) | セッション一覧（spy_messages GROUP BY） |
| get_session_summary | (account_id, cast_name, session_id) | セッション詳細サマリー |
| get_session_list_v2 | (account_id, cast_name, limit) | セッション一覧v2（統合+コイン突合） |
| get_session_summary_v2 | (account_id, cast_name, session_id) | セッション詳細v2（コイン突合付き） |
| get_session_actions | (account_id, cast_name, session_id) | 配信後アクション（初課金/高額/来訪無アクション/DM未来訪） |
| get_transcript_timeline | (account_id, session_id) | 時刻突合タイムライン（文字起こし+チャット+課金統合） |
| get_spy_market_now | (account_id, days) | 他社SPY現在時刻のマーケット概況 |
| get_spy_viewer_trends | (account_id, days) | 他社SPY視聴者トレンド（時間×キャスト） |
| get_spy_revenue_types | (account_id, days) | 他社SPY収入タイプ分布 |
| get_spy_cast_schedule_pattern | (account_id, cast_name?, days) | 配信パターン分析（曜日×時間帯の配信頻度・売上） |
| get_user_payment_pattern | (account_id, cast_name?, days) | 課金パターン分析（金額帯・リピート率・時間帯） |
| get_cast_growth_curve | (account_id, cast_name?, days) | 成長曲線（日次KPIトレンド＋7日移動平均） |
| get_goal_achievement_analysis | (account_id, cast_name?, days) | ゴール達成分析（頻度・金額・時間帯） |
| get_market_trend | (account_id, days) | マーケットトレンド（自社vs他社の日次シェア推移） |

### ヘルパー関数（001_initial_schema.sql）
| 関数 | 説明 |
|---|---|
| user_account_ids() | 現在ユーザーの全account_idを返す（RLSで使用） |
| handle_new_user() | auth.users INSERT時に profiles を自動作成（トリガー） |
| refresh_paying_users() | paying_users マテビューをリフレッシュ |
| reset_monthly_usage() | 月次使用量リセット（dm_used, ai_used → 0） |

---

## 認証フロー

### フロントエンド
```
AuthProvider (onAuthStateChange監視)
  → 未ログイン + protectedページ → /login にリダイレクト
  → ログイン済み + /login or /signup → / にリダイレクト
  └→ AppShell
       → publicページ (/login, /signup): サイドバーなし
       → protectedページ: Sidebar + main コンテンツ
```

### バックエンド JWT検証
- `backend/routers/auth.py` の `get_current_user()`
- Authorization: Bearer \<supabase_access_token\>
- PyJWT で HS256 検証、audience="authenticated"
- JWT の `sub` クレームから user_id を取得
- 全エンドポイントが `Depends(get_current_user)` で保護

### テストユーザー
- メール: admin@livespot.jp

---

## API設計（Backend FastAPI）

全エンドポイントは `Authorization: Bearer <supabase_access_token>` が必要。

### AUTH `/api/auth`
| Method | Path | 説明 |
|---|---|---|
| GET | /me | ユーザープロフィール取得 |
| GET | /accounts | アカウント一覧 |
| POST | /accounts | アカウント作成（プラン上限チェック） |
| DELETE | /accounts/{account_id} | アカウント削除 |

### DM `/api/dm`
| Method | Path | 説明 |
|---|---|---|
| POST | /queue | DM一斉送信キュー登録（batch_id生成） |
| GET | /status/{batch_id} | バッチ送信ステータス |
| GET | /history | 直近送信履歴 |
| GET | /queue?account_id=&status= | Chrome拡張ポーリング用 |
| PUT | /queue/{dm_id}/status | Chrome拡張からステータス報告 |
| GET | /log?account_id= | 送信ログ検索 |
| GET | /effectiveness?account_id= | DM効果測定（RPC） |
| GET | /templates?account_id= | テンプレート一覧 |
| POST | /templates | テンプレート作成 |
| DELETE | /templates/{template_id} | テンプレート削除 |

### SPY `/api/spy`
| Method | Path | 説明 |
|---|---|---|
| POST | /messages | メッセージ受信（Chrome拡張→API、VIPチェック付き） |
| POST | /messages/batch | バッチインポート |
| GET | /messages?account_id= | メッセージ検索（cast/type/VIP/時間フィルタ） |
| GET | /vip-alerts?account_id= | VIPアラート一覧（重複排除） |
| GET | /pickup?account_id=&cast_name= | コメントピックアップ（whale/gift/question） |

### SYNC `/api/sync`
| Method | Path | 説明 |
|---|---|---|
| POST | /csv | CSVインポート（paid_users） |
| POST | /coin-transactions | トランザクションJSON受信 |
| GET | /status?account_id= | 同期ステータス |

### ANALYTICS `/api/analytics`
| Method | Path | 説明 |
|---|---|---|
| GET | /sales/daily | 日別売上 |
| GET | /sales/cumulative | 累計売上 |
| GET | /users/ranking | ユーザーランキング |
| GET | /revenue/breakdown | 収入源内訳 |
| GET | /revenue/hourly | 時間帯分析 |
| GET | /funnel/arpu | ARPU推移 |
| GET | /funnel/ltv | LTV分布 |
| GET | /funnel/retention | リテンションコホート |
| GET | /funnel/revenue-trend | 月別収入源推移 |
| GET | /funnel/top-users | 太客詳細 |
| GET | /dm-effectiveness | DM効果測定 |

### AI `/api/ai`
| Method | Path | 説明 |
|---|---|---|
| POST | /live-assist | ライブ配信AIアシスト（Claude Sonnet 4） |
| POST | /daily-report | デイリーレポート生成 |
| GET | /reports?account_id= | レポート履歴 |

### SCRIPTS `/api/scripts`
| Method | Path | 説明 |
|---|---|---|
| GET | /?account_id= | 配信台本一覧 |
| POST | / | 台本作成 |
| PUT | /{script_id} | 台本更新 |
| DELETE | /{script_id} | 台本削除 |

### Next.js API Routes（フロントエンド内サーバーサイド）
| Method | Path | 説明 |
|---|---|---|
| POST | /api/transcribe | Whisper API文字起こし（FormData: audio, session_id, cast_name, account_id） |
| GET | /api/screenshot | Stripchat CDNプロキシ + cast_screenshots DB保存 |
| POST | /api/analyze-session | 配信AI分析（ルールベース Phase 1） |
| GET/POST/PUT | /api/persona | ペルソナCRUD + DM文面生成（cast_personas連携） |
| POST | /api/dm/send | DM送信（サーバーサイド） |
| POST | /api/dm/batch | DM一括送信（認証cookie-based） |
| POST | /api/ai-report | AIレポート生成 |
| GET | /api/stripchat/test | Stripchat API接続テスト（認証不要） |

---

## フロントエンド ページ状態

| パス | ファイル | 状態 |
|---|---|---|
| /login | app/login/page.tsx | 実装済み（Supabase Auth signInWithPassword） |
| /signup | app/signup/page.tsx | 実装済み（Supabase Auth signUp + 確認メール） |
| / | app/page.tsx | 実装済み（ダッシュボード） |
| /casts | app/casts/page.tsx | 実装済み（キャスト一覧、RPC集計、登録管理） |
| /casts/[castName] | app/casts/[castName]/page.tsx | 実装済み（6タブ: 概要/配信/DM/分析/売上/リアルタイム） |
| /spy | app/spy/page.tsx | 実装済み（Realtime購読） |
| /spy/[castName] | app/spy/[castName]/page.tsx | 実装済み（キャスト別SPY） |
| /spy/users/[username] | app/spy/users/[username]/page.tsx | 実装済み（ユーザー別SPY） |
| /dm | app/dm/page.tsx | 実装済み（API連携、Realtime購読、ステータス表示） |
| /alerts | app/alerts/page.tsx | 実装済み（アラートルール管理） |
| /analytics | app/analytics/page.tsx | 実装済み（売上分析・給与計算） |
| /analytics/compare | app/analytics/compare/page.tsx | 実装済み（キャスト横並び比較） |
| /sessions | app/sessions/page.tsx | 実装済み（配信セッション一覧） |
| /users | app/users/page.tsx | 実装済み（ユーザー一覧） |
| /users/[username] | app/users/[username]/page.tsx | 実装済み（ユーザー詳細） |
| /reports | app/reports/page.tsx | 実装済み（AIレポート） |
| /feed | app/feed/page.tsx | 実装済み（フィード） |
| /settings | app/settings/page.tsx | 実装済み（セキュリティ・設定） |
| /casts/[castName]/sessions/[sessionId] | app/casts/[castName]/sessions/[sessionId]/page.tsx | 実装済み（配信前/中/後3モード、DM送信接続、マーケット分析） |
| /admin/command-center | app/admin/command-center/page.tsx | 実装済み（Wisteria 4タブ、pipeline_status連携、60sポーリング） |
| /admin/health | app/admin/health/page.tsx | 実装済み（5項目品質チェック） |

---

## 環境変数

### frontend/.env.local
```
NEXT_PUBLIC_SUPABASE_URL=https://ujgbhkllfeacbgpdbjto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...（サービスロールキー、API Routes用）
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
OPENAI_API_KEY=sk-...（Whisper API文字起こし用）
```

### backend/.env
```
SUPABASE_URL=https://ujgbhkllfeacbgpdbjto.supabase.co
SUPABASE_SERVICE_KEY=sb_secre...（サービスロールキー）
SUPABASE_JWT_SECRET=itDaTWP5...（JWT検証用）
ANTHROPIC_API_KEY=sk-ant-a...
API_BASE_URL=http://localhost:8000
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
```

---

## 起動手順

### Terminal 1: Backend
```bash
cd C:\dev\livespot\backend
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

### Terminal 2: Frontend
```bash
cd C:\dev\livespot\frontend
npm install
npm run dev
```
→ http://localhost:3000 (または3001)

### Terminal 3: Claude Code
```bash
cd C:\dev\livespot
claude
```

---

## デザインシステム

### テーマ: Ultra-Dark Glassmorphism
- フォント: Outfit (本文) + JetBrains Mono (コード)
- 背景: `bg-mesh` (3色radial-gradient + #030712)
- カード: 半透明 + backdrop-blur-xl + 微細ボーダー

### CSS変数（:root）
```
--bg-deep: #030712          --bg-surface: #0a0f1e
--bg-card: rgba(15,23,42,0.6)  --bg-card-hover: rgba(20,30,55,0.8)
--bg-glass: rgba(15,25,50,0.4) --border-glass: rgba(56,189,248,0.08)
--border-glow: rgba(56,189,248,0.2)
--accent-primary: #38bdf8 (sky)    --accent-green: #22c55e
--accent-pink: #f43f5e             --accent-amber: #f59e0b
--accent-purple: #a78bfa
--text-primary: #f1f5f9   --text-secondary: #94a3b8   --text-muted: #475569
--glow-blue/green/pink: box-shadow用
```

### カスタムCSSクラス（globals.css @layer components）
| クラス | 説明 |
|---|---|
| glass-card | メインカード（半透明bg + backdrop-blur-xl + border） |
| glass-card-hover | glass-card + ホバーエフェクト（浮き上がり + グロー） |
| glass-panel | 小型コンテナ（カード内のネスト用） |
| input-glass | テキスト入力フィールド（フォーカス時 sky グロー） |
| btn-primary | sky-blue グラデーションボタン |
| btn-danger | rose グラデーションボタン |
| btn-ghost | アウトラインボタン |
| btn-go-live | green グラデーション + パルスアニメーション |
| badge / badge-live / badge-critical / badge-warning / badge-info / badge-premium | ステータスバッジ |
| bg-mesh | 3色楕円グラデーション背景 |
| anim-fade-up / anim-fade / anim-slide-left / anim-pulse-glow / anim-live | アニメーション |
| delay-1〜4 | アニメーション遅延 |

---

## ローカル版 MorningHook との対応関係

### ページマッピング
| 旧 Streamlit | 新 Next.js | パス |
|---|---|---|
| コントロールパネル | コントロールセンター | / |
| リアルタイム監視 | リアルタイム運営 (SPY) | /spy |
| VIPアラート | 入室アラート | /alerts |
| DM一斉送信 | DM一斉送信 | /dm |
| 売上分析 | 分析&スコアリング | /analytics |
| 設定 | 管理&セキュリティ | /settings |
| — (新規) | ログイン / 新規登録 | /login, /signup |

### DBマッピング
| 旧 SQLite | 新 Supabase PostgreSQL |
|---|---|
| paid_users | paid_users + coin_transactions |
| dm_log | dm_send_log |
| chat_log | spy_messages |
| settings | profiles + accounts |
| — | dm_templates, broadcast_scripts, ai_reports, audio_recordings |

---

## 開発ルール

- **日本語UI**: ラベル・プレースホルダー・コメント全て日本語OK
- **Tailwind CSS v3**: v4ではない（`@layer components` 使用）
- **@supabase/ssr**: `createBrowserClient` を使用（`@supabase/auth-helpers-nextjs` ではない）
- **PowerShell注意**: `pip` → `python -m pip`、`uvicorn` → `python -m uvicorn`
- **OneDrive回避**: プロジェクトは `C:\dev\livespot` に配置済み（OneDriveのDocuments外）
- **Supabase Admin**: バックエンドは service_key（RLSバイパス）、フロントエンドは anon_key（RLS適用）
- **Realtime**: フロントエンドで `supabase.channel().on('postgres_changes', ...)` でリアルタイム購読
- **API呼び出し**: `lib/api.ts` の `apiGet/apiPost/apiPut/apiDelete` を使用（Bearer token自動付与）

---

## 設計原則

1. **気づいた瞬間に行動できる導線** — 分析画面にアクションボタン直結（例: ランキング→DM送信、チャット→ウィスパー）
2. **全データを user_timeline に集約** — 課金・DM・入室・チャット・ギフトを1ユーザーの時系列で串刺し
3. **リアルタイムと蓄積を常に接続** — VIP入室時に paid_users をルックアップして累計消費額を即表示
4. **すべてのアクションにログを残す** — campaign タグ、template_name でDM効果を後追い測定可能に
5. **義理と人情を仕組み化する** — お礼DM自動送信、誕生日・記念日リマインダー等

---

## 連動の穴（35項目の対応状況）

### SaaS化で自動解決（5個）
- #9 マルチユーザー対応 → Supabase Auth + RLS
- #18 データバックアップ → Supabase自動バックアップ
- #19 アクセス制御 → JWT認証 + アカウントスコープ
- #28 同時アクセス問題 → PostgreSQL + Realtime
- #30 デプロイ問題 → SaaS化で解消

### スキーマで対応済み（1個）
- #1 DMキャンペーン追跡 → dm_send_log.campaign カラム

### Phase 1 で対応（4個） — ✅ 完了
- #5 VIPアラート → ✅ spy_messages + paid_users ルックアップ（vip_checker.py + フロント接続済み）
- #8 お礼DM自動 → ✅ DMシナリオエンジン（gift_thank シナリオ）
- #10 DM効果測定 → ✅ dm_effectiveness RPC + ダッシュボード実装済み
- #11 太客リアルタイム参照 → ✅ paying_users マテビュー + top_users_detail RPC + UI表示

### Phase 2 で対応（4個） — ✅ 3/4完了
- #7 Lead層識別 → ✅ 10セグメント分類（get_user_segments RPC）
- #22 離脱→DM導線 → ✅ churn_recovery シナリオ + リテンションコホート
- #31 二重送信防止 → 未着手
- #32 ブラックリスト → 未着手

### Phase 3 で対応（4個） — ✅ 2/4完了
- #29 キャスト横並び比較 → ✅ /analytics/compare 実装済み
- #35 user_timeline 統合 → ✅ get_transcript_timeline RPC（文字起こし+チャット+課金の時刻突合）
- #6 音声紐付け → cast_transcripts テーブル実装済み、クラウド化未着手
- #34 GPU外出し → 未着手

---

## ロードマップ — 現在 Phase 4 実装中（進捗 85%）

### Phase 1: MVP完成 — ✅ 完了
| タスク | 状態 |
|---|---|
| 認証（ログイン/新規登録/AuthProvider） | 完了 |
| SPYログ Realtime表示 | 完了 |
| DM送信 API連携 | 完了 |
| ダッシュボード Supabase実データ表示 | 完了 |
| Chrome拡張 SaaS対応（JWT認証、API連携、WS傍受、DM実行） | 完了 |
| 名簿同期（Coin API → Supabase） | 完了 |
| キャスト一覧 + 個別ページ（6タブ統合UI） | 完了 |
| ユーザー獲得ダッシュボード + ターゲット検索 | 完了 |
| DM一括送信（Chrome拡張連携、スケジュール送信） | 完了 |
| セッション管理 + 視聴者統計 | 完了 |
| アラートルール管理 | 完了 |

### Phase 2: 運用品質 — ✅ 完了
| タスク | 状態 |
|---|---|
| DM効果測定ダッシュボード（campaign別集計） | ✅ 完了 |
| ユーザーセグメント分析（10セグメント RPC） | ✅ 完了 |
| キャスト横並び比較（/analytics/compare） | ✅ 完了 |
| お礼DM自動送信（ギフト検出→DM自動キュー登録） | ✅ 完了（シナリオエンジン） |
| 離脱ユーザー→DM自動トリガー | ✅ 完了（churn_recovery シナリオ） |
| DMシナリオエンジン（ステップ配信 + ゴール検出） | ✅ 完了（AI統合済み） |
| Persona Agent統合（AI DM文面生成） | ✅ 完了（Phase 3で3層化） |
| キャスト間データ分離修正 | ✅ 完了（品質巡回で発見・修正） |
| 二重送信防止ロジック | 未着手 |
| ブラックリスト機能 | 未着手 |

### Phase 3: AI・品質・コンテンツ分析 — ✅ 完了
| タスク | 状態 |
|---|---|
| Persona Agent Phase 3（cast_personas + System Prompt 3層） | ✅ 完了（Migration 056） |
| 時刻突合タイムライン（文字起こし+チャット+課金統合） | ✅ 完了（Migration 055） |
| DM管理構造変更（キャスト選択→ユーザー別履歴→集計） | ✅ 完了 |
| 配信分析タブ（broadcast analysis） | ✅ 完了 |
| 品質チェックダッシュボード（/admin/health） | ✅ 完了 |
| UX改善62件（品質巡回+UX巡回） | ✅ 完了（32件一括修正） |
| Stripchat API統合レイヤー | ✅ 完了 |
| セッション詳細強化（コインAPI並列表示+タイムライン） | ✅ 完了 |

### Phase 4: プロダクション準備 — 🚧 実装中（進捗 45%）
| タスク | 状態 |
|---|---|
| 本番デプロイ — Vercelフロントエンド | ✅ 完了（livespot-rouge.vercel.app） |
| 本番デプロイ — Cloud Run バックエンド | 未着手 |
| Collector常駐プロセス化（WebSocket + バッチINSERT） | ✅ 完了 |
| P0-6: Collector SPY自動取得パイプライン（API直叩き） | ✅ 完了（12ファイル/2,239行 TypeScript） |
| DM API直叩き高速送信（15通/分、5倍高速化） | ✅ 完了（Migration 069） |
| Playwright E2Eテスト自動化（16 RPC疎通 + 7 E2E全合格） | ✅ 完了 |
| P0-1: レベニューシェア自動計算（RPC + UI） | ✅ 完了 |
| P0-2: キャスト登録UI（SQL直打ち解消） | 🔜 Next |
| P0-3: 品質改善バッチ（ErrorBoundary+404+loading+空データ） | 🔜 Next |
| P0-4: テストデータ削除UI（campaignプレフィックス自動付与） | 🔜 Next |
| P0-5: DM送信安全機構強化（1日上限/24h重複防止/campaign制限） | 🔜 Next |
| P0-7: SPYデータ品質管理自動化（欠損/重複/鮮度検出→Telegram） | 🔜 Next |
| API Routes認証追加（NextAuth session検証） | 未着手 |
| Stripe決済連携（プラン管理、課金） | 未着手 |
| Chrome Web Store 公開 | 未着手 |
| CORS本番ドメイン限定 | 未着手 |
| Chrome拡張メモリリーク対策 | 未着手 |
| Backend例外処理改善 | 未着手 |
| パフォーマンス最適化・負荷テスト | 未着手 |

---

## Recent Changes

### [2026-02-25] P0-6 Collector SPY + Crawler v3 + DM一斉送信

- P0-6: Collector SPY自動取得パイプライン完成 — 12ファイル/2,239行 TypeScript（Centrifugo WebSocket + REST API + Supabase バッチINSERT）
- Context Crawler v3: Notion↔CLAUDE.md 逆同期+差分レポート+OpenClaw統合（4_reverse_sync.py + 5_diff_report.py）
- DM一斉送信 2,969件実行（hanshakun: C_vip 636 + D_regular 1,951 + E_churned 323 + B_whale 59）
- Chrome拡張 host_permissions に livespot-rouge.vercel.app 追加

### [2026-02-24] DM API直叩き高速送信 + E2Eテスト全合格

- DM API直叩き高速送信: executeScript(world:MAIN)方式、DOM方式20秒/通→API方式4秒/通（5倍高速化）、15通/分達成
- CSRF取得: window.__logger.kibanaLogger.api.csrfParams、myUserId=AMP cookie、targetUserId=DB解決
- Chrome拡張 v2.11.0+、Migration 069（dm_cleanup_and_dedup）適用
- Playwright E2Eテスト自動化: 16 RPC疎通 + 7 E2E全合格、1.1分完了、スクリーンショット14枚
- 5不具合自動修正（dm_triggers.enabled→is_active、カラム名不一致等）

### [2026-02-24] SPY集計UI・トレンド分析

**新規RPC関数（Migration 065）:**
- get_spy_cast_schedule_pattern: 配信パターン分析（曜日×時間帯の配信頻度・視聴者・売上）
- get_user_payment_pattern: 課金パターン分析（金額帯分布・リピート率・時間帯別課金行動）
- get_cast_growth_curve: 成長曲線（日次KPIトレンド＋7日移動平均）
- get_goal_achievement_analysis: ゴール達成分析（頻度・金額・時間帯傾向）
- get_market_trend: マーケットトレンド（自社vs他社の日次シェア推移）

**フロントエンド:**
- SPYページ自社キャストに「分析」サブタブ追加（spy-analysis-tabs.tsx）
- 4つの分析タブ: 配信パターン / 課金パターン / 成長曲線 / マーケットトレンド
- recharts による対話的チャート（BarChart, LineChart, AreaChart）
- キャストフィルタ、期間選択（7/30/90日）、曜日×時間帯ヒートマップ

### [2026-02-24] DMトリガーエンジン実装

**新規テーブル（Migration 064）:**
- dm_triggers: DM自動トリガー定義（7種: first_visit/vip_no_tip/churn_risk/segment_upgrade/competitor_outflow/post_session/cross_promotion）
- dm_trigger_logs: 発火ログ（クールダウン管理、効果測定用）
- dm_send_log.trigger_log_id カラム追加

**Collector拡張（collector/src/triggers/）:**
- TriggerEngine クラス: トリガー定義5分キャッシュ、イベント/定期評価、遅延キュー
- 7つの評価関数: first-visit, vip-no-tip, post-session, churn-risk, segment-upgrade, competitor-outflow, cross-promotion
- collector.ts にフック3箇所挿入（session start/end、viewer list update）
- index.ts にsetInterval 3つ追加（定期評価1h、遅延キュー1m、定義リフレッシュ5m）
- ウォームアップ対策: 再起動後2サイクルはイベントトリガーをスキップ

**フロントエンド:**
- Settings画面に「DMトリガー」タブ追加（ON/OFFトグル、テンプレート編集、変数プレビュー、発火ログ100件）
- types/index.ts に DmTrigger/DmTriggerLog 型追加

### [2026-02-23] 26タスク完了 — Phase 4コア機能完成

**配信単位ビュー基盤（7件）:**
- セッション一覧 + RPC (Migration 049-050)
- spy_messages GROUP BY修正（sessionsテーブル依存廃止）
- 配信後モードUI + get_session_actions (Migration 051)
- 配信前モードUI（セグメント別DM準備+テンプレート選択）
- 配信中モードUI（Realtime + 3カラム）
- cast_transcripts + 録画アップロードUI (Migration 052)
- UXレビュー29件検出→24件修正

**データ基盤（2件）:**
- セッション統合 + coin_transactions突合 (Migration 053)
- DM送信本実装（dm-sender.ts汎用化 + 配信前/中/後モード接続）

**新機能（4件）:**
- Persona Agent Phase 3: cast_personas + 統一API + System Prompt 3層 (Migration 056)
- DMシナリオエンジン Phase 1: テーブル+エンロール+ゴール検出 (Migration 057)
- 他社SPY マーケット分析: 3 RPC + 配信前モード/SPYページUI (Migration 058)
- create_dm_batch RPC cast_name修正 (Migration 059)

**品質管理・QA（4件）:**
- COIN_RATE定数 lib/utils.ts 一元化（8ファイル統合）
- 本番巡回テスト: RPC cast_name欠落修正 + Map iteration修正
- Whisper API エラーハンドリング強化（ファイル形式チェック+日本語エラー+タイミングログ）
- transcribe 25MBサイズチェック + coin_bar除算ゼロ防止 + DMリダイレクトループ防止

**UI/UX改善（4件）:**
- スクリーンショット撮影機能 (Migration 054)
- DM管理構造変更（サイドバー→キャスト配下統合）
- 週次集計ビュー（期間フィルタ+トレンドグラフ+CSVエクスポート）
- DM送信前ユーザーリスト確認モーダル

**Prompt 23-27完全実装（5件）:**
- P-23: Realtime WebSocket無限ループ修正（6ファイル）
- P-24: 品質チェック自動化 /admin/health
- P-25: 配信分析ダッシュボード（キャスト詳細タブ）
- P-26: 時刻突合 get_transcript_timeline RPC (Migration 055)
- P-27: AI分析レイヤー /api/analyze-session（ルールベース Phase 1）

### [2026-02-22] 大規模更新
- UX改善バッチ2: 32件修正（CVR丸め、Unicode 1,106個修正、ペルソナタブ非表示、売上2カラム化）
- Stripchat API統合レイヤー: stripchat-api.ts（モデル情報、視聴者リスト、DM送信、サムネイル）
- DM送信サーバーサイドAPI化: /api/dm/send, /api/dm/batch（認証cookieベース）
- spy_viewers テーブル: 視聴者リアルタイム取得（Risa_06: 22人、yun_1022: 61人で動作確認）
- CDNサムネイル: captureAllThumbnailsCDN（img.doppiocdn.org/thumbs/）
- AutoPatrol URL修正: ja.stripchat.com/api/front/v2/models/username/{name}/cam
- Chrome拡張: JWT capture chain、セッション同期、cookies権限追加
- DB: stripchat_sessions, spy_viewers, screenshots.thumbnail_url, dm_send_log.sent_via, sessions.peak_viewers, registered_casts.stripchat_model_id
- Cloudflare Bot検知テスト: Vercelサーバーから直接アクセス可能（200 OK）

### 既知の未解決問題
- DM API化: フロントエンドから /api/dm/batch が呼ばれない（Chrome拡張フォールバックで運用に支障なし）
- CDNサムネイル: 配信中キャストでも取得失敗する場合あり
- セッション同期: userId=null（取得ロジック要修正）

### [2026-02-22] 🔍 品質巡回エージェント実施 — データ分離修正6件

**自動修正済み（コミット済み）:**
- [CRITICAL] dm/page.tsx: pollStatus に account_id フィルタ欠落 → 修正
- [CRITICAL] dm/page.tsx: Realtime subscription にアカウントフィルタ欠落 → 修正
- [HIGH] sessions/page.tsx: viewer_stats に cast_name フィルタ欠落 → 修正
- [HIGH] casts/[castName]/page.tsx: paid_users に cast_name フィルタ欠落 → 修正（前セッション）
- [HIGH] casts/[castName]/page.tsx: screenshots に account_id フィルタ欠落 → 修正（前セッション）
- [MED] dm/page.tsx: ハードコードされたテストURL/メッセージ → クリア
- [MED] sessions/page.tsx: ai_reports に account_id フィルタ欠落 → 修正

**残タスク（Production Hardening — 要判断）:**
- [Pre-deploy] Backend CORS: ワイルドカード許可 → 本番ドメイン限定に変更必要
- [Pre-deploy] Backend: 暗号化されていないCookie、ヘッダーインジェクション対策
- [Pre-deploy] Chrome拡張: ハードコードされたngrok URL → 環境変数化
- [Pre-deploy] Chrome拡張: localhost persona URL → 本番URL切替
- [Medium] Chrome拡張: background.js の Map/Set が無限増殖（メモリリーク）
- [Medium] Backend: 広範な except Exception: pass → 適切なエラーハンドリング
- [Medium] DM: ステータス遷移のバリデーションなし
- [Medium] Input: cast_name URLエンコーディング、ペイロードサイズ制限
- [Low] casts/page.tsx:651: DM送信エラーが警告ではなくブロッキング
- [Low] casts/page.tsx:860-868: RPC JSONB解析のエラーハンドリングなし
- [Low] analytics/page.tsx:189: daysWindow state 未使用
- [Low] use-realtime-spy.ts:179: delete に account_id なし（RLSで保護済み）

- [2026-02-20] ✅ GC（グループチャット）検出＋課金トラッキング — content_spy.js + background.js + migration 040
- [2026-02-20] ✅ DMシナリオエンジン — dm_scenarios + dm_scenario_enrollments テーブル、エンロール/ステップ進行/ゴール検出
- [2026-02-20] ✅ Persona Agent統合 — generateDmMessage() + AI文面生成 + フォールバック + 承認UI + migration 042
- [2026-02-23] ✅ Persona Agent Phase 3 — cast_personas + System Prompt 3層 + 統一API + ペルソナタブ（Migration 056）
- [2026-02-23] ✅ 時刻突合タイムライン — get_transcript_timeline RPC（文字起こし+チャット+課金統合）（Migration 055）
- [2026-02-23] ✅ DM管理構造変更 — キャスト選択画面化・ユーザー別DM履歴・キャンペーン集計
- [2026-02-20] ✅ キャスト間データ分離修正 — paid_usersキャッシュ cast_name欠落 + screenshots account_id欠落
- [2026-02-20] ✅ UIアコーディオン — セグメントS1-S10折りたたみ + エンロールメントリスト折りたたみ
- [2026-02-20] 🔍 品質巡回実施 — SPY vs コインAPI乖離は設計上の仕様（SPYはchat tip/giftのみ）

## Known Issues

- SPYログベースの売上表示はchat内tip/giftのみ（private/cam2cam/GC/ticket未計上）→ セッション詳細にコインAPI集計を並列表示する改善が必要
- テストDMデータ（campaign LIKE 'bulk_%', 'pipe3_bulk_%', '20250217_test_%'）が本番DBに残留 → 手動DELETE待ち
- dm_scenarios の CHECK制約にCR文字混入の可能性（Supabase SQL Editor経由のコピペ問題）

### Production Hardening（品質巡回で発見）
- [ ] CORS本番ドメイン限定（main.py）
- [x] Chrome拡張の環境変数化（config.js: update_url検出で本番/開発自動切替）

### [2026-02-22] UX巡回エージェント実施
- 発見: 62件（Critical 8 / High 18 / Medium 26 / Low 10）
- 最優先改善: サイドバーにDM/分析/ユーザーリンク追加（C3）、GO LIVEボタン削除（C8）
- ジャーニー検証: 4本中4本で詰まり（DM送信8クリック→4クリック目標、CVR導線なし）
- 詳細レポート: scripts/ux_audit_report_2026-02-22.md
- Batch 1〜全バッチ: ✅完了（32件修正）

### [2026-02-22] UX全改善 — 32件一括修正
**Critical 6件**: KPIタイムスタンプ(C1), DMキャンペーンCVR(C4), DM効果Coming soon(C5), AIレポートボタン(C7), サイドバーナビ(C3), GO LIVE削除(C8)
**High 13件**: Whale→ユーザー遷移+DM(H1), サーバー状態実データ(H4), セグメント凡例S1-S10(H5), セグメント→DMコンテキスト(H6), SPY/API売上ラベル(H7), API警告(H9), SPYフィルタ保存(H11), セキュリティ開発中(H13), ユーザーDMボタン(H14), ページネーション50件(H15), 通貨デュアル表示(H17), 離脱リスク非表示(H2), デモdev限定(H3), 画像UI削除(H10)
**Medium 10件**: コイン同期説明(M1), セグメント100名拡張(M3), シナリオ説明(M9), セッション空状態(M10), カスタム日付範囲(M11), 給与デモ警告(M13), CSVエクスポート(M14), レーダー正規化説明(M15), 単位ラベル(M17), DM絶対時刻(M25)
**Low 3件**: BAN削除(L2), スケルトンローダー(L9), 比較上限説明(L10)

### [2026-02-22] UX改善バッチ2 — 残り30件 + 追加発見分
**レイアウト大改修**: サイドバーカテゴリ整理(セパレーター化), Analytics 2カラム化, Coming soon非表示, CVR小数点1桁統一
**配信検出**: C2 配信中キャスト表示(spy_messages 10分), C6 SPY監視状態(🟢/🟡/🔴), H16 LIVEバッジ, H12 拡張接続インジケーター
**情報密度**: セグメントS1-S10順ソート, 凡例デフォルト展開, アコーディオン格納, tk重複修正
**ダッシュボード**: H18 推奨アクションカード(ルールベース)
- [ ] Chrome拡張メモリリーク対策（background.js: Map/Setの上限設定）
- [ ] Backend例外処理の改善（spy/sync/analytics の except pass）
- [ ] DM送信ステータスバリデーション
- [ ] Input validation強化（cast_name, payload size）

### [2026-02-23] Stripchat WebSocket/APIリバースエンジニアリング
- 詳細レポート: `docs/stripchat-websocket-protocol.md`
- **発見**: チャットはFlashphonerではなく **Stripchat独自のBayeux/CometD風プロトコル** をWebSocket上で使用
- **ドメイン**: `websocket.stripchat.com`（Cloudflare CDN経由）
- **認証**: WebSocket接続は匿名可能（ヘッダー/Cookie不要）
- **プロトコル**: 接続→clientId取得→JSON購読メッセージ送信→イベント受信
- **イベント18種**: newChatMessage, modelStatusChanged, tip, groupShow, goalChanged, etc.
- **メッセージ形式**: `{"subscriptionKey": "event:modelId", "params": {"message": {"type": "tip", "userdata": {"username": "..."}, "details": {"amount": 100}}}}`
- **Node.js直接接続可能** → Chrome拡張なしでサーバーサイド監視が実現可能
- **未確認**: WebSocket URLの完全パス（DevToolsで要確認）、newChatMessageの全typeバリエーション

---

## 次のタスク — Phase 4 残タスク

1. **P0-2: キャスト登録UI** — spy_castsへのキャスト追加・編集UI（/settings/castsページ）
2. **P0-3: 品質改善バッチ** — ErrorBoundary+404+loading+空データ 全ページ統一品質向上
3. **P0-4: テストデータ削除UI** — dm_send_logテストデータ削除UI + campaignに`test`プレフィックス自動付与
4. **P0-5: DM送信安全機構強化** — 1日上限/同一ユーザー24h重複防止/campaign制限（API高速送信対応の安全弁）
5. **P0-7: SPYデータ品質管理自動化** — P0-6完了後。欠損/重複/ギャップ/鮮度自動検出→alerts+Telegram
6. **API Routes認証追加** — transcribe/screenshot/analyze-session/persona に Bearer token検証
7. **Cloud Runバックエンドデプロイ** — FastAPI本番環境（Vercelフロントは済）
8. **CORS・セキュリティ強化** — 本番ドメイン限定、Backend例外処理改善
9. **Stripe決済連携** — プラン管理、課金フロー

---

## 品質監査レポート [2026-02-25] — 自律実行

### 監査概要
| 深刻度 | 件数 | 主な問題 |
|---|---|---|
| **Critical** | 4 | CORS wildcard+credentials / RLS全バイパス / DM batch所有権チェック漏れ / AIプロンプトインジェクション |
| **High** | 6 | テンプレ削除・DM更新・セッション読取の認可欠如 / Screenshot SSRF / re.match monkey-patch競合 / user-scoped client RLS問題 |
| **Medium** | 10 | env変数チェック不足 / コード重複 / レート制限無効 / 入力長制限なし / フィールドインジェクション / SPY認可欠如 |
| **Low** | 10 | ハードコード値 / ESLint抑制 / エラー握りつぶし / 認証パターン不統一 / ページネーション欠如 |

### データ整合性
- **禁止データ（2/15以前）**: 0件（クリーン）
- **coin_transactions重複**: 4件（ticketShow、おそらく正常）
- **DM二重送信**: 0件（dedup正常動作）
- **負数トークン**: 0件（4層防御が機能）
- **paid_users NULLセグメント**: 3,835名（28.4%）→ `refresh_segments` RPC実行が急務
- **DMトリガー送信**: 100%エラー（6/6失敗）→ trigger送信パスに問題
- **SPY監視ギャップ**: 2/16, 2/18のデータ完全欠損。2/24は5件のみ（通常3,000-9,000件/日）
- **sessions.peak_viewers**: 常に0（SPY監視パイプラインからの更新が機能していない）
- **dm_scenarios重複名**: 3件（初課金お礼/離脱防止(7日)/来訪フォロー が各2件）
- **spy_castsメタデータ**: 21件中19件がnull

### Critical修正（即時対応が必要）

**C-1: CORS設定** `backend/main.py:27-33`
```python
# 現状: allow_origins=["*"] + allow_credentials=True
# 修正: allow_origins=get_settings().cors_origins.split(",")
```

**C-2: RLS全面バイパス** `backend/routers/*.py`
全ルートが `get_supabase_admin()` を使用。`get_supabase_for_user` もservice role keyで作成されておりRLS無効の可能性。全エンドポイントに所有権チェック追加が必要。

**C-3: DM Batch所有権チェック漏れ** `frontend/src/app/api/dm/batch/route.ts:30-36`
リクエストbodyの `account_id` に対する所有権検証なし。他ユーザーのアカウントでDM一括送信が可能。

**C-4: AIレポートPromptインジェクション** `frontend/src/app/api/ai-report/route.ts:369-394`
ユーザー提供の `systemPrompt` をそのままClaude APIに渡している。systemPromptパラメータを除去すべき。

### 機能発火元マッピング
| 機能 | Chrome拡張 | SLS API | Collector | 状態 | 問題点 |
|---|---|---|---|---|---|
| コイン同期 | alarm(6h/配信後/earnings) | POST /sync/coins | - | WORKING | なし |
| DM送信(単発) | dm_executor.js DOM | POST /api/dm/send | - | WORKING | dm_api_sender.jsはスタブ化 |
| DM一括送信 | queue polling | POST /api/dm/batch | - | WORKING | 所有権チェック欠如(C-3) |
| SPY(チャット) | content_spy.js DOM | POST /spy/messages | WebSocket Centrifugo | WORKING | GC追跡SW再起動で消失 |
| SPY(視聴者) | viewerMembers alarm | - | REST polling | PARTIAL | JWT期限切れで失敗/個別UPSERT遅い |
| サムネイル取得 | spy-screenshot alarm(1min) | GET /api/screenshot | - | WORKING | 2テーブル分離(screenshots vs cast_screenshots) |
| 名簿同期 | FETCH_PAYING_USERS | POST /sync/csv | - | WORKING | 複数ソースでデータ競合の可能性 |
| セグメント算出 | - | RPC + inline計算 | - | WORKING | データソース不一致(spy_messages vs paid_users) |
| 配信状態検出 | spyAutoPatrol alarm(3min) | - | REST polling | WORKING | Cloudflare 403の可能性 |
| リアルタイム表示 | - | Supabase Realtime | - | WORKING | サーバー側フィルタなし/2000件上限 |
| 文字起こし | content_stt.js audio capture | POST /api/transcribe | - | PARTIAL | 2テーブル分離/GPU or OPENAI_API_KEY必要 |
| Persona Agent | fallback templates | GET/POST/PUT /api/persona | - | WORKING | なし（3段フォールバック完備） |
| AI分析レポート | - | POST /api/ai-report | - | WORKING | systemPromptインジェクション(C-4) |
| 配信レビュー | - | POST /api/analyze-session | - | WORKING(Phase1) | ルールベースのみ/AI未統合 |

### 「名簿同期 取得失敗」の原因
1. **JWT期限切れ**: Stripchat APIは認証済みセッションが必要。`stripchat_sessions`の認証情報が期限切れになると401/403が返る
2. **userId解決失敗**: `syncCastName`のフォールバックチェーンで`registered_casts`が見つからない場合
3. **Cloudflare WAFブロック**: 短時間に大量リクエストで403ブロック
4. **ページネーション中断**: API側が途中でエラーを返すと部分データのみ取得
修正案: リトライロジック追加、JWT事前チェック・自動リフレッシュ、`refresh_paying_users` RPCによる補完

### 不要機能・外すべきもの
- `dm_api_sender.js` — v3.0でスタブ化済み。ロジックは全てbackground.jsに移行
- `api.ts.bak` — バックアップファイルがリポジトリに残存
- `backend/collector/` (Python版) — Node.js版collectorと機能重複。統一すべき
- 空テーブル: `dm_templates`(0行), `broadcast_scripts`(0行), `ai_reports`(0行), `audio_recordings`(0行)

### 修正プラン（優先度×工数）
| 優先度 | 修正項目 | 工数 |
|---|---|---|
| P0 | CORS設定修正（config.pyのcors_originsを使用） | 5分 |
| P0 | DM batch所有権チェック追加 | 15分 |
| P0 | AI Report systemPrompt除去 | 5分 |
| P0 | Backend全ルートに所有権チェック追加 | 2時間 |
| P1 | Screenshot GET認証追加 or model_id検証 | 30分 |
| P1 | config.py monkey-patch除去 | 1時間 |
| P1 | refresh_segments RPC実行（3,835名のNULLセグメント解消） | 5分 |
| P1 | DMトリガーパイプライン100%エラーの原因調査・修正 | 1-2時間 |
| P2 | 認証パターン統一（3パターン→1パターン） | 2時間 |
| P2 | DM Batch maxDuration設定 + バックグラウンドジョブ化 | 2時間 |
| P2 | 重複コード統合（getSegment, callClaude） | 30分 |
| P3 | 空テーブル整理・テーブル統合（screenshots統合） | 1時間 |

### Notionレポート
https://www.notion.so/312a72d9e03b819ebc70e99d748b9ac2
