// ============================================================
// POST /api/analyze-session — 配信AI分析（Phase 1: ルールベース）（認証必須）
//
// タイムラインデータ（spy_messages + cast_transcripts + coin_transactions）を
// 統合し、配信構成の分類・応援トリガー特定・フィードバック生成を行う。
// Phase 2でAnthropic API連携に拡張予定。
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';

export const maxDuration = 120;

interface TimelineEvent {
  event_time: string;
  event_type: string;
  user_name: string | null;
  text: string | null;
  tokens: number;
  metadata: Record<string, unknown>;
}

interface Trigger {
  transcript_text: string;
  time: string;
  tokens_after: number;
  users_who_paid: string[];
}

interface Phase {
  start: string;
  end: string;
  type: string;
  events: number;
  tokens: number;
}

export async function POST(request: NextRequest) {
  const { session_id, cast_name, account_id } = await request.json();

  if (!session_id || !cast_name || !account_id) {
    return NextResponse.json({ error: '必須フィールドが不足' }, { status: 400 });
  }

  // 認証 + account_id 検証
  const auth = await authenticateAndValidateAccount(request, account_id);
  if (!auth.authenticated) return auth.error;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // --- 1. セッションの時間範囲を特定 ---
  const { data: sessionMsgs } = await supabase
    .from('chat_logs')
    .select('timestamp')
    .eq('account_id', account_id)
    .eq('session_id', session_id)
    .order('timestamp', { ascending: true })
    .limit(1);

  const { data: sessionMsgsEnd } = await supabase
    .from('chat_logs')
    .select('timestamp')
    .eq('account_id', account_id)
    .eq('session_id', session_id)
    .order('timestamp', { ascending: false })
    .limit(1);

  if (!sessionMsgs?.length || !sessionMsgsEnd?.length) {
    return NextResponse.json({ error: 'セッションデータがありません' }, { status: 404 });
  }

  const sessionStart = sessionMsgs[0].timestamp;
  const sessionEnd = sessionMsgsEnd[0].timestamp;

  // --- 2. chat_logs 取得（チャット・チップ・入退室） ---
  const { data: rawSpyMessages } = await supabase
    .from('chat_logs')
    .select('timestamp, message_type, username, message, tokens, is_vip, metadata')
    .eq('account_id', account_id)
    .eq('session_id', session_id)
    .order('timestamp', { ascending: true })
    .limit(10000);
  const spyMessages = (rawSpyMessages || []).map(r => ({ message_time: r.timestamp, msg_type: r.message_type, user_name: r.username, message: r.message, tokens: r.tokens, is_vip: r.is_vip, metadata: r.metadata }));

  // --- 3. cast_transcripts 取得（文字起こし） ---
  const { data: transcripts } = await supabase
    .from('cast_transcripts')
    .select('absolute_start_at, segment_start_seconds, segment_end_seconds, text, confidence, recording_started_at')
    .eq('account_id', account_id)
    .eq('cast_name', cast_name)
    .eq('session_id', session_id)
    .eq('processing_status', 'completed')
    .order('segment_start_seconds', { ascending: true })
    .limit(5000);

  // --- 4. coin_transactions 取得（配信時間帯 ±マージン） ---
  const { data: coinTx } = await supabase
    .from('coin_transactions')
    .select('date, type, user_name, tokens')
    .eq('account_id', account_id)
    .or(`cast_name.eq.${cast_name},cast_name.is.null`)
    .gte('date', new Date(new Date(sessionStart).getTime() - 5 * 60000).toISOString())
    .lte('date', new Date(new Date(sessionEnd).getTime() + 30 * 60000).toISOString())
    .gt('tokens', 0)
    .order('date', { ascending: true })
    .limit(10000);

  // --- 5. タイムラインに統合 ---
  const timeline: TimelineEvent[] = [];

  // spy_messages → timeline
  for (const m of (spyMessages || [])) {
    timeline.push({
      event_time: m.message_time,
      event_type: m.msg_type,
      user_name: m.user_name,
      text: m.message,
      tokens: m.tokens || 0,
      metadata: { is_vip: m.is_vip },
    });
  }

  // transcripts → timeline
  for (const t of (transcripts || [])) {
    const eventTime = t.absolute_start_at
      || (t.recording_started_at && t.segment_start_seconds != null
        ? new Date(new Date(t.recording_started_at).getTime() + t.segment_start_seconds * 1000).toISOString()
        : null);
    if (eventTime) {
      timeline.push({
        event_time: eventTime,
        event_type: 'transcript',
        user_name: null,
        text: t.text,
        tokens: 0,
        metadata: { confidence: t.confidence },
      });
    }
  }

  // coin_transactions → timeline
  for (const c of (coinTx || [])) {
    timeline.push({
      event_time: c.date,
      event_type: c.type === 'tip' ? 'coin_tip' : `coin_${c.type}`,
      user_name: c.user_name,
      text: null,
      tokens: c.tokens,
      metadata: { source: 'coin_api' },
    });
  }

  // 時系列ソート
  timeline.sort((a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime());

  if (timeline.length === 0) {
    return NextResponse.json({ error: 'タイムラインデータがありません' }, { status: 404 });
  }

  // --- 6. ルールベース分析 ---
  const analysis = analyzeTimeline(timeline);

  return NextResponse.json({ success: true, analysis });
}

function analyzeTimeline(events: TimelineEvent[]) {
  const transcripts = events.filter(e => e.event_type === 'transcript');
  const tips = events.filter(e => e.event_type === 'tip' || e.event_type === 'gift' || e.event_type === 'coin_tip');
  const tickets = events.filter(e => e.event_type === 'coin_ticket' || e.event_type === 'ticket_show');
  const privates = events.filter(e => e.event_type === 'coin_private');
  const groups = events.filter(e => e.event_type === 'coin_group' || e.event_type === 'group_join');
  const enters = events.filter(e => e.event_type === 'enter');
  const chats = events.filter(e => e.event_type === 'chat');
  const allPaid = events.filter(e => e.tokens > 0);

  // 1. 配信構成の自動分類（10分バケット）
  const phases = classifyPhases(events);

  // 2. 応援トリガー発言の特定
  const triggers: Trigger[] = [];

  for (const tip of allPaid) {
    const tipTime = new Date(tip.event_time).getTime();
    // チップの前60秒〜直前のtranscriptを探す
    const nearbyTranscripts = transcripts.filter(t => {
      const tTime = new Date(t.event_time).getTime();
      return tTime >= tipTime - 60000 && tTime <= tipTime;
    });

    if (nearbyTranscripts.length > 0) {
      const closest = nearbyTranscripts[nearbyTranscripts.length - 1];
      const existing = triggers.find(t => t.transcript_text === closest.text);
      if (existing) {
        existing.tokens_after += tip.tokens;
        if (tip.user_name && !existing.users_who_paid.includes(tip.user_name)) {
          existing.users_who_paid.push(tip.user_name);
        }
      } else {
        triggers.push({
          transcript_text: closest.text || '',
          time: closest.event_time,
          tokens_after: tip.tokens,
          users_who_paid: tip.user_name ? [tip.user_name] : [],
        });
      }
    }
  }

  // 3. サマリー統計
  const totalTokens = allPaid.reduce((s, e) => s + e.tokens, 0);
  const tipTokens = tips.reduce((s, e) => s + e.tokens, 0);
  const ticketTokens = tickets.reduce((s, e) => s + e.tokens, 0);
  const privateTokens = privates.reduce((s, e) => s + e.tokens, 0);
  const groupTokens = groups.reduce((s, e) => s + e.tokens, 0);

  return {
    summary: {
      total_events: events.length,
      transcript_segments: transcripts.length,
      total_tips: tips.length,
      total_tickets: tickets.length,
      total_privates: privates.length,
      total_groups: groups.length,
      total_enters: enters.length,
      total_chats: chats.length,
      total_tokens: totalTokens,
      tip_tokens: tipTokens,
      ticket_tokens: ticketTokens,
      private_tokens: privateTokens,
      group_tokens: groupTokens,
    },
    triggers: triggers.sort((a, b) => b.tokens_after - a.tokens_after).slice(0, 10),
    phases,
    feedback: generateFeedback(transcripts, tips, tickets, privates, enters, totalTokens),
  };
}

function classifyPhases(events: TimelineEvent[]): Phase[] {
  if (events.length === 0) return [];

  const phases: Phase[] = [];
  const startTime = new Date(events[0].event_time).getTime();
  const endTime = new Date(events[events.length - 1].event_time).getTime();
  const bucketMs = 10 * 60 * 1000; // 10分バケット

  for (let t = startTime; t < endTime; t += bucketMs) {
    const bucketEnd = Math.min(t + bucketMs, endTime);
    const bucketEvents = events.filter(e => {
      const et = new Date(e.event_time).getTime();
      return et >= t && et < bucketEnd;
    });

    if (bucketEvents.length === 0) continue;

    const tokens = bucketEvents.reduce((s, e) => s + e.tokens, 0);
    const hasTicket = bucketEvents.some(e => e.event_type === 'coin_ticket' || e.event_type === 'ticket_show');
    const hasPrivate = bucketEvents.some(e => e.event_type === 'coin_private');
    const hasGroup = bucketEvents.some(e => e.event_type === 'coin_group' || e.event_type === 'group_join' || e.event_type === 'group_end');
    const tipDensity = bucketEvents.filter(e => e.tokens > 0).length;

    let phaseType = 'free_chat';
    if (hasTicket) phaseType = 'ticket_show';
    else if (hasPrivate) phaseType = 'private';
    else if (hasGroup) phaseType = 'group_show';
    else if (tipDensity >= 5) phaseType = 'tip_rush';
    else if (tokens > 0) phaseType = 'mixed';

    phases.push({
      start: new Date(t).toISOString(),
      end: new Date(bucketEnd).toISOString(),
      type: phaseType,
      events: bucketEvents.length,
      tokens,
    });
  }

  // 連続する同タイプのフェーズをマージ
  const merged: Phase[] = [];
  for (const phase of phases) {
    const last = merged[merged.length - 1];
    if (last && last.type === phase.type) {
      last.end = phase.end;
      last.events += phase.events;
      last.tokens += phase.tokens;
    } else {
      merged.push({ ...phase });
    }
  }

  return merged;
}

function generateFeedback(
  transcripts: TimelineEvent[],
  tips: TimelineEvent[],
  tickets: TimelineEvent[],
  privates: TimelineEvent[],
  enters: TimelineEvent[],
  totalTokens: number,
) {
  const points: string[] = [];

  if (transcripts.length === 0) {
    points.push('文字起こしデータがないため、発言分析が制限されています。録画をアップロードすると精度が向上します。');
  } else {
    points.push(`文字起こし${transcripts.length}セグメントを分析しました。`);
  }

  if (totalTokens > 0) {
    if (tickets.length > 0) {
      const ticketTokens = tickets.reduce((s, e) => s + e.tokens, 0);
      const ticketShare = (ticketTokens / totalTokens * 100).toFixed(0);
      points.push(`チケットショー売上比率: ${ticketShare}%（${tickets.length}回）`);
    }

    if (privates.length > 0) {
      const privateTokens = privates.reduce((s, e) => s + e.tokens, 0);
      const privateShare = (privateTokens / totalTokens * 100).toFixed(0);
      points.push(`プライベート売上比率: ${privateShare}%（${privates.length}回）`);
    }

    const tipTokens = tips.reduce((s, e) => s + e.tokens, 0);
    if (tipTokens > 0) {
      const tipShare = (tipTokens / totalTokens * 100).toFixed(0);
      points.push(`チップ売上比率: ${tipShare}%（${tips.length}回）`);
    }
  }

  if (tips.length > 0 && transcripts.length > 0) {
    points.push(`応援トリガー候補を検出しました。発言と応援の相関を確認してください。`);
  }

  if (enters.length > 0) {
    points.push(`入室イベント: ${enters.length}回`);
  }

  return points;
}
