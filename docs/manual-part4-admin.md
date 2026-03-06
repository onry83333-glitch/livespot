# SLS操作マニュアル Part 4: 管理機能 + トラブルシューティング

> 対象: SLS管理者（YUUTA）
> 最終更新: 2026-03-06

---

## 目次

1. [管理機能](#1-管理機能)
2. [pm2プロセス管理](#2-pm2プロセス管理)
3. [トラブルシューティング](#3-トラブルシューティング)
4. [日常メンテナンス](#4-日常メンテナンス)

---

## 1. 管理機能

### 1.1 品質チェック（/admin/health）

5項目の自動品質チェックをワンクリックで実行できる画面。

**アクセス**: サイドバー > 管理 > 品質チェック

**チェック項目**:

| # | チェック | 内容 | 正常基準 |
|---|---|---|---|
| 1 | データ整合性 | coin_transactions重複・負数・2/15以前データ | 0件 |
| 2 | DM送信状態 | queued/sending滞留・二重送信 | 滞留0件 |
| 3 | セッション状態 | 未閉鎖セッション・分割セッション | 未閉鎖0件 |
| 4 | セグメント | paid_users NULLセグメント率 | 10%未満 |
| 5 | 同期ヘルス | 各パイプラインの最終同期時刻 | 24h以内 |

**同期ヘルスの見方**:
- 緑: 24時間以内に同期あり
- 黄: 24-48時間
- 赤: 48時間以上（要確認）

### 1.2 データ同期パネル（キャスト詳細ページ）

各キャストの詳細ページ（/casts/[castName]）の「概要」タブ内に表示。

**表示項目**:
- SPYチャット: spy_messagesの最終取得時刻
- コイン同期: coin_transactionsの最終取得時刻
- スクリーンショット: cast_screenshotsの最終取得時刻

**同期の実行方法**: Chrome拡張から手動実行（自動実行は中止済み）

### 1.3 DMシナリオ管理

**テーブル**: dm_scenarios, dm_scenario_steps, dm_scenario_enrollments

**シナリオ種別**:
| シナリオ | トリガー | 目的 |
|---|---|---|
| gift_thank | 初課金検出 | お礼DM自動送信 |
| churn_recovery | 7日未来訪 | 離脱防止 |
| visit_follow | 来訪検出 | フォローアップ |

### 1.4 DMトリガー管理（/settings > DMトリガー）

7種のDMトリガーのON/OFF切り替えとテンプレート編集が可能。

**トリガー種別**: first_visit / vip_no_tip / churn_risk / segment_upgrade / competitor_outflow / post_session / cross_promotion

**注意**: 現在DMトリガー送信パイプラインは100%エラー状態（調査中）。手動DM送信は正常動作。

---

## 2. pm2プロセス管理

### 2.1 プロセス一覧

SLSのCollectorは pm2 で28プロセスを管理している。

| 種別 | プロセス名 | 役割 | 再起動 |
|---|---|---|---|
| 基盤 | auth-manager | Stripchat認証管理・JWT更新 | 自動 |
| 基盤 | coin-sync | コイン取引同期（6時間ごと） | 自動 |
| 基盤 | dm-service | DM送信キューポーリング+送信 | 自動 |
| 基盤 | daily-briefing | 日次ブリーフィング（毎朝0:00 cron） | 手動 |
| 自社 | cast-hanshakun | はんしゃくん SPY監視+セッション管理 | 自動 |
| 自社 | cast-Risa_06 | りさ SPY監視+セッション管理 | 自動 |
| 他社 | spy-{cast_name} x22 | 他社キャスト SPY監視 | 自動 |

**設定ファイル**: `collector/ecosystem.config.cjs`（自動生成、手動編集禁止）

**再生成コマンド**: `cd collector && npx tsx scripts/gen-ecosystem.ts`

### 2.2 基本操作

```bash
# プロセス一覧
pm2 list

# 全プロセス起動
cd C:\dev\livespot\collector
pm2 start ecosystem.config.cjs

# 特定プロセス操作
pm2 restart cast-hanshakun
pm2 stop dm-service
pm2 start dm-service

# ログ確認（リアルタイム）
pm2 logs cast-hanshakun --lines 50
pm2 logs dm-service --lines 50

# 全プロセスのログ
pm2 logs --lines 20

# 全停止
pm2 stop all

# 全削除（プロセスリストからも消す）
pm2 delete all
```

### 2.3 ログファイルの場所

```
collector/logs/
  auth-manager.log       # 認証管理
  coin-sync.log          # コイン同期
  dm-service.log         # DM送信
  daily-briefing.log     # 日次レポート
  hanshakun.log          # はんしゃくん
  Risa_06.log            # りさ
  {cast_name}.log        # 各他社キャスト
  *-error.log            # エラーのみ
  *-out.log              # 標準出力のみ
```

### 2.4 メモリ制限

| プロセス種別 | 上限 | 超過時の動作 |
|---|---|---|
| auth-manager | 300MB | 自動再起動 |
| coin-sync | 200MB | 自動再起動 |
| dm-service | 200MB | 自動再起動 |
| daily-briefing | 150MB | 自動再起動 |
| cast-* (自社) | 200MB | 自動再起動 |
| spy-* (他社) | 150MB | 自動再起動 |

### 2.5 障害復旧

**全プロセスが停止した場合**:
```bash
cd C:\dev\livespot\collector
pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save
```

**特定キャストだけ停止している場合**:
```bash
pm2 restart cast-hanshakun
```

**再起動上限に達した場合（max_restarts）**:
```bash
# ステータスが「errored」になる
pm2 describe cast-hanshakun  # 確認
pm2 delete cast-hanshakun    # 削除
pm2 start ecosystem.config.cjs --only cast-hanshakun  # 再登録
```

---

## 3. トラブルシューティング

### 3.1 コイン同期が失敗する

**症状**: データ同期パネルのコイン同期が古い日付のまま

**確認手順**:
```bash
pm2 logs coin-sync --lines 100
```

**よくある原因と対処**:

| 原因 | ログメッセージ | 対処 |
|---|---|---|
| JWT期限切れ | `401` / `403` | Chrome拡張でStripchatに再ログイン → Cookie更新 |
| Cloudflare WAF | `403 Forbidden` | 数時間待ってリトライ |
| refresh_segments失敗 | `refresh_segments エラー` | 一時的なもの。次回サイクルで再実行される |
| userId解決失敗 | `syncCastName: not found` | registered_castsにcast_nameが登録されているか確認 |

### 3.2 Chrome拡張でコイン同期を手動実行

1. Chrome拡張のポップアップを開く
2. 「Earnings同期」ボタンをクリック
3. 完了後、SLS管理画面でデータを確認

### 3.3 SPYチャットが取得できない

**症状**: /spy ページにメッセージが表示されない

**確認手順**:
```bash
# 対象キャストのログ確認
pm2 logs cast-hanshakun --lines 100

# WebSocket接続状態
pm2 logs cast-hanshakun --lines 200 | grep -i "ws\|websocket\|connect"
```

**よくある原因**:

| 原因 | 対処 |
|---|---|
| WS 3501エラー頻発 | ゲストJWT約30秒で切断 → auth-managerが自動リトライ。放置でOK |
| プロセスが停止 | `pm2 restart cast-{name}` |
| キャストがオフライン | 配信開始後に自動接続される |
| 3重起動 | `pm2 list`で同一キャストが複数ないか確認。あれば`pm2 delete`で整理 |

### 3.4 セッションが分割される

**症状**: 1回の配信が複数セッションに分割される

**根本原因**: Collector再起動時にオンラインキャストの既存セッションを閉じてしまう（2026-03-05修正済み）

**修正済み動作**: 起動時にオンラインなら既存セッションを `resumeExistingSession()` で再開する

**手動マージが必要な場合**:
1. sessionsテーブルで同一キャストの連続セッション（gap < 60秒）を特定
2. 後半セッションのspy_messagesのsession_idを前半に更新
3. 前半セッションのended_atを後半のended_atに更新
4. 後半セッションを削除

### 3.5 DM送信がブロックされる

**症状**: dm_send_logのステータスが「error」のまま

**確認手順**:
```bash
pm2 logs dm-service --lines 100
```

**よくある原因**:

| 原因 | ログ/ステータス | 対処 |
|---|---|---|
| テストモード | `blocked_test_mode` | `DM_TEST_MODE=false`に変更してdm-service再起動 |
| キャンペーン未設定 | `blocked_no_campaign` | DM送信時にcampaign名を設定する |
| キャスト不一致 | `blocked_identity_mismatch` | 正しいキャストのCookieが設定されているか確認 |
| 日次上限到達 | `daily limit reached` | 翌日を待つか`DM_DAILY_LIMIT`を調整 |
| 同一ユーザー24h制限 | `cooldown` | 24時間経過を待つ |
| StripchatセッションなしI | `no active session` | Chrome拡張でStripchatにログイン → Cookie取得 |

**テストモードの切り替え**:
```bash
# ecosystem.config.cjs内のdm-serviceセクション
# DM_TEST_MODE: "true" → "false" に変更後
pm2 restart dm-service
```

### 3.6 Vercelデプロイが失敗する

**デプロイ方法**: git pushでmainブランチに変更を反映 → 自動デプロイ

**確認手順**:
1. Vercelダッシュボードでビルドログを確認
2. ローカルで`cd frontend && npm run build`が通るか確認

**よくある原因**:

| 原因 | 対処 |
|---|---|
| TypeScriptエラー | `npm run build`のエラーを修正 |
| 環境変数不足 | Vercelダッシュボードで環境変数を設定 |
| パッケージ不足 | `npm install`後にcommit |

**vercel.json**: 作成・変更・削除禁止。VercelはRoot Directory=frontendでダッシュボード管理。

### 3.7 売上データに乖離がある

**SPY売上 vs コインAPI売上の違い**:

| データソース | 捕捉範囲 | 精度 |
|---|---|---|
| SPY (spy_messages) | チャット内tip/giftのみ | 低（捕捉率 約0.78%） |
| コインAPI (coin_transactions) | 全収入（private/cam2cam/GC/ticket含む） | 高 |

**対処**: 売上データは常にコインAPI（coin_transactions）のtokensカラムで集計する。SPY売上はリアルタイム参考値として使う。

### 3.8 refresh_segmentsでNULLセグメントが多い

**症状**: 品質チェックでNULLセグメント率が高い

**対処**: Supabase SQL Editorで手動実行
```sql
SELECT refresh_segments('940e7248-1d73-4259-a538-56fdaea9d740');
```

### 3.9 セッションが未閉鎖のまま残る

**症状**: 品質チェックで未閉鎖セッション警告

**確認**:
```sql
SELECT session_id, cast_name, started_at
FROM sessions
WHERE ended_at IS NULL
ORDER BY started_at DESC;
```

**対処**:
```sql
-- 配信中のキャストでなければ手動クローズ
UPDATE sessions
SET ended_at = NOW(), status = 'ended'
WHERE session_id = '{session_id}'
  AND ended_at IS NULL;
```

またはRPC経由:
```sql
SELECT close_orphan_sessions();
```

---

## 4. 日常メンテナンス

### 4.1 毎日のチェック項目

| 時間 | 項目 | 方法 |
|---|---|---|
| 朝 | pm2プロセス確認 | `pm2 list` — 全プロセスonline |
| 朝 | Telegram通知確認 | daily-briefingが送信されているか |
| 随時 | 品質チェック | /admin/health でワンクリック実行 |

### 4.2 週次のメンテナンス

| 項目 | 方法 |
|---|---|
| セグメント更新 | `refresh_segments` RPC実行 |
| ログクリーンアップ | `pm2 flush` で古いログを削除 |
| データ整合性チェック | /admin/health > データ整合性 |

### 4.3 キャスト追加・削除

**自社キャスト追加**:
1. Supabase > registered_casts にINSERT
2. `cd collector && npx tsx scripts/gen-ecosystem.ts` で ecosystem.config.cjs 再生成
3. `pm2 delete all && pm2 start ecosystem.config.cjs && pm2 save`

**他社キャスト追加**:
1. Supabase > spy_casts にINSERT
2. 同上の手順で ecosystem再生成 + pm2再起動

### 4.4 DMテストモード

本番DM送信前にテストモードで確認:

1. `DM_TEST_MODE=true` (ecosystem.config.cjs のデフォルト)
2. テスト用キャンペーン名は `test_` プレフィックスを付ける
3. テスト完了後 `DM_TEST_MODE=false` に変更して `pm2 restart dm-service`

### 4.5 環境変数の場所

| ファイル | 用途 | 編集 |
|---|---|---|
| collector/.env | Collector全般 | 読み取りのみ（Claude編集禁止） |
| frontend/.env.local | フロントエンド | 読み取りのみ |
| backend/.env | バックエンド | 読み取りのみ |
| collector/ecosystem.config.cjs | pm2設定 | gen-ecosystem.tsで自動生成 |

---

## 付録: エラーメッセージ早見表

| エラー | 場所 | 意味 | 対処 |
|---|---|---|---|
| `WS 3501` | cast-*/spy-*ログ | WebSocket切断 | 自動リトライ。放置OK |
| `401 Unauthorized` | coin-syncログ | JWT期限切れ | Chrome拡張で再ログイン |
| `403 Forbidden` | 各ログ | Cloudflare WAFブロック | 数時間待つ |
| `PGRST202` | フロントエンド | RPC関数が存在しない | Migration未適用の可能性 |
| `23505` | sessionログ | セッション重複INSERT | 正常（既存セッション検出） |
| `blocked_test_mode` | dm-serviceログ | テストモードでブロック | DM_TEST_MODE=false |
| `refresh_segments エラー` | coin-syncログ | セグメント更新失敗 | 一時的。次回自動リトライ |

---

> Part 1-3は今後作成予定。全パート完成後にSLS-MANUAL.mdに統合する。
