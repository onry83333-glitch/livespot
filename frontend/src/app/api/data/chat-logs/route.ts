/**
 * GET /api/data/chat-logs
 * AIペルソナエージェント用 — チャットログ取得
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateServiceRole } from '../_lib/auth';
import { reportError } from '@/lib/error-handler';

export async function GET(request: NextRequest) {
  try {
    const auth = authenticateServiceRole(request);
    if (!auth.authenticated) return auth.error;

    const { searchParams } = new URL(request.url);
    const session_id = searchParams.get('session_id');
    const cast_name = searchParams.get('cast_name');
    const limit = parseInt(searchParams.get('limit') || '100', 10);

    if (!session_id && !cast_name) {
      return NextResponse.json(
        { error: 'session_id または cast_name が必要です' },
        { status: 400 },
      );
    }

    if (isNaN(limit) || limit < 1 || limit > 1000) {
      return NextResponse.json(
        { error: 'limit は 1〜1000 の整数で指定してください' },
        { status: 400 },
      );
    }

    let query = auth.supabase
      .from('chat_logs')
      .select('*', { count: 'exact' })
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (session_id) query = query.eq('session_id', session_id);
    if (cast_name) query = query.eq('cast_name', cast_name);

    const { data, count, error } = await query;

    if (error) {
      console.error('[api/data/chat-logs] DB error:', error);
      return NextResponse.json(
        { error: 'データ取得に失敗しました', detail: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      logs: data || [],
      total_count: count || 0,
    });
  } catch (err) {
    await reportError(err, { file: 'api/data/chat-logs', context: 'チャットログ取得' });
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
