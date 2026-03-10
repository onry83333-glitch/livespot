// ============================================================
// キャスト別 RAG Context Builder
// cast_knowledge の配信分析レポートを要約し、
// Engine API の System Prompt に注入するコンテキストを生成する
// ============================================================
import { SupabaseClient } from '@supabase/supabase-js';

export interface CastRAGContext {
  /** System Prompt に注入するテキストブロック（500トークン以内） */
  summary: string;
  /** 参照したcast_knowledgeのレコード数 */
  dataPoints: number;
  /** 最新レコードのcreated_at */
  lastUpdated: string;
}

interface KnowledgeRow {
  report_type: string;
  metrics_json: Record<string, unknown>;
  insights_json: Record<string, unknown>;
  created_at: string;
}

/**
 * cast_knowledge から直近のナレッジを取得し、
 * 500トークン以内のRAGコンテキストに圧縮する。
 *
 * データがない場合は summary: '' を返す（エラーにしない）。
 */
export async function buildCastRAGContext(
  castName: string,
  taskType: string,
  supabase: SupabaseClient,
): Promise<CastRAGContext> {
  const empty: CastRAGContext = { summary: '', dataPoints: 0, lastUpdated: '' };

  try {
    // ── Step 1: cast_name → cast_id 解決 ──
    const { data: castRow } = await supabase
      .from('registered_casts')
      .select('id')
      .eq('cast_name', castName)
      .single();

    if (!castRow) return empty;
    const castId = castRow.id;

    // ── Step 2: post_session + daily_briefing を直近3件ずつ取得 ──
    const { data: postSessions } = await supabase
      .from('cast_knowledge')
      .select('report_type, metrics_json, insights_json, created_at')
      .eq('cast_id', castId)
      .eq('report_type', 'post_session')
      .order('created_at', { ascending: false })
      .limit(3);

    const { data: dailyBriefings } = await supabase
      .from('cast_knowledge')
      .select('report_type, metrics_json, insights_json, created_at')
      .eq('cast_id', castId)
      .eq('report_type', 'daily_briefing')
      .order('created_at', { ascending: false })
      .limit(3);

    const allRows: KnowledgeRow[] = [
      ...((postSessions as KnowledgeRow[]) || []),
      ...((dailyBriefings as KnowledgeRow[]) || []),
    ];

    if (allRows.length === 0) return empty;

    // ── Step 3: 情報抽出・圧縮 ──
    const parts: string[] = [];

    // post_session からの抽出
    const sessions = (postSessions as KnowledgeRow[]) || [];
    if (sessions.length > 0) {
      // 配信分析サマリー
      const summaries = sessions
        .map(s => s.insights_json?.session_summary as string)
        .filter(Boolean)
        .slice(0, 2);
      if (summaries.length > 0) {
        parts.push(`直近の配信分析:\n${summaries.map(s => `- ${s}`).join('\n')}`);
      }

      // 改善ポイント抽出（next_session_tips）
      const tips: string[] = [];
      for (const s of sessions) {
        const sessionTips = s.insights_json?.next_session_tips;
        if (Array.isArray(sessionTips)) {
          tips.push(...sessionTips.map((t: unknown) => String(t)));
        }
      }
      if (tips.length > 0) {
        const uniqueTips = Array.from(new Set(tips)).slice(0, 3);
        parts.push(`改善ポイント:\n${uniqueTips.map(t => `- ${t}`).join('\n')}`);
      }

      // 売上パターン（metrics_json から）
      const revenueInfo: string[] = [];
      for (const s of sessions) {
        const m = s.metrics_json;
        if (m?.total_tips) {
          const duration = m.session_duration_minutes as number;
          const tips = m.total_tips as number;
          const speed = m.tip_speed_per_minute as number;
          if (duration && tips) {
            revenueInfo.push(`${duration}分配信で${tips}tk（${speed ? speed.toFixed(1) : '?'}tk/分）`);
          }
        }
      }
      if (revenueInfo.length > 0) {
        parts.push(`売上パターン:\n${revenueInfo.slice(0, 2).map(r => `- ${r}`).join('\n')}`);
      }

      // 視聴者傾向（tipper_analysis から客層特徴を抽出）
      const patterns: string[] = [];
      for (const s of sessions) {
        const analysis = s.insights_json?.tipper_analysis;
        if (Array.isArray(analysis)) {
          for (const a of analysis.slice(0, 3)) {
            const ta = a as Record<string, unknown>;
            if (ta.pattern && ta.motivation) {
              patterns.push(`${ta.pattern}: ${ta.motivation}`);
            }
          }
        }
      }
      if (patterns.length > 0) {
        const uniquePatterns = Array.from(new Set(patterns)).slice(0, 3);
        parts.push(`視聴者傾向:\n${uniquePatterns.map(p => `- ${p}`).join('\n')}`);
      }
    }

    // daily_briefing からの抽出
    const briefings = (dailyBriefings as KnowledgeRow[]) || [];
    if (briefings.length > 0) {
      const trends: string[] = [];
      for (const b of briefings) {
        const casts = b.metrics_json?.casts;
        if (Array.isArray(casts)) {
          for (const c of casts) {
            const cast = c as Record<string, unknown>;
            const trend = cast.trend_7d as Record<string, unknown> | undefined;
            if (trend?.tip_trend) {
              trends.push(`7日傾向: チップ${trend.tip_trend}、日平均${trend.avg_daily_tips || 0}tk`);
            }
          }
        }
      }
      if (trends.length > 0) {
        parts.push(`トレンド:\n${Array.from(new Set(trends)).slice(0, 2).map(t => `- ${t}`).join('\n')}`);
      }
    }

    if (parts.length === 0) return empty;

    // ── Step 4: 500トークン以内に制限（日本語1文字≒1.5トークン、333文字が目安） ──
    let summary = parts.join('\n\n');
    if (summary.length > 400) {
      summary = summary.slice(0, 397) + '…';
    }

    const lastUpdated = allRows
      .map(r => r.created_at)
      .sort()
      .reverse()[0] || '';

    console.log(`[RAG Context] cast=${castName} dataPoints=${allRows.length} chars=${summary.length}`);

    return {
      summary,
      dataPoints: allRows.length,
      lastUpdated,
    };
  } catch (err) {
    console.error('[RAG Context] Error building context:', err);
    return empty;
  }
}
