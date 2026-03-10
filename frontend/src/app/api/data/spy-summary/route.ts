/**
 * GET /api/data/spy-summary
 * AIペルソナエージェント用 — キャスト集計サマリー
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateServiceRole } from '../_lib/auth';
import { reportError } from '@/lib/error-handler';

const PERIOD_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export async function GET(request: NextRequest) {
  try {
    const auth = authenticateServiceRole(request);
    if (!auth.authenticated) return auth.error;

    const { searchParams } = new URL(request.url);
    const cast_name = searchParams.get('cast_name');
    const period = searchParams.get('period') || '30d';

    if (!cast_name) {
      return NextResponse.json(
        { error: 'cast_name は必須です' },
        { status: 400 },
      );
    }

    const days = PERIOD_DAYS[period];
    if (!days) {
      return NextResponse.json(
        { error: 'period は 7d / 30d / 90d のいずれかで指定してください' },
        { status: 400 },
      );
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    const fromISO = fromDate.toISOString();

    // 1. セッション集計
    const { data: sessions, error: sessErr } = await auth.supabase
      .from('sessions')
      .select('session_id, started_at, ended_at, peak_viewers')
      .eq('cast_name', cast_name)
      .gte('started_at', fromISO);

    if (sessErr) {
      console.error('[api/data/spy-summary] sessions error:', sessErr);
      return NextResponse.json(
        { error: 'セッション取得に失敗しました', detail: sessErr.message },
        { status: 500 },
      );
    }

    const totalSessions = sessions?.length || 0;
    let totalDurationMinutes = 0;
    let totalPeakViewers = 0;
    const hourCounts: Record<number, number> = {};

    for (const s of sessions || []) {
      if (s.started_at && s.ended_at) {
        const dur =
          (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) /
          60000;
        totalDurationMinutes += dur;
      }
      if (s.peak_viewers) totalPeakViewers += s.peak_viewers;
      if (s.started_at) {
        const hour = new Date(s.started_at).getUTCHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
    }

    const avgSessionDuration =
      totalSessions > 0
        ? Math.round(totalDurationMinutes / totalSessions)
        : 0;
    const avgViewers =
      totalSessions > 0
        ? Math.round(totalPeakViewers / totalSessions)
        : 0;

    // ピーク時間帯
    let peakHour = 0;
    let peakCount = 0;
    for (const [h, c] of Object.entries(hourCounts)) {
      if (c > peakCount) {
        peakHour = parseInt(h);
        peakCount = c;
      }
    }

    // 2. 収益集計（coin_transactions）
    const { data: coins, error: coinErr } = await auth.supabase
      .from('coin_transactions')
      .select('tokens, type')
      .eq('cast_name', cast_name)
      .gte('date', fromISO.split('T')[0]);

    if (coinErr) {
      console.error('[api/data/spy-summary] coins error:', coinErr);
      return NextResponse.json(
        { error: '収益データ取得に失敗しました', detail: coinErr.message },
        { status: 500 },
      );
    }

    let totalRevenue = 0;
    let tipCount = 0;
    let ticketCount = 0;

    for (const c of coins || []) {
      totalRevenue += c.tokens || 0;
      if (c.type === 'tip') tipCount++;
      if (c.type === 'ticket_show' || c.type === 'private' || c.type === 'group')
        ticketCount++;
    }

    const tipTicketRatio =
      tipCount + ticketCount > 0
        ? Math.round((tipCount / (tipCount + ticketCount)) * 100)
        : 0;

    return NextResponse.json({
      summary: {
        total_sessions: totalSessions,
        total_revenue: totalRevenue,
        avg_session_duration: avgSessionDuration,
        tip_ticket_ratio: tipTicketRatio,
        avg_viewers: avgViewers,
        peak_hour: peakHour,
        period,
        from_date: fromISO.split('T')[0],
      },
    });
  } catch (err) {
    await reportError(err, { file: 'api/data/spy-summary', context: 'キャスト集計サマリー' });
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
