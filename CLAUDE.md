# LiveSpot - Premium Agency OS

## プロジェクト概要
ライブ配信エージェンシー（Stripchat）向けSaaS管理プラットフォーム。
旧名 MorningHook（ローカル版 Streamlit + SQLite）を Next.js + Supabase + FastAPI で SaaS 化。

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
  admin/command-center/page.tsx  # /admin/command-center — Wisteria コマンドセンター（4タブ: コマンド/戦略/オペレーション/アセット）
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
  utils.ts            # cn(), formatTokens(), tokensToJPY(), formatJST(), timeAgo()
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
  020_check_data_integrity.sql  # check_data_integrity RPC（16項目データ整合性チェック）
  021_fix_dm_send_log_cast_name.sql  # dm_send_log cast_name NULL修正（2,309行バックフィル）
  022_dedup_coin_transactions.sql  # coin_transactions重複削除 + ユニークインデックス
  023_pipeline_status.sql     # pipeline_status テーブル + 自動検出RPC（update_pipeline_auto_status）
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
| /admin/command-center | app/admin/command-center/page.tsx | 実装済み（Wisteria 4タブ、pipeline_status連携、60sポーリング） |

---

## 環境変数

### frontend/.env.local
```
NEXT_PUBLIC_SUPABASE_URL=https://ujgbhkllfeacbgpdbjto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbG...
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
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

### Phase 1 で対応（4個）
- #5 VIPアラート → spy_messages + paid_users ルックアップ（vip_checker.py 実装済み、フロント未接続）
- #8 お礼DM自動 → dm_send_log + トリガー/Edge Function
- #10 DM効果測定 → dm_effectiveness RPC関数（実装済み、フロント未接続）
- #11 太客リアルタイム参照 → paying_users マテビュー + top_users_detail RPC

### Phase 2 で対応（4個）
- #7 Lead層識別 → coin_transactions からライフサイクル分類（active/dormant/churned/new）
- #22 離脱→DM導線 → リテンションコホート → DM自動トリガー
- #31 二重送信防止 → dm_send_log で user_name + campaign の重複チェック
- #32 ブラックリスト → paid_users に blacklist フラグ追加（要マイグレーション）

### Phase 3 で対応（4個）
- #29 キャスト横並び比較 → ダッシュボードにキャスト別集計ビュー
- #35 user_timeline 統合 → 新テーブル or ビューで課金/DM/入室/チャットを統合
- #6 音声紐付け → audio_recordings テーブル（スキーマ済み、処理未実装）
- #34 GPU外出し → AI処理をCloud Run等に分離

---

## ロードマップ

### Phase 1: MVP完成 — 完了
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

### Phase 2: 運用品質
| タスク | 状態 |
|---|---|
| DM効果測定ダッシュボード（campaign別集計） | 完了 |
| ユーザーセグメント分析（10セグメント RPC） | 完了 |
| キャスト横並び比較（/analytics/compare） | 完了 |
| お礼DM自動送信（ギフト検出→DM自動キュー登録） | 完了（シナリオエンジン Phase 1） |
| 離脱ユーザー→DM自動トリガー | 完了（churn_recovery シナリオ） |
| DMシナリオエンジン（ステップ配信 + ゴール検出） | 完了（Phase 1 + Phase 2 AI統合） |
| Persona Agent統合（AI DM文面生成） | 完了（Phase 2） |
| キャスト間データ分離修正 | 完了（品質巡回で発見・修正） |
| 二重送信防止ロジック | 未着手 |
| ブラックリスト機能 | 未着手 |

### Phase 3: スケーリング
| タスク | 状態 |
|---|---|
| 本番デプロイ（Vercel + Cloud Run + Supabase） | 未着手 |
| Stripe決済連携（プラン管理、課金） | 未着手 |
| Chrome Web Store 公開 | 未着手 |
| user_timeline 統合ビュー | 未着手 |
| 音声クラウド化（録音→文字起こし→分析） | 未着手 |
| パフォーマンス最適化・負荷テスト | 未着手 |

---

## Recent Changes

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
- [2026-02-20] ✅ DMシナリオエンジン Phase 1 — dm_scenarios + dm_scenario_enrollments テーブル、エンロール/ステップ進行/ゴール検出
- [2026-02-20] ✅ DM Phase 2: Persona Agent統合 — generateDmMessage() + AI文面生成 + フォールバック + 承認UI + migration 042
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

---

## 次のタスク

1. **テストDMデータ削除** — dm_send_log の test/bulk キャンペーン削除（SQL確認待ち）
2. **セッション詳細にコインAPI売上を並列表示** — SPYベース + コインAPIベースの二重表示
3. **二重送信防止** — dm_send_log で user_name + campaign の重複チェック
4. **本番デプロイ** — Vercel（フロントエンド）+ Cloud Run（バックエンド）+ Supabase本番
