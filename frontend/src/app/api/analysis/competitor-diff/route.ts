/**
 * POST /api/analysis/competitor-diff
 * 競合差分分析レポート生成（Claude API）
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
    const { cast_name, competitor_cast_name } = body;

    if (!cast_name || !competitor_cast_name) {
      return NextResponse.json(
        { error: 'cast_name と competitor_cast_name は必須です' },
        { status: 400 },
      );
    }

    // 1. competitor_benchmarks で紐付け確認
    const { data: benchmark, error: benchErr } = await auth.supabase
      .from('competitor_benchmarks')
      .select('*')
      .eq('cast_name', cast_name)
      .eq('competitor_cast_name', competitor_cast_name)
      .single();

    if (benchErr || !benchmark) {
      return NextResponse.json(
        { error: '競合紐付けが見つかりません', detail: `${cast_name} ↔ ${competitor_cast_name}` },
        { status: 404 },
      );
    }

    // 2. 直近7日分のセッションデータ取得
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fromISO = sevenDaysAgo.toISOString();

    const [ownSessions, compSessions] = await Promise.all([
      auth.supabase
        .from('sessions')
        .select('session_id, started_at, ended_at, peak_viewers, total_tokens')
        .eq('cast_name', cast_name)
        .gte('started_at', fromISO)
        .order('started_at', { ascending: false }),
      auth.supabase
        .from('sessions')
        .select('session_id, started_at, ended_at, peak_viewers, total_tokens')
        .eq('cast_name', competitor_cast_name)
        .gte('started_at', fromISO)
        .order('started_at', { ascending: false }),
    ]);

    // 3. 最新ナレッジ取得
    const [ownKnowledge, compKnowledge] = await Promise.all([
      auth.supabase
        .from('cast_knowledge')
        .select('report_type, metrics_json, insights_json, created_at')
        .eq('account_id', '940e7248-1d73-4259-a538-56fdaea9d740')
        .order('created_at', { ascending: false })
        .limit(3),
      // 競合のナレッジは存在しない可能性があるが試行
      auth.supabase
        .from('cast_knowledge')
        .select('report_type, metrics_json, created_at')
        .eq('account_id', '940e7248-1d73-4259-a538-56fdaea9d740')
        .order('created_at', { ascending: false })
        .limit(3),
    ]);

    // 集計ヘルパー
    const aggregate = (sessions: typeof ownSessions.data) => {
      const list = sessions || [];
      let totalTokens = 0;
      let totalDur = 0;
      const hours: Record<number, number> = {};
      for (const s of list) {
        totalTokens += s.total_tokens || 0;
        if (s.started_at && s.ended_at) {
          totalDur +=
            (new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60000;
        }
        if (s.started_at) {
          const h = new Date(s.started_at).getUTCHours();
          hours[h] = (hours[h] || 0) + 1;
        }
      }
      return {
        session_count: list.length,
        total_tokens: totalTokens,
        avg_duration_min: list.length > 0 ? Math.round(totalDur / list.length) : 0,
        active_hours: hours,
      };
    };

    const ownData = {
      cast_name,
      category: benchmark.category,
      stats: aggregate(ownSessions.data),
      sessions: (ownSessions.data || []).slice(0, 10),
      knowledge: (ownKnowledge.data || []).slice(0, 2),
    };

    const competitorData = {
      cast_name: competitor_cast_name,
      category: benchmark.category,
      stats: aggregate(compSessions.data),
      sessions: (compSessions.data || []).slice(0, 10),
      knowledge: (compKnowledge.data || []).slice(0, 2),
    };

    // 4. Claude API で差分分析
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: `あなたはライブ配信の競合分析アナリストです。自社キャストと競合キャストのデータを比較し、以下を構造化JSONで出力してください。
分析項目:
- revenue_gap: 売上差分（金額・構造の違い）
- timing_gap: 配信時間帯の違い（競合が配信していない時間帯の特定）
- style_gap: 配信スタイルの違い（チャット頻度、インタラクション方法）
- audience_gap: 客層の違い
- actionable_insights: 具体的な打ち手3つ（「○○をすれば△△になる」形式）
- competitive_advantage: 自社キャストの強み
- competitive_weakness: 自社キャストの弱み

回答はJSON形式のみ。説明文は不要。`,
      messages: [
        {
          role: 'user',
          content: `自社キャスト:\n${JSON.stringify(ownData)}\n\n競合キャスト:\n${JSON.stringify(competitorData)}`,
        },
      ],
    });

    const reportText =
      response.content[0].type === 'text' ? response.content[0].text : '';

    let diffReport: Record<string, unknown>;
    try {
      const jsonMatch = reportText.match(/\{[\s\S]*\}/);
      diffReport = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: reportText };
    } catch {
      diffReport = { raw: reportText };
    }

    return NextResponse.json({ diff_report: diffReport });
  } catch (err) {
    await reportError(err, {
      file: 'api/analysis/competitor-diff',
      context: '競合差分分析',
    });
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
