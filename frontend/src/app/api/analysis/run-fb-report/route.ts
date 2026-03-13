/**
 * POST /api/analysis/run-fb-report
 * 配信FBレポート — 4エンジン分割アーキテクチャ
 *
 * Step 1 (デフォルト): collect5AxisData でデータ収集 → 4ブロック分割で返却
 *   - analysis_prompt: 分析エンジン用（集計数字のみ、軽量）
 *   - new_users_prompt: 新規チッパー分析エンジン用
 *   - repeaters_prompt: リピーター・復帰ユーザー分析エンジン用
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
 * リピーターリストをLLM用に圧縮する
 * Top10(今回tk上位) + エスカレーション変動率Top5 + 復帰・離脱は別途渡すので除外
 * 全員リストはStep 2d（DM施策JS）が出力する
 */
function compressRepeatersForLLM(repeaterSection: string, escSection: string): string {
  // リピーターセクションから個別行を抽出 (numbered: "1. username: 100tk (3回) [...]")
  const lineRegex = /^\d+\.\s+(\S+):\s+(\d+)tk\s+\((\d+)回\)\s*(.*)/gm;
  const allRepeaters: Array<{ line: string; username: string; tk: number; count: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(repeaterSection)) !== null) {
    allRepeaters.push({ line: m[0], username: m[1], tk: parseInt(m[2]), count: parseInt(m[3]) });
  }

  if (allRepeaters.length <= 15) {
    // 15人以下ならそのまま返す
    return repeaterSection + '\n\n' + escSection;
  }

  // Top10: 今回tk上位
  const top10 = allRepeaters.slice(0, 10); // already sorted by tk desc in original

  // エスカレーション変動率Top5: escSectionから抽出
  const escNames = new Set<string>();
  const escLineRegex = /- (\S+)[\s:]+\d+\s*→\s*\d+/g;
  while ((m = escLineRegex.exec(escSection)) !== null) {
    escNames.add(m[1]);
  }
  const top10Names = new Set(top10.map(r => r.username));
  const escTop5 = allRepeaters
    .filter(r => escNames.has(r.username) && !top10Names.has(r.username))
    .slice(0, 5);

  // 結合（重複排除済み）
  const selectedNames = new Set([...top10.map(r => r.username), ...escTop5.map(r => r.username)]);
  const selectedLines = allRepeaters
    .filter(r => selectedNames.has(r.username))
    .map((r, i) => `${i + 1}. ${r.username}: ${r.tk}tk (${r.count}回) ${r.line.match(/\[.*\]/)?.[0] || ''}`);

  // ヘッダー抽出（## リピーター（123人）の行）
  const header = repeaterSection.match(/## リピーター（\d+人）/)?.[0] || '## リピーター';

  return `${header}
[注意] LLM分析用に注目${selectedLines.length}人に圧縮。全${allRepeaters.length}人のリストはDM施策セクションに掲載。

### 今回tk上位10人
${top10.map((r, i) => `${i + 1}. ${r.username}: ${r.tk}tk (${r.count}回) ${r.line.match(/\[.*\]/)?.[0] || ''}`).join('\n')}

### 課金変動注目5人（エスカレーション変動率Top）
${escTop5.length > 0 ? escTop5.map((r, i) => `${i + 1}. ${r.username}: ${r.tk}tk (${r.count}回) ${r.line.match(/\[.*\]/)?.[0] || ''}`).join('\n') : '(該当なし)'}

${escSection}`;
}

/**
 * FiveAxisDataを4エンジン用に分割する
 * - analysis: 集計数字のみ（軸2-5, 8-10の数値サマリ）
 * - newUsers: 新規チッパー関連データ（軸1の新規セクション）
 * - repeaters: リピーター+復帰ユーザー関連データ（軸1のリピーター+軸7のエスカレーション）
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

  // --- tipperStructure を新規 / リピーター+復帰 に分割 ---
  const ts = fiveAxis.tipperStructure || '';
  const ub = fiveAxis.userBehavior || '';

  // 新規チッパーセクション抽出
  const newTipperSection = ts.match(/## 新規チッパー[\s\S]*?(?=## リピーター|## 復帰|## 🚩|## DM|$)/)?.[0] || '';
  const highValueSection = ts.match(/## 高額新規[\s\S]*?(?=## リピーター|## 復帰|## 🚩|## DM|$)/)?.[0] || '';
  // セッション概要（冒頭の集計情報）は両方に渡す
  const summarySection = ts.match(/^[\s\S]*?(?=## 新規|## リピーター)/)?.[0] || '';

  // リピーター・復帰・離脱警告セクション抽出
  const repeaterSection = ts.match(/## リピーター[\s\S]*?(?=## 復帰|## 🚩|## DM|## 高額新規|$)/)?.[0] || '';
  const returnSection = ts.match(/## 復帰ユーザー[\s\S]*?(?=## 🚩|## DM|$)/)?.[0] || '';
  const churnSection = ts.match(/🚩 離脱警告[\s\S]*?(?=## DM|$)/)?.[0] || '';
  const prioritySection = ts.match(/🔴 優先度[\s\S]*$/)?.[0] || '';

  // ユーザー行動パターンから課金エスカレーション・リテンション抽出
  const escSection = ub.match(/## #3 課金エスカレーション[\s\S]*?(?=## #4|$)/)?.[0] || '';
  const retentionSection = ub.match(/## #1 セッション間リテンション[\s\S]*?(?=## #2|$)/)?.[0] || '';
  const intervalSection = ub.match(/## #2 来訪間隔パターン[\s\S]*?(?=## #3|$)/)?.[0] || '';
  const typeSection = ub.match(/## #4 課金タイプ変遷[\s\S]*$/)?.[0] || '';
  // #5新規獲得率は新規エンジンに渡す
  const newAcqSection = ub.match(/## #5 セッション別新規獲得率[\s\S]*?(?=## #6|$)/)?.[0] || '';

  // --- Step 2b: 新規チッパー分析エンジン用 ---
  const newUsersPrompt = buildUserPrompt('fb_report_new_users', {
    cast_name: castName,
    new_users_data: `${summarySection}
${newTipperSection}
${highValueSection}
${newAcqSection}`.trim(),
  });

  // --- Step 2c: リピーター・復帰ユーザー分析エンジン用（注目ユーザーのみ） ---
  // LLMにはTop15 + 復帰全員 + 離脱予兆全員だけ渡す（全員リストはStep 2dが出力）
  const compressedRepeaterSection = compressRepeatersForLLM(repeaterSection, escSection);

  const repeatersPrompt = buildUserPrompt('fb_report_repeaters', {
    cast_name: castName,
    repeater_data: `${summarySection}
${compressedRepeaterSection}
${returnSection}
${churnSection}
${prioritySection}
${retentionSection}
${intervalSection}
${typeSection}`.trim(),
  });

  // --- Step 2d: DM施策エンジン用（構造化データ） ---
  const dmData = extractDMData({
    tipperStructure: fiveAxis.tipperStructure || '',
    dmActionLists: fiveAxis.dmActionLists || '',
    userBehavior: fiveAxis.userBehavior || '',
  });

  return { analysisPrompt, newUsersPrompt, repeatersPrompt, dmData };
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

    // 4エンジン用にデータ分割
    const { analysisPrompt, newUsersPrompt, repeatersPrompt, dmData } = splitFiveAxisData(fiveAxisData, cast_name);
    console.log(`[run-fb-report][Step1] analysis: ${analysisPrompt.length} chars, new_users: ${newUsersPrompt.length} chars, repeaters: ${repeatersPrompt.length} chars`);

    return NextResponse.json({
      status: 'data_ready',
      analysis_prompt: analysisPrompt,
      new_users_prompt: newUsersPrompt,
      repeaters_prompt: repeatersPrompt,
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
