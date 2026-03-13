/**
 * POST /api/analysis/run-fb-report
 * 配信FBレポート — 3エンジン分割アーキテクチャ
 *
 * Step 1 (デフォルト): collect5AxisData でデータ収集 → 3ブロック分割で返却
 *   - analysis_prompt: 分析エンジン用（集計数字のみ、軽量）
 *   - users_prompt: ユーザー分類エンジン用（ユーザー別取引情報）
 *   - dm_data: DM施策エンジン用（LLM不要、JSテンプレート用の構造化データ）
 * Step 'save': レポート結果を cast_knowledge に保存
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { collect5AxisData, buildUserPrompt, FiveAxisData } from '@/app/api/persona/engine/route';
import { extractDMData } from '@/lib/dm-report-generator';

export const maxDuration = 60;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * FiveAxisDataを3エンジン用に分割する
 * - analysis: 集計数字のみ（軸2-5, 8-10の数値サマリ）
 * - users: ユーザー別取引情報（軸1のリスト, 軸7のユーザー行動）
 * - dm: DM施策用構造化データ（軸1のリスト, 軸6全体）
 */
function splitFiveAxisData(fiveAxis: FiveAxisData, castName: string) {
  // --- Step 2a: 分析エンジン用（集計数字のみ、ユーザー名リスト除外） ---
  const analysisPrompt = buildUserPrompt('fb_report_analysis', {
    cast_name: castName,
    axis_summary: `### チップトリガー
${fiveAxis.tipTriggers || 'データなし'}

### チャット温度
${fiveAxis.chatTemperature || 'データなし'}

### 前回との差分
${fiveAxis.diffFromPrevious || 'データなし'}

### ベンチマーク
${fiveAxis.benchmark || 'データなし'}

### 配信品質測定
${fiveAxis.broadcastQuality || 'データなし'}

### リアルタイム推移
${fiveAxis.realtimeMetrics || 'データなし'}

### 他社突合
${fiveAxis.crossCompetitor || 'データなし'}`,
  });

  // --- Step 2b: ユーザー分類エンジン用（ユーザー別詳細） ---
  const usersPrompt = buildUserPrompt('fb_report_users', {
    cast_name: castName,
    user_classification: `### チッパー構造（ユーザー別）
${fiveAxis.tipperStructure || 'データなし'}

### ユーザー行動パターン
${fiveAxis.userBehavior || 'データなし'}`,
  });

  // --- Step 2c: DM施策エンジン用（構造化データ） ---
  const dmData = extractDMData({
    tipperStructure: fiveAxis.tipperStructure || '',
    dmActionLists: fiveAxis.dmActionLists || '',
    userBehavior: fiveAxis.userBehavior || '',
  });

  return { analysisPrompt, usersPrompt, dmData };
}

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
            architecture: '3-engine-split',
          },
          insights_json: {
            generated_by: 'fb_report_engine_v2',
            confidence: confidence || 0.85,
          },
        });
      }

      return NextResponse.json({ ok: true });
    }

    // ── Step 1 (デフォルト): データ収集 + 3ブロック分割 ──
    const t0 = Date.now();
    const fiveAxisData = await collect5AxisData(auth.token, cast_name, account_id, {});
    const t1 = Date.now();
    console.log(`[run-fb-report][Step1] collect5AxisData: ${t1 - t0}ms`);

    // 3エンジン用にデータ分割
    const { analysisPrompt, usersPrompt, dmData } = splitFiveAxisData(fiveAxisData, cast_name);
    console.log(`[run-fb-report][Step1] analysis_prompt: ${analysisPrompt.length} chars, users_prompt: ${usersPrompt.length} chars`);

    return NextResponse.json({
      status: 'data_ready',
      analysis_prompt: analysisPrompt,
      users_prompt: usersPrompt,
      dm_data: dmData,
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
