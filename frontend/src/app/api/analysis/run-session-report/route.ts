/**
 * POST /api/analysis/run-session-report
 * クライアントから呼べる総合分析レポートエンドポイント
 * 内部で service_role を使うため、クライアントに鍵を露出させない
 */
import { NextRequest, NextResponse } from 'next/server';

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, session_id, account_id } = body;

    if (!cast_name || !session_id || !account_id) {
      return NextResponse.json(
        { error: 'cast_name, session_id, account_id は必須です' },
        { status: 400 },
      );
    }

    const origin = request.nextUrl.origin;
    const res = await fetch(`${origin}/api/analysis/session-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ cast_name, session_id, account_id }),
    });

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
