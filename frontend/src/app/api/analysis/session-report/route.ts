/**
 * POST /api/analysis/session-report
 * 配信終了時の自動分析レポート生成（Claude API）
 */
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { authenticateServiceRole } from '../../data/_lib/auth';
import { reportError } from '@/lib/error-handler';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export async function POST(request: NextRequest) {
  try {
    const auth = authenticateServiceRole(request);
    if (!auth.authenticated) return auth.error;

    if (!ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY が未設定です。frontend/.env.local に追加してください' },
        { status: 500 },
      );
    }

    const body = await request.json();
    const { cast_name, session_id, account_id } = body;

    if (!cast_name || !session_id) {
      return NextResponse.json(
        { error: 'cast_name と session_id は必須です' },
        { status: 400 },
      );
    }

    // 1. セッションデータ取得
    const { data: session, error: sessErr } = await auth.supabase
      .from('sessions')
      .select('*')
      .eq('session_id', session_id)
      .single();

    if (sessErr || !session) {
      return NextResponse.json(
        { error: 'セッションが見つかりません', detail: sessErr?.message },
        { status: 404 },
      );
    }

    // 2. チャットログ取得（上位100件）
    const { data: chatLogs } = await auth.supabase
      .from('chat_logs')
      .select('username, message, tokens, timestamp, is_tip')
      .eq('session_id', session_id)
      .order('timestamp', { ascending: false })
      .limit(100);

    // 3. コイントランザクション取得
    const sessionDate = session.started_at?.split('T')[0];
    const { data: coins } = await auth.supabase
      .from('coin_transactions')
      .select('tokens, type, username, date')
      .eq('cast_name', cast_name)
      .gte('date', sessionDate || '2026-01-01');

    // 4. 過去ナレッジ取得（最新5件）
    const { data: pastKnowledge } = await auth.supabase
      .from('cast_knowledge')
      .select('report_type, metrics_json, insights_json, created_at')
      .eq('account_id', account_id || session.account_id)
      .order('created_at', { ascending: false })
      .limit(5);

    // 5. Claude API で分析レポート生成
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const pastKnowledgeSummary = (pastKnowledge || [])
      .map((k) => `[${k.report_type} ${k.created_at}] ${JSON.stringify(k.metrics_json).slice(0, 500)}`)
      .join('\n');

    const userMessage = JSON.stringify({
      session,
      chat_logs_count: chatLogs?.length || 0,
      chat_logs_sample: (chatLogs || []).slice(0, 50),
      coin_transactions: coins || [],
      cast_name,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `あなたはライブ配信のアナリストです。以下のセッションデータを分析し、構造化JSONで出力してください。
分析項目:
- revenue_structure: 売上構造（チップvsチケット比率、平均単価、最大チップ額）
- session_pattern: 配信パターン（時間帯、持続時間、盛り上がりのピーク）
- audience_analysis: 客層分析（常連vs新規比率、言語分布、活発なユーザー）
- engagement_metrics: エンゲージメント（MSG頻度、チップ頻度、最も盛り上がった瞬間）
- improvement_suggestions: 改善提案（具体的なアクション3つ）
- comparison_with_past: 過去のナレッジとの比較（改善点・悪化点）

過去のナレッジ:
${pastKnowledgeSummary || 'なし'}

回答はJSON形式のみ。説明文は不要。`,
      messages: [{ role: 'user', content: userMessage }],
    });

    const reportText =
      response.content[0].type === 'text' ? response.content[0].text : '';

    let report: Record<string, unknown>;
    try {
      const jsonMatch = reportText.match(/\{[\s\S]*\}/);
      report = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: reportText };
    } catch {
      report = { raw: reportText };
    }

    // 6. cast_knowledge に保存
    const { data: inserted, error: insertErr } = await auth.supabase
      .from('cast_knowledge')
      .insert({
        account_id: account_id || session.account_id,
        report_type: 'session_report',
        period_start: session.started_at,
        period_end: session.ended_at,
        metrics_json: report,
        insights_json: {
          session_id,
          cast_name,
          generated_at: new Date().toISOString(),
        },
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[analysis/session-report] insert error:', insertErr);
    }

    return NextResponse.json({
      report,
      knowledge_id: inserted?.id || null,
    });
  } catch (err) {
    await reportError(err, {
      file: 'api/analysis/session-report',
      context: 'セッション分析レポート生成',
    });
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
