# Migration 087-095 本番適用手順

## レビュー結果: 安全（破壊的変更なし）

### 適用するファイル（2ステップ）

| 順序 | ファイル | 内容 |
|---|---|---|
| **Step 1** | `apply_087_to_095.sql` | 087-094 + 095の2/4関数（1,151行） |
| **Step 2** | `095_fix_broken_rpcs.sql` | 095の全4関数（605行、Step 1の2関数を上書き+残り2関数追加） |

### 適用方法
1. [Supabase SQL Editor](https://supabase.com/dashboard/project/ujgbhkllfeacbgpdbjto/sql) を開く
2. `apply_087_to_095.sql` の全内容をペーストして **Run**
3. `095_fix_broken_rpcs.sql` の全内容をペーストして **Run**
4. 適用後検証（後述）

### 各Migration内容

| # | 内容 | 種類 | 冪等ガード |
|---|---|---|---|
| 087 | sessions重複削除 + 部分UNIQUE制約 | DDL+DML | ✅ インデックス存在チェック |
| 088 | 孤児セッション一括クローズ + `close_orphan_sessions` RPC | DML+RPC | UPDATE冪等 |
| 089 | `get_dm_effectiveness_by_segment` セグメントJOIN修正 | RPC | CREATE OR REPLACE |
| 090 | spy_viewers ゴーストデータ削除 + CHECK制約 | DDL+DML | ✅ 制約存在チェック |
| 091 | `get_weekly_coin_stats` RPC | RPC | CREATE OR REPLACE |
| 092 | `get_dm_campaign_cvr` 来場CVR追加 + `get_user_acquisition_dashboard` cast_name修正 | RPC+INDEX | CREATE OR REPLACE + IF NOT EXISTS |
| 093 | `check_spy_data_integrity` RPC + spy_viewers UNIQUE制約 | RPC+DDL | ✅ UNIQUE存在チェック |
| 094 | `calc_churn_risk_score` / `user_summary` / `get_session_actions` cast_name修正 | RPC | DROP→CREATE（シグネチャ変更のため） |
| 095 | 壊れたRPC 4関数修正 | RPC | DROP→CREATE |

### 適用後検証コマンド

```bash
# 1. close_orphan_sessions（088で追加）
curl -s -X POST "https://ujgbhkllfeacbgpdbjto.supabase.co/rest/v1/rpc/close_orphan_sessions" \
  -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" -d '{}'

# 2. get_weekly_coin_stats（091で追加）
curl -s -X POST "https://ujgbhkllfeacbgpdbjto.supabase.co/rest/v1/rpc/get_weekly_coin_stats" \
  -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"p_account_id":"16b70f53-db5d-4460-9453-3bcc5f4bc4f4"}'

# 3. check_spy_data_integrity（093で追加）
curl -s -X POST "https://ujgbhkllfeacbgpdbjto.supabase.co/rest/v1/rpc/check_spy_data_integrity" \
  -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" -d '{}'

# 4. get_session_list_v2（095で修正、型エラー解消）
curl -s -X POST "https://ujgbhkllfeacbgpdbjto.supabase.co/rest/v1/rpc/get_session_list_v2" \
  -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"p_account_id":"16b70f53-db5d-4460-9453-3bcc5f4bc4f4","p_cast_name":"hanshakun","p_limit":3}'

# 5. get_session_summary_v2（095で修正）
curl -s -X POST "https://ujgbhkllfeacbgpdbjto.supabase.co/rest/v1/rpc/get_session_summary_v2" \
  -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"p_account_id":"16b70f53-db5d-4460-9453-3bcc5f4bc4f4","p_session_id":"test"}'

# 6. get_transcript_timeline（095で修正）
curl -s -X POST "https://ujgbhkllfeacbgpdbjto.supabase.co/rest/v1/rpc/get_transcript_timeline" \
  -H "apikey: $SK" -H "Authorization: Bearer $SK" \
  -H "Content-Type: application/json" \
  -d '{"p_account_id":"16b70f53-db5d-4460-9453-3bcc5f4bc4f4","p_cast_name":"hanshakun","p_session_id":"test"}'
```

### ROLLBACK手順（万一の場合）
`apply_087_to_095.sql` 先頭のコメント参照（逆順実行）
