/**
 * GET /api/data/sessions
 * AIペルソナエージェント用 — セッション一覧取得
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateServiceRole } from '../_lib/auth';
import { reportError } from '@/lib/error-handler';

export async function GET(request: NextRequest) {
  try {
    const auth = authenticateServiceRole(request);
    if (!auth.authenticated) return auth.error;

    const { searchParams } = new URL(request.url);
    const cast_name = searchParams.get('cast_name');
    const from_date = searchParams.get('from_date');
    const to_date = searchParams.get('to_date');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    if (!cast_name) {
      return NextResponse.json(
        { error: 'cast_name は必須です' },
        { status: 400 },
      );
    }

    if (isNaN(limit) || limit < 1 || limit > 500) {
      return NextResponse.json(
        { error: 'limit は 1〜500 の整数で指定してください' },
        { status: 400 },
      );
    }

    let query = auth.supabase
      .from('sessions')
      .select('*', { count: 'exact' })
      .eq('cast_name', cast_name)
      .order('started_at', { ascending: false })
      .limit(limit);

    if (from_date) query = query.gte('started_at', from_date);
    if (to_date) query = query.lte('started_at', to_date);

    const { data, count, error } = await query;

    if (error) {
      console.error('[api/data/sessions] DB error:', error);
      return NextResponse.json(
        { error: 'データ取得に失敗しました', detail: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      sessions: data || [],
      total_count: count || 0,
    });
  } catch (err) {
    await reportError(err, { file: 'api/data/sessions', context: 'セッション一覧取得' });
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
