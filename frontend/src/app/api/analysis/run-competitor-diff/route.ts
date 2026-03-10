/**
 * POST /api/analysis/run-competitor-diff
 * クライアントから直接呼べる競合差分分析エンドポイント
 * 内部で service_role を使うため、クライアントに鍵を露出させない
 */
import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, competitor_cast_name } = body;

    if (!cast_name || !competitor_cast_name) {
      return NextResponse.json(
        { error: 'cast_name と competitor_cast_name は必須です' },
        { status: 400 },
      );
    }

    // 内部APIを呼び出し（service_role key付き）
    const origin = request.nextUrl.origin;
    const res = await fetch(`${origin}/api/analysis/competitor-diff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ cast_name, competitor_cast_name }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
