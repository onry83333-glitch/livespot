-- ============================================================
-- 052: cast_transcripts — 配信録画の文字起こし結果
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cast_transcripts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    cast_name TEXT NOT NULL,
    session_id UUID,
    recording_started_at TIMESTAMPTZ,
    segment_start_seconds NUMERIC,
    segment_end_seconds NUMERIC,
    absolute_start_at TIMESTAMPTZ,
    absolute_end_at TIMESTAMPTZ,
    text TEXT NOT NULL,
    language TEXT DEFAULT 'ja',
    confidence NUMERIC,
    source_file TEXT,
    whisper_model TEXT DEFAULT 'whisper-1',
    processing_status TEXT DEFAULT 'pending'
        CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cast_transcripts_session
    ON public.cast_transcripts(account_id, session_id);
CREATE INDEX IF NOT EXISTS idx_cast_transcripts_cast
    ON public.cast_transcripts(account_id, cast_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cast_transcripts_status
    ON public.cast_transcripts(processing_status)
    WHERE processing_status IN ('pending', 'processing');

ALTER TABLE public.cast_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cast_transcripts_all" ON public.cast_transcripts
    FOR ALL USING (account_id IN (SELECT user_account_ids()));

COMMENT ON TABLE public.cast_transcripts
    IS 'Whisper API transcripts';
