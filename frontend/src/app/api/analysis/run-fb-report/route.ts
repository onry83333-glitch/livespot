/**
 * POST /api/analysis/run-fb-report
 * 配信FBレポート生成エンドポイント
 * エンジンAPIにfb_reportタスクを投げ、結果をcast_knowledgeに保存
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { POST as enginePOST } from '@/app/api/persona/engine/route';

export const maxDuration = 60;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, account_id } = body;

    if (!cast_name || !account_id) {
      return NextResponse.json(
        { error: 'cast_name, account_id は必須です' },
        { status: 400 },
      );
    }

    const authHeader = request.headers.get('authorization') || '';

    // engineのPOST関数を直接呼び出し（self-fetch廃止）
    const engineReq = new NextRequest('http://localhost/api/persona/engine', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        task_type: 'fb_report',
        cast_name,
        account_id,
        context: {},
      }),
    });

    const engineRes = await enginePOST(engineReq);
    const engineData = await engineRes.json();

    if (engineRes.status !== 200) {
      return NextResponse.json(engineData, { status: engineRes.status });
    }

    // cast_knowledgeに保存
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // cast_id を取得
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
          report_markdown: engineData.output,
          cost_tokens: engineData.cost_tokens,
          cost_usd: engineData.cost_usd,
          model: engineData.model,
          five_axis_collected: engineData.five_axis_collected,
          agents_used: engineData.agents_used,
        },
        insights_json: {
          generated_by: 'fb_report_engine',
          confidence: engineData.confidence,
        },
      });
    }

    return NextResponse.json({
      report_markdown: engineData.output,
      cost_tokens: engineData.cost_tokens,
      cost_usd: engineData.cost_usd,
      confidence: engineData.confidence,
    });
  } catch {
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/analysis/run-fb-report?action=feedback
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
