/**
 * GET /api/data/snapshots
 * AIペルソナエージェント用 — キャストスナップショット取得
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
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    if (!cast_name) {
      return NextResponse.json(
        { error: 'cast_name は必須です' },
        { status: 400 },
      );
    }

    if (isNaN(limit) || limit < 1 || limit > 200) {
      return NextResponse.json(
        { error: 'limit は 1〜200 の整数で指定してください' },
        { status: 400 },
      );
    }

    const { data, error } = await auth.supabase
      .from('cast_snapshots')
      .select('*')
      .eq('cast_name', cast_name)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[api/data/snapshots] DB error:', error);
      return NextResponse.json(
        { error: 'データ取得に失敗しました', detail: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      snapshots: data || [],
    });
  } catch (err) {
    await reportError(err, { file: 'api/data/snapshots', context: 'スナップショット取得' });
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
