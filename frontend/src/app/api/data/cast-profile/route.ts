/**
 * GET /api/data/cast-profile
 * AIペルソナエージェント用 — キャストプロフィール取得
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

    if (!cast_name) {
      return NextResponse.json(
        { error: 'cast_name は必須です' },
        { status: 400 },
      );
    }

    // まず cast_profiles を検索
    const { data: profile, error: profileErr } = await auth.supabase
      .from('cast_profiles')
      .select('*')
      .eq('cast_name', cast_name)
      .single();

    if (profile && !profileErr) {
      return NextResponse.json({ profile });
    }

    // cast_profiles になければ spy_casts から基本情報を取得
    const { data: spyCast, error: spyErr } = await auth.supabase
      .from('spy_casts')
      .select('*')
      .eq('cast_name', cast_name)
      .single();

    if (spyErr || !spyCast) {
      return NextResponse.json(
        { error: 'キャストが見つかりません', detail: cast_name },
        { status: 404 },
      );
    }

    return NextResponse.json({ profile: spyCast });
  } catch (err) {
    await reportError(err, { file: 'api/data/cast-profile', context: 'キャストプロフィール取得' });
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
