/**
 * POST /api/analysis/run-competitor-diff
 * クライアントから直接呼べる競合差分分析エンドポイント
 * competitor-diff のコアロジックを直接importして実行（self-fetch排除）
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { competitorDiffCore } from '@/lib/competitor-diff-core';

export const maxDuration = 60;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cast_name, competitor_cast_name, account_id } = body;

    if (!cast_name || !competitor_cast_name || !account_id) {
      return NextResponse.json(
        { error: 'cast_name, competitor_cast_name, account_id は必須です' },
        { status: 400 },
      );
    }

    const auth = await authenticateAndValidateAccount(request, account_id);
    if (!auth.authenticated) return auth.error;

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const result = await competitorDiffCore(sb, cast_name, competitor_cast_name, account_id);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status || 500 });
    }

    return NextResponse.json({ diff_report: result.diff_report });
  } catch (err) {
    return NextResponse.json(
      { error: 'サーバーエラー' },
      { status: 500 },
    );
  }
}
