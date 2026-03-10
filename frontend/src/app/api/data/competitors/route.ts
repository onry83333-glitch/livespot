/**
 * GET /api/data/competitors?cast_name=Risa_06
 * 競合キャスト一覧取得
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const cast_name = searchParams.get('cast_name');

    if (!cast_name) {
      return NextResponse.json(
        { error: 'cast_name は必須です' },
        { status: 400 },
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data, error } = await supabase
      .from('competitor_benchmarks')
      .select('competitor_cast_name, category')
      .eq('cast_name', cast_name)
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json(
        { error: '競合データ取得に失敗しました', detail: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ competitors: data || [] });
  } catch (err) {
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
