-- ============================================================
-- 087: sessions 重複セッション削除 + 再発防止UNIQUE制約
--
-- 問題: Collectorが3インスタンス同時起動した際、各インスタンスが
--       同一キャストに対して異なるsession_idでセッションを作成。
--       generateSessionId(castName, new Date().toISOString()) が
--       ミリ秒単位で異なるタイムスタンプを使うため、重複検出を
--       すり抜けて790件の空セッションが作成された。
--
-- 修正:
--   1. 空の重複セッション（total_messages=0 AND ended_at IS NULL）を削除
--   2. 部分ユニーク制約: 1キャスト1アカウントにつきアクティブセッションは1件のみ
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_sessions_one_active_per_cast;
--   -- 削除されたセッションは全て空データ（total_messages=0, ended_at IS NULL）
--   -- のため復元不要
-- ============================================================

BEGIN;

-- ステップ1: 削除対象の確認（ログ用）
-- 各重複グループ（同一cast_name + started_at分単位）から
-- total_messages > 0 OR ended_at IS NOT NULL のレコードを残し、
-- 空レコードを削除する

-- 重複グループ内の正規セッション（データあり）のsession_idを保護リストに
CREATE TEMP TABLE sessions_to_keep AS
WITH ranked AS (
  SELECT
    session_id,
    cast_name,
    account_id,
    started_at,
    ended_at,
    total_messages,
    ROW_NUMBER() OVER (
      PARTITION BY cast_name, account_id, date_trunc('minute', started_at)
      ORDER BY
        -- 優先順位: データありを最優先
        CASE WHEN total_messages > 0 OR ended_at IS NOT NULL THEN 0 ELSE 1 END,
        -- 同点なら最も古いものを残す
        started_at ASC
    ) AS rn
  FROM public.sessions
)
SELECT session_id FROM ranked WHERE rn = 1;

-- ステップ2: 保護リスト以外を削除
DELETE FROM public.sessions
WHERE session_id NOT IN (SELECT session_id FROM sessions_to_keep);

DROP TABLE sessions_to_keep;

-- ステップ3: 部分ユニーク制約
-- 1キャスト1アカウントにつきアクティブ（未終了）セッションは1件のみ
CREATE UNIQUE INDEX idx_sessions_one_active_per_cast
  ON public.sessions (cast_name, account_id)
  WHERE ended_at IS NULL;

-- PostgREST スキーマキャッシュをリロード
NOTIFY pgrst, 'reload schema';

COMMIT;
