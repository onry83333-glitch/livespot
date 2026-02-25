# Plan: マイナストークン生成バグ恒久修正

## 問題分析

### 負のトークンが発生するコードパス

1. **content_coin_sync.js `parseTransaction()` (line 394)**
   - `tokens: tx.tokens ?? 0` — Stripchat APIの`tokens`値をそのまま使用
   - Stripchat APIが返す取引タイプには「チャージバック」「返金」など、tokens値がマイナスのケースがある可能性
   - `?? 0` は `null`/`undefined` のみ防ぐが、負数は素通り

2. **background.js `processCoinSyncData()` (line 1441)**
   - `const tokens = parseInt(tx.tokens ?? 0, 10);` — parseIntは負数をそのまま返す
   - バリデーションなし → そのままUPSERT

3. **background.js の upsert (line 1481)**
   - `on_conflict=account_id,user_name,cast_name,tokens,date` — tokensがconflictキーに含まれるため、同一トランザクションでも tokens が負だと別レコードとして挿入される

4. **backend/routers/sync.py (line 126)**
   - `tokens = int(tx.get("tokens") or tx.get("amount") or 0)` — 同様にバリデーションなし
   - POST `/coin-transactions` (line 404) でも `tx["tokens"]` をそのまま使用

5. **DB側 (001_initial_schema.sql)**
   - `tokens INTEGER NOT NULL` — CHECK制約なし、負数がINSERT可能

### 負の影響
- paying_users マテビュー（SUM(tokens)）で集計値が実態より低くなる
- ユーザーランキング・ARPU・LTVなどの分析が不正確になる
- upsertのconflictキーにtokensが含まれるため、同一取引の正と負で2レコードができる

## 修正計画

### 1. content_coin_sync.js — パース時にフィルタ（防衛第1層）
**ファイル**: `C:\dev\livespot\chrome-extension\content_coin_sync.js`
**関数**: `parseTransaction()` (line 375-403)

- `tokens` を `Math.max(0, tx.tokens ?? 0)` に変更
- tokens が 0 以下の場合、ログ出力して追跡可能にする

### 2. background.js — processCoinSyncData()でバリデーション（防衛第2層）
**ファイル**: `C:\dev\livespot\chrome-extension\background.js`
**関数**: `processCoinSyncData()` (line 1427-1546)

- line 1441: `parseInt(tx.tokens ?? 0, 10)` の後に `tokens <= 0` チェック追加
- tokens <= 0 のトランザクションをフィルタし、スキップ件数をログ出力

### 3. backend/routers/sync.py — バックエンドAPIでもバリデーション（防衛第3層）
**ファイル**: `C:\dev\livespot\backend\routers\sync.py`

- line 126: `tokens = int(...)` の後に `tokens <= 0` なら `continue` 追加
- line 400-410: POST `/coin-transactions` エンドポイントでも同様にフィルタ

### 4. DB CHECK制約（防衛第4層）
**ファイル**: 新規マイグレーション `C:\dev\livespot\supabase\migrations\023_coin_tx_tokens_check.sql`

- `ALTER TABLE coin_transactions ADD CONSTRAINT coin_tx_tokens_positive CHECK (tokens > 0);`
- 既存の不正データ（tokens <= 0）があればUPDATE/DELETEで除去してから制約追加

## 修正しないもの
- processPayingUsersData() の totalTokens — これは Stripchat API の集計値で、別のデータソース
- upsertのconflictキー構成 — 他メンバー（cast_name修正担当）の変更範囲と被るため触らない

## リスク
- Stripchat APIが正当に tokens=0 を返すケースがあるかもしれない（例: 無料ギフト）→ tokens > 0 のみ許可で問題ない（0トークンは記録する意味がない）
- 既存の tokens <= 0 データの削除 — 集計が変わるが、そもそも不正データなので正しい方向
