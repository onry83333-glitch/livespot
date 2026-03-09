import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';

// ============================================================
// /api/persona/feedback
// 統一エンジンの生成結果+実績データを persona_feedback に記録
// ============================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

type FeedbackTaskType = 'dm' | 'x_post' | 'recruitment' | 'content';

interface FeedbackBody {
  cast_name: string;
  task_type: FeedbackTaskType;
  input_context?: Record<string, unknown>;
  output: string;
  score?: number;
  score_source?: 'auto' | 'manual';
  metadata?: Record<string, unknown>;
  account_id?: string;
}

function getAuthClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

const VALID_TASK_TYPES: FeedbackTaskType[] = ['dm', 'x_post', 'recruitment', 'content'];

// ============================================================
// POST /api/persona/feedback — フィードバック記録
// ============================================================
export async function POST(req: NextRequest) {
  const body = await req.json() as FeedbackBody;
  const { cast_name, task_type, input_context, output, score, score_source, metadata, account_id } = body;

  // バリデーション
  if (!cast_name || !task_type || !output) {
    return NextResponse.json(
      { error: 'cast_name, task_type, output は必須です' },
      { status: 400 },
    );
  }
  if (!VALID_TASK_TYPES.includes(task_type)) {
    return NextResponse.json(
      { error: `未対応のtask_type: ${task_type}。対応: ${VALID_TASK_TYPES.join(', ')}` },
      { status: 400 },
    );
  }
  if (score !== undefined && (score < 0 || score > 100)) {
    return NextResponse.json(
      { error: 'score は 0〜100 の範囲で指定してください' },
      { status: 400 },
    );
  }
  if (score_source && !['auto', 'manual'].includes(score_source)) {
    return NextResponse.json(
      { error: 'score_source は auto または manual を指定してください' },
      { status: 400 },
    );
  }

  // 認証
  const auth = await authenticateAndValidateAccount(req, account_id || null);
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);

    const { data, error } = await sb
      .from('persona_feedback')
      .insert({
        cast_name,
        task_type,
        input_context: input_context || {},
        output,
        score: score ?? null,
        score_source: score_source ?? null,
        metadata: metadata || {},
      })
      .select('id, created_at')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      feedback_id: data.id,
      created_at: data.created_at,
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/persona/feedback', context: 'フィードバック記録' });
    return NextResponse.json(
      { error: err.message || 'フィードバック記録エラー' },
      { status: 500 },
    );
  }
}

// ============================================================
// GET /api/persona/feedback?cast_name=xxx&task_type=yyy&limit=10
// フィードバック一覧取得
// ============================================================
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const castName = searchParams.get('cast_name');
  const taskType = searchParams.get('task_type') as FeedbackTaskType | null;
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);
  const minScore = parseFloat(searchParams.get('min_score') || '0');

  if (!castName) {
    return NextResponse.json({ error: 'cast_name は必須です' }, { status: 400 });
  }

  const auth = await authenticateAndValidateAccount(req, searchParams.get('account_id'));
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);

    let query = sb
      .from('persona_feedback')
      .select('id, cast_name, task_type, output, score, score_source, metadata, created_at')
      .eq('cast_name', castName)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (taskType && VALID_TASK_TYPES.includes(taskType)) {
      query = query.eq('task_type', taskType);
    }
    if (minScore > 0) {
      query = query.gte('score', minScore);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ feedback: data || [], count: data?.length || 0 });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/persona/feedback', context: 'フィードバック取得' });
    return NextResponse.json(
      { error: err.message || 'フィードバック取得エラー' },
      { status: 500 },
    );
  }
}
