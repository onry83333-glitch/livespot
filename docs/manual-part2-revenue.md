# SLS 操作マニュアル — Part 2: 売上管理 + データ同期

## 目次

1. [ダッシュボード（/casts）](#1-ダッシュボードcasts)
2. [キャスト詳細 — 概要タブ](#2-キャスト詳細--概要タブ)
3. [キャスト詳細 — 配信タブ（セッション一覧）](#3-キャスト詳細--配信タブセッション一覧)
4. [コイン同期の仕組み](#4-コイン同期の仕組み)
5. [トラブルシューティング](#5-トラブルシューティング)

---

## 1. ダッシュボード（/casts）

### 画面の役割

`/casts` はSLSのメインダッシュボード。登録キャスト全体の売上状況を一覧で確認できる。

### KPIカード（画面上部 6枚）

| カード | 内容 | データソース |
|---|---|---|
| 30日売上（トークン） | 直近30日間の `coin_transactions.tokens` 合計 | `coin_transactions` WHERE `transacted_at >= 30日前` |
| 30日売上（円） | 上記 × 7.7（COIN_RATE） | 同上 |
| 今週売上 | 月曜03:00 JST〜現在の売上合計 | `coin_transactions` WHERE `transacted_at >= 今週月曜03:00 JST` |
| 前週比（WoW%） | （今週 ÷ 前週 − 1）× 100 | 今週 vs 前週の同期間比較 |
| 登録キャスト数 | `registered_casts` のアクティブ件数 | `registered_casts` WHERE `is_active = true` |
| LIVE中 | 直近10分以内に `chat_logs` がある=配信中と判定 | `chat_logs` WHERE `created_at >= 10分前` |

#### 週の境界について

- **週の開始**: 月曜 03:00 JST（= 月曜 00:00 JST ではない）
- **理由**: 深夜配信が02:59まで続くケースを考慮し、月曜の00:00〜02:59は前週扱い
- **実装**: `getWeekBoundary()` 関数（`casts/page.tsx`内）

#### 売上取得の仕組み

1. まず RPC `get_cast_stats` を試行（高速）
2. RPC失敗時はフォールバック: `coin_transactions` テーブルを keyset pagination で直接集計
3. ページネーション: 1回5,000件ずつ取得し、`id` の昇順で次ページを辿る（最大100ページ = 50万件）

### キャスト一覧テーブル

| 列 | 内容 |
|---|---|
| キャスト名 | `registered_casts.cast_name`（LIVEバッジ付き） |
| 今週コイン | 今週の `coin_transactions.tokens` 合計 |
| 前週比 | WoW% 表示（緑=増加、赤=減少） |
| 30日コイン | 直近30日の合計 |
| メッセージ数 | `spy_messages` のカウント |
| ユニークユーザー | `coin_transactions` の DISTINCT `user_name` |
| タグ | `registered_casts.tags`（JSON配列） |

#### LIVE判定ロジック

- `chat_logs` テーブルで該当キャストの最新レコードが **10分以内** → LIVEバッジ表示
- Collectorが停止中の場合、実際にはLIVEでもバッジが消える

---

## 2. キャスト詳細 — 概要タブ

### 画面構成（`/casts/[castName]`）

概要タブは以下のセクションで構成:

1. **KPIカード行**: 30日売上、今週売上、ユニークユーザー数、平均セッション時間
2. **売上グラフ**: 日別の `coin_transactions` 集計をチャート表示
3. **データ同期パネル（DataSyncPanel）**: 4種のデータソースの同期状態を表示
4. **最近のセッション**: 直近5件のセッション概要

### データ同期パネル

| 同期種別 | 説明 | 正常の目安 |
|---|---|---|
| コイン同期 | `coin_transactions` の最新 `transacted_at` | 2時間以内 |
| SPY同期 | `spy_messages` の最新 `message_time` | Collector稼働中なら数秒以内 |
| セッション同期 | `sessions` の最新 `started_at` | 最終配信時刻 |
| 視聴者同期 | `viewer_stats` の最新 `fetched_at` | Collector稼働中なら数十秒以内 |

各パネルに色付きインジケータ:
- 緑: 正常（閾値以内）
- 黄: 注意（やや遅延）
- 赤: 異常（長時間更新なし）

---

## 3. キャスト詳細 — 配信タブ（セッション一覧）

### データソース

セッション一覧は RPC `get_session_list_v2` から取得。このRPCは:

1. `sessions` テーブルからセッション基本情報を取得
2. `coin_transactions` を時間帯で突合し、セッション単位の売上を算出
3. `spy_messages` からメッセージ数・ユニークユーザー数を集計

### テーブル列

| 列 | 内容 | ソース |
|---|---|---|
| 開始 | セッション開始時刻（JST表示） | `sessions.started_at` |
| 終了 | セッション終了時刻 | `sessions.ended_at` |
| タイトル | 配信タイトル（ルームトピック） | `sessions.broadcast_title` |
| 時間 | 配信時間（HH:MM形式） | ended_at − started_at |
| コイン | セッション中の売上トークン合計 | `coin_transactions` 時間帯突合 |
| 円 | コイン × 7.7 | 計算値 |
| メッセージ | チャットメッセージ数 | `spy_messages` カウント |
| ピーク視聴者 | 最大同時視聴者数 | `sessions.peak_viewers` |

### 売上の2つのソース

SLSではセッション売上を**2つのソース**から表示:

1. **coin_transactions（主）**: Stripchat Coin APIから取得した正式な課金データ。private/cam2cam/ticket/GC全てを含む
2. **spy_messages（参考）**: チャット内のtip/giftのみ。chat tip以外の課金は含まれない

> 重要: spy_messagesベースの売上はchat内tip/giftのみのため、実際の売上より大幅に少ない（捕捉率 約1%）。coin_transactionsが正確な売上データ。

### 配信タイトルの取得元

- Stripchat API `/api/front/v2/models/username/{name}/cam` のレスポンスから取得
- `user.broadcastSettings.topic` または `user.topicText` フィールド
- Collectorがセッション開始時（`openSession`）にDBに保存

---

## 4. コイン同期の仕組み

### 概要

コイン同期は、Stripchatの課金APIから `coin_transactions` テーブルにデータを取り込む処理。3つの実行方法がある:

| 方式 | ファイル | 実行方法 | 用途 |
|---|---|---|---|
| PM2常駐サービス | `collector/src/coin-sync-service.ts` | PM2で自動起動（1時間間隔） | 通常運用 |
| 手動CLI | `collector/src/coin-sync.ts` | `npx tsx src/coin-sync.ts` | 手動実行・デバッグ |
| Cookie直接指定 | `collector/src/coin-import.ts` | `npx tsx src/coin-import.ts` | 緊急時・初回データ投入 |

### PM2常駐サービス（coin-sync-service.ts）

#### 動作フロー

```
1. 起動 → 即時1回実行
2. 1時間待機
3. 再実行 → 2に戻る（無限ループ）
```

#### 各実行サイクルの処理

```
1. registered_casts からアクティブなキャスト一覧を取得
2. 各キャストについて:
   a. stripchat_sessions テーブルから有効なセッションCookieを取得
      - is_valid = true のレコードを優先
      - 3段階フォールバック: キャスト専用 → NULL → 任意
   b. Cookieを使ってStripchat Coin APIにリクエスト
      - エンドポイント: /api/front/v2/models/{modelId}/earnings
      - 800ms間隔でリクエスト（レート制限回避）
   c. 取得したトランザクションを coin_transactions に UPSERT
      - 500件ずつバッチ処理
      - ON CONFLICT (account_id, stripchat_tx_id) で重複回避
   d. 401/403エラー時: 該当セッションを is_valid = false にマーク
```

#### 認証（Cookie）の仕組み

Stripchat Coin APIはログイン済みセッションCookieが必要。Cookieの供給元:

1. **Chrome拡張（主）**: 30分ごとに `exportSessionCookie()` が発火し、ブラウザのStripchat Cookieを `stripchat_sessions` テーブルに保存
2. **Playwright自動更新**: `refresh-cookies.ts` がCloudflare cf_clearanceトークンを自動取得
3. **手動投入**: DevToolsからCookieをコピーして `coin-import.ts` で直接指定

#### Cookie有効期限

- Stripchatセッション: 約24時間（自動延長あり）
- cf_clearance: 約30分（Cloudflare WAF）
- Chrome拡張が30分ごとに更新するため、ブラウザが開いている限り有効

### 手動CLI（coin-sync.ts）

5層の認証チェーン（優先順位順）:

1. コマンドライン引数 `--cookie "..."`
2. 環境変数 `STRIPCHAT_SESSION_COOKIE`
3. `stripchat_sessions` テーブル（キャスト専用）
4. `stripchat_sessions` テーブル（汎用）
5. Playwright自動取得（最終手段）

使用例:
```bash
# 全キャスト同期（DBのCookieを使用）
npx tsx src/coin-sync.ts

# 特定キャスト + Cookie指定
npx tsx src/coin-sync.ts --cast hanshakun --cookie "session=abc123..."

# 日付範囲指定
npx tsx src/coin-sync.ts --since 2026-03-01 --until 2026-03-05
```

### Cookie直接指定（coin-import.ts）

DevToolsからコピーしたCookieを直接使用:

```bash
npx tsx src/coin-import.ts --cookie "session=abc; cf_clearance=xyz" --cast hanshakun
```

主に以下の状況で使用:
- Chrome拡張が停止している
- PM2サービスのCookieが全て期限切れ
- 初回セットアップ時

---

## 5. トラブルシューティング

### 売上が0と表示される

**確認手順:**

1. `/casts/[castName]` の概要タブ → データ同期パネルで「コイン同期」の最終更新を確認
2. 赤表示（2時間以上更新なし）の場合:
   - Chrome拡張が起動しているか確認（Cookieの供給元）
   - PM2で `coin-sync-service` が稼働しているか確認: `pm2 status`
   - Cookie期限切れ: `stripchat_sessions` テーブルで `is_valid = false` のレコードを確認

**対処法:**

```bash
# PM2サービスの状態確認
pm2 status

# 手動で同期実行
cd collector
npx tsx src/coin-sync.ts

# Cookieが全て無効の場合: DevToolsからCookieをコピーして手動投入
npx tsx src/coin-import.ts --cookie "取得したCookie文字列"
```

### LIVEバッジが表示されない

- Collectorが稼働していないと `chat_logs` が更新されず、10分閾値を超えてLIVEバッジが消える
- PM2で `collector` プロセスの状態を確認: `pm2 status`

### セッションが分割される

- Collector再起動時にセッションが分割されることがある
- `resumeExistingSession()` が未閉鎖セッションを検出して再利用するが、タイミングによっては新セッションが作成される
- 手動マージが必要な場合は Migration 053 の `merge_sessions` RPCを使用

### 前週比が異常な値を示す

- 週の境界は月曜03:00 JST
- 前週のデータが不完全（Cookie切れで同期が止まっていた等）だと、比較値が歪む
- コイン同期の連続性を確認し、欠損期間があれば手動で再同期

### spy_messagesの売上とcoin_transactionsの売上が大きく異なる

- これは正常な動作。spy_messagesはチャット内のtip/giftのみを記録
- private show / cam2cam / ticket show / group chat の課金はspy_messagesに含まれない
- 正確な売上は常に `coin_transactions` を参照すること

---

## 補足: データフロー全体図

```
Stripchat
  ├── WebSocket (Centrifugo) ──→ Collector ──→ spy_messages / chat_logs
  ├── REST API (/cam) ──→ Collector ──→ sessions (status + broadcast_title)
  ├── REST API (/members) ──→ Collector ──→ viewer_stats / spy_viewers
  ├── Coin API (/earnings) ──→ coin-sync-service ──→ coin_transactions
  └── Browser Cookies ──→ Chrome拡張 ──→ stripchat_sessions

Frontend
  ├── /casts ──→ coin_transactions (KPI) + chat_logs (LIVE判定)
  ├── /casts/[castName] 概要 ──→ coin_transactions + sessions + spy_messages
  ├── /casts/[castName] 配信 ──→ get_session_list_v2 RPC (sessions × coin_transactions 突合)
  └── /spy ──→ spy_messages (Realtime) + viewer_stats
```

---

*最終更新: 2026-03-06*
