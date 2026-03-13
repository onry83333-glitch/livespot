/**
 * POST /api/analysis/run-fb-report
 * 配信FBレポート — 2リクエスト分離アーキテクチャ
 *
 * Step 1 (デフォルト): collect5AxisData でデータ収集 → user_prompt を返却
 * Step 'save': レポート結果を cast_knowledge に保存
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { collect5AxisData, buildUserPrompt } from '@/app/api/persona/engine/route';

export const maxDuration = 60;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, account_id, step } = body;

    if (!cast_name || !account_id) {
      return NextResponse.json(
        { error: 'cast_name, account_id は必須です' },
        { status: 400 },
      );
    }

    // 認証
    const auth = await authenticateAndValidateAccount(request, account_id);
    if (!auth.authenticated) return auth.error;

    // ── Step 'save': レポート保存 ──
    if (step === 'save') {
      const { report_markdown, cost_tokens, cost_usd, model, confidence } = body;
      if (!report_markdown) {
        return NextResponse.json({ error: 'report_markdown は必須です' }, { status: 400 });
      }

      const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const { data: castRow } = await sb
        .from('registered_casts')
        .select('id')
        .eq('cast_name', cast_name)
        .single();

      if (castRow) {
        await sb.from('cast_knowledge').insert({
          cast_id: castRow.id,
          account_id,
          report_type: 'session_report',
          period_start: new Date().toISOString(),
          metrics_json: {
            report_markdown,
            cost_tokens: cost_tokens || 0,
            cost_usd: cost_usd || 0,
            model: model || 'unknown',
            five_axis_collected: true,
            agents_used: 4,
          },
          insights_json: {
            generated_by: 'fb_report_engine',
            confidence: confidence || 0.85,
          },
        });
      }

      return NextResponse.json({ ok: true });
    }

    // ── Step 1 (デフォルト): データ収集のみ ──
    const t0 = Date.now();
    const fiveAxisData = await collect5AxisData(auth.token, cast_name, account_id, {});
    const t1 = Date.now();
    console.log(`[run-fb-report][Step1] collect5AxisData: ${t1 - t0}ms`);

    // user_prompt を構築
    const userPrompt = buildUserPrompt('fb_report', {
      five_axis: fiveAxisData,
      cast_name,
    });

    return NextResponse.json({
      status: 'data_ready',
      user_prompt: userPrompt,
      cast_name,
      account_id,
      collect_time_ms: t1 - t0,
    });
  } catch (e) {
    console.error('[run-fb-report] error:', e);
    return NextResponse.json(
      { error: `サーバーエラー: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/analysis/run-fb-report
 * フィードバック保存
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, report_markdown, score, account_id } = body;

    if (!cast_name || !report_markdown || score === undefined) {
      return NextResponse.json({ error: 'cast_name, report_markdown, score は必須' }, { status: 400 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    await sb.from('persona_feedback').insert({
      cast_name,
      task_type: 'fb_report',
      input_context: { account_id },
      output: report_markdown.slice(0, 5000),
      score: score > 0 ? 80 : 20,
      score_source: 'manual',
      metadata: { feedback_type: score > 0 ? 'thumbs_up' : 'thumbs_down' },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'フィードバック保存エラー' }, { status: 500 });
  }
}
