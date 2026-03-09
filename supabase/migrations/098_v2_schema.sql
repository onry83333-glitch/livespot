-- Migration 098: SLS v2 Phase 3 — 新テーブルスキーマ
-- 目的: spy_messages/spy_viewers/paid_users の v2 後継テーブルを作成
-- 旧テーブルはそのまま残す（並行運用）
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.user_profiles CASCADE;
--   DROP TABLE IF EXISTS public.viewer_snapshots CASCADE;
--   DROP TABLE IF EXISTS public.chat_logs CASCADE;
--   ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS uq_sessions_cast_account_started;
--   ALTER TABLE public.sessions ALTER COLUMN cast_name DROP NOT NULL;

-- ============================================================
-- 0. sessions テーブル補強
-- ============================================================

-- cast_name を NOT NULL に変更（既存NULLを先に埋める）
UPDATE public.sessions SET cast_name = 'unknown' WHERE cast_name IS NULL;
ALTER TABLE public.sessions ALTER COLUMN cast_name SET NOT NULL;

-- UNIQUE(cast_name, account_id, started_at) 追加
-- 同一キャスト・同一アカウント・同一開始時刻のセッション重複を防止
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_sessions_cast_account_started'
  ) THEN
    ALTER TABLE public.sessions
      ADD CONSTRAINT uq_sessions_cast_account_started
      UNIQUE (cast_name, account_id, started_at);
  END IF;
END $$;

-- ============================================================
-- 1. chat_logs — spy_messages の v2 後継
-- ============================================================
CREATE TABLE IF NOT EXISTS public.chat_logs (
  id            BIGSERIAL PRIMARY KEY,
  cast_name     TEXT        NOT NULL,
  account_id    UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  session_id    TEXT        REFERENCES public.sessions(session_id) ON DELETE SET NULL,
  username      TEXT        NOT NULL,
  message       TEXT        NOT NULL DEFAULT '',
  message_type  TEXT        NOT NULL DEFAULT 'chat',
  tokens        BIGINT      NOT NULL DEFAULT 0,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_chat_logs_account_cast
  ON public.chat_logs (account_id, cast_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_chat_logs_session
  ON public.chat_logs (session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_logs_username
  ON public.chat_logs (account_id, username);
CREATE INDEX IF NOT EXISTS idx_chat_logs_type
  ON public.chat_logs (account_id, message_type)
  WHERE message_type != 'chat';

-- RLS
ALTER TABLE public.chat_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_logs_select ON public.chat_logs
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY chat_logs_insert ON public.chat_logs
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY chat_logs_update ON public.chat_logs
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY chat_logs_delete ON public.chat_logs
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- ============================================================
-- 2. viewer_snapshots — spy_viewers / viewer_stats の v2 後継
-- ============================================================
CREATE TABLE IF NOT EXISTS public.viewer_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  cast_name     TEXT        NOT NULL,
  account_id    UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  session_id    TEXT        REFERENCES public.sessions(session_id) ON DELETE SET NULL,
  snapshot_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  viewer_count  INTEGER     NOT NULL DEFAULT 0,
  viewers       JSONB       NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- viewers JSONB 形式:
-- [
--   {"username": "user1", "is_registered": true, "level": 42, "league": "gold"},
--   {"username": "user2", "is_registered": false}
-- ]

-- インデックス
CREATE INDEX IF NOT EXISTS idx_viewer_snapshots_account_cast
  ON public.viewer_snapshots (account_id, cast_name, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_viewer_snapshots_session
  ON public.viewer_snapshots (session_id, snapshot_at);

-- RLS
ALTER TABLE public.viewer_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY viewer_snapshots_select ON public.viewer_snapshots
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY viewer_snapshots_insert ON public.viewer_snapshots
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY viewer_snapshots_update ON public.viewer_snapshots
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY viewer_snapshots_delete ON public.viewer_snapshots
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- ============================================================
-- 3. user_profiles — paid_users の v2 後継
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cast_name          TEXT        NOT NULL,
  account_id         UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  username           TEXT        NOT NULL,
  first_seen         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_tokens       BIGINT      NOT NULL DEFAULT 0,
  visit_count        INTEGER     NOT NULL DEFAULT 0,
  segment            TEXT,
  segment_updated_at TIMESTAMPTZ,
  metadata           JSONB       NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 同一アカウント内でキャスト×ユーザー名はユニーク
  CONSTRAINT uq_user_profiles_account_cast_user
    UNIQUE (account_id, cast_name, username)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_user_profiles_cast
  ON public.user_profiles (account_id, cast_name);
CREATE INDEX IF NOT EXISTS idx_user_profiles_segment
  ON public.user_profiles (account_id, cast_name, segment)
  WHERE segment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_profiles_tokens
  ON public.user_profiles (account_id, cast_name, total_tokens DESC);

-- RLS
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_profiles_select ON public.user_profiles
  FOR SELECT USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY user_profiles_insert ON public.user_profiles
  FOR INSERT WITH CHECK (account_id IN (SELECT user_account_ids()));

CREATE POLICY user_profiles_update ON public.user_profiles
  FOR UPDATE USING (account_id IN (SELECT user_account_ids()));

CREATE POLICY user_profiles_delete ON public.user_profiles
  FOR DELETE USING (account_id IN (SELECT user_account_ids()));

-- ============================================================
-- 4. updated_at 自動更新トリガー（user_profiles用）
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_user_profiles_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_user_profiles_updated_at();

-- ============================================================
-- 5. Realtime 有効化（chat_logs のみ — リアルタイム表示用）
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_logs;
  END IF;
END $$;

-- ============================================================
-- 完了通知
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE 'Migration 098 完了: chat_logs, viewer_snapshots, user_profiles 作成済み';
  RAISE NOTICE 'sessions.cast_name NOT NULL化 + UNIQUE(cast_name, account_id, started_at) 追加済み';
END $$;
