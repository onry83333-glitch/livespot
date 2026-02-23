// ============================================================
// POST /api/transcribe — OpenAI Whisper API で音声→文字起こし
//
// 必要な環境変数（.env.local に追加）:
//   OPENAI_API_KEY=sk-...
//   SUPABASE_SERVICE_ROLE_KEY=eyJhbG...  (service_role key, NOT anon key)
//
// Vercel デプロイ時:
//   Settings > Environment Variables に上記2つを追加すること
//   maxDuration=300 には Vercel Pro プランが必要（無料は10秒）
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 300; // 5min timeout (Vercel Pro)

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const audioFile = formData.get('audio') as File | null;
  const sessionId = formData.get('session_id') as string | null;
  const castName = formData.get('cast_name') as string | null;
  const accountId = formData.get('account_id') as string | null;
  const recordingStartedAt = formData.get('recording_started_at') as string | null;

  if (!audioFile || !sessionId || !castName || !accountId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Server-side file size check (Whisper API limit: 25MB)
  if (audioFile.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: 'ファイルサイズが大きすぎます（上限25MB）' }, { status: 413 });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Insert a processing placeholder
  const { data: record } = await supabase
    .from('cast_transcripts')
    .insert({
      account_id: accountId,
      cast_name: castName,
      session_id: sessionId,
      recording_started_at: recordingStartedAt || null,
      source_file: audioFile.name,
      processing_status: 'processing',
      text: '処理中...',
    })
    .select('id')
    .single();

  try {
    // Call OpenAI Whisper API
    const whisperForm = new FormData();
    whisperForm.append('file', audioFile);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('language', 'ja');
    whisperForm.append('response_format', 'verbose_json');
    whisperForm.append('timestamp_granularities[]', 'segment');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: whisperForm,
    });

    if (!whisperRes.ok) {
      const errBody = await whisperRes.text().catch(() => '');
      throw new Error(`Whisper API ${whisperRes.status}: ${errBody.slice(0, 200)}`);
    }

    const whisperData = await whisperRes.json();
    const segments: { start: number; end: number; text: string; avg_logprob?: number }[] =
      whisperData.segments || [];
    const recordingStart = recordingStartedAt ? new Date(recordingStartedAt) : null;

    const transcriptRows = segments.map(seg => ({
      account_id: accountId,
      cast_name: castName,
      session_id: sessionId,
      recording_started_at: recordingStartedAt || null,
      segment_start_seconds: seg.start,
      segment_end_seconds: seg.end,
      absolute_start_at: recordingStart
        ? new Date(recordingStart.getTime() + seg.start * 1000).toISOString()
        : null,
      absolute_end_at: recordingStart
        ? new Date(recordingStart.getTime() + seg.end * 1000).toISOString()
        : null,
      text: seg.text.trim(),
      language: whisperData.language || 'ja',
      confidence: seg.avg_logprob != null ? Math.exp(seg.avg_logprob) : null,
      source_file: audioFile.name,
      whisper_model: 'whisper-1',
      processing_status: 'completed' as const,
    }));

    // Remove the placeholder, insert segment rows
    if (record?.id) {
      await supabase.from('cast_transcripts').delete().eq('id', record.id);
    }
    if (transcriptRows.length > 0) {
      await supabase.from('cast_transcripts').insert(transcriptRows);
    }

    return NextResponse.json({
      success: true,
      segments: transcriptRows.length,
      duration: whisperData.duration,
      language: whisperData.language,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (record?.id) {
      await supabase
        .from('cast_transcripts')
        .update({ processing_status: 'failed', error_message: message })
        .eq('id', record.id);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
