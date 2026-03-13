/**
 * POST /api/analysis/batch-session-snapshots
 * 全セッションの新規/リピーター/復帰データを一括計算し cast_knowledge に保存
 *
 * - get_coin_sessions で全セッション取得
 * - 既に保存済みのセッションはスキップ
 * - 各セッションに対して classifyTippers を呼び出し
 * - 結果を cast_knowledge に session_snapshot として INSERT
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { classifyTippers } from '@/app/api/persona/engine/route';

export const maxDuration = 300; // バッチ処理のため5分

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, account_id } = body;

    if (!cast_name || !account_id) {
      return NextResponse.json({ error: 'cast_name, account_id は必須です' }, { status: 400 });
    }

    const auth = await authenticateAndValidateAccount(request, account_id);
    if (!auth.authenticated) return auth.error;

    const userSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${auth.token}` } },
    });
    const serviceSb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1. 全セッション取得
    const { data: sessions, error: sessErr } = await userSb.rpc('get_coin_sessions', {
      p_account_id: account_id,
      p_cast_name: cast_name,
      p_limit: 50,
    });
    if (sessErr || !sessions) {
      return NextResponse.json({ error: `セッション取得失敗: ${sessErr?.message}` }, { status: 500 });
    }

    // 2. cast_id 取得
    const { data: castRow } = await serviceSb
      .from('registered_casts')
      .select('id')
      .eq('cast_name', cast_name)
      .single();
    if (!castRow) {
      return NextResponse.json({ error: `キャスト未登録: ${cast_name}` }, { status: 404 });
    }
    const castId = castRow.id;

    // 3. 既に保存済みのセッション開始時刻を取得
    const { data: existingRows } = await serviceSb
      .from('cast_knowledge')
      .select('period_start')
      .eq('cast_id', castId)
      .eq('report_type', 'session_snapshot');
    const existingStarts = new Set(
      (existingRows || []).map(r => new Date(r.period_start).toISOString())
    );

    // 4. 未保存セッションだけ処理（古い順から）
    const toProcess = sessions
      .filter((s: { session_start: string }) => !existingStarts.has(new Date(s.session_start).toISOString()))
      .reverse(); // oldest first

    const results: Array<{ session_start: string; status: string }> = [];

    for (const session of toProcess) {
      const sessionStart = session.session_start as string;
      const sessionEnd = session.session_end as string;
      const totalTk = session.total_tokens as number;
      const txCount = session.tx_count as number;
      const durationMin = session.duration_minutes as number;
      const topUsers = (session.top_users || []) as Array<{ username: string; total: number; count: number }>;

      // セッション内の全チッパーを取得
      const { data: txRows } = await userSb
        .from('coin_transactions')
        .select('user_name, tokens')
        .eq('account_id', account_id)
        .eq('cast_name', cast_name)
        .gte('date', sessionStart)
        .lte('date', sessionEnd)
        .gt('tokens', 0);

      // チッパー別集計
      const tipperMap = new Map<string, { total: number; count: number }>();
      for (const row of txRows || []) {
        const name = row.user_name || '';
        if (!name || name === 'anonymous') continue;
        const existing = tipperMap.get(name) || { total: 0, count: 0 };
        existing.total += row.tokens;
        existing.count++;
        tipperMap.set(name, existing);
      }

      const tippers = Array.from(tipperMap.entries())
        .map(([username, data]) => ({ username, total: data.total, count: data.count }))
        .sort((a, b) => b.total - a.total);

      // classifyTippers で分類
      const classified = await classifyTippers(userSb, account_id, cast_name, sessionStart, tippers);

      // cast_knowledge に保存
      const content = {
        sessionStart,
        sessionEnd,
        totalTk,
        durationMin,
        txCount,
        tipperCount: tippers.length,
        newCount: classified.newTippers.length,
        repeaterCount: classified.repeaters.length,
        comebackCount: classified.comebackUsers.length,
        newTippers: classified.newTippers.map(t => ({
          userName: t.username, currentTk: t.tk, txCount: t.count,
        })),
        repeaters: classified.repeaters.map(r => ({
          userName: r.username, currentTk: r.tk,
          firstDate: r.firstTipDate, totalTk: r.totalTk,
          lastDate: r.lastTipDate, daysSince: r.daysSince,
        })),
        comebackUsers: classified.comebackUsers.map(u => ({
          userName: u.username, currentTk: u.tk,
          firstDate: u.firstTipDate, lastDate: u.lastTipDate,
          daysSince: u.daysSince,
        })),
      };

      const { error: insertErr } = await serviceSb.from('cast_knowledge').insert({
        cast_id: castId,
        account_id,
        report_type: 'session_snapshot',
        period_start: sessionStart,
        period_end: sessionEnd,
        metrics_json: {
          session_start: sessionStart,
          total_tk: totalTk,
          tipper_count: tippers.length,
          new_count: classified.newTippers.length,
          repeater_count: classified.repeaters.length,
          comeback_count: classified.comebackUsers.length,
        },
        insights_json: content,
      });

      if (insertErr) {
        console.error(`[batch-snapshots] INSERT error for ${sessionStart}:`, insertErr.message);
        results.push({ session_start: sessionStart, status: `error: ${insertErr.message}` });
      } else {
        results.push({ session_start: sessionStart, status: 'saved' });
      }
    }

    return NextResponse.json({
      total_sessions: sessions.length,
      already_saved: existingStarts.size,
      processed: results.length,
      results,
    });
  } catch (e) {
    console.error('[batch-snapshots] error:', e);
    return NextResponse.json(
      { error: `サーバーエラー: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
