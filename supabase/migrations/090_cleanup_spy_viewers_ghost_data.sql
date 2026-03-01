-- Migration 090: spy_viewers ゴーストデータ + user_name='unknown' クリーンアップ
--
-- 問題: Chrome拡張のcurrentSessionIdグローバルフォールバックにより、
--       spy_viewersに存在しないsession_idが記録された（sessionsテーブルに不在）
--       + 全レコードが user_name='unknown' で記録（APIレスポンスパース問題）
--
-- ROLLBACK手順:
--   この削除は不可逆。spy_viewersの既存データ(24件)は全てゴーストデータのため復元不要。
--   必要に応じて Chrome拡張 + Collector が正常データを再収集する。

BEGIN;

-- 1. sessionsテーブルに存在しないsession_idを持つspy_viewersレコードを削除
DELETE FROM public.spy_viewers
WHERE session_id IS NOT NULL
  AND session_id NOT IN (SELECT session_id FROM public.sessions WHERE session_id IS NOT NULL);

-- 2. user_name='unknown' のレコードを削除（正常な視聴者データではない）
DELETE FROM public.spy_viewers
WHERE user_name = 'unknown';

-- 3. spy_viewers にNOT NULL制約追加（user_name が空文字やunknownにならないよう）
ALTER TABLE public.spy_viewers
  ADD CONSTRAINT chk_spy_viewers_user_name
  CHECK (user_name <> '' AND user_name <> 'unknown');

COMMIT;
