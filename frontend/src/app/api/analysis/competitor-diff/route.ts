/**
 * POST /api/analysis/competitor-diff
 * 競合差分分析レポート生成（Claude API）
 * コアロジックは lib/competitor-diff-core.ts に分離
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateServiceRole } from '../../data/_lib/auth';
import { reportError } from '@/lib/error-handler';
import { competitorDiffCore } from '@/lib/competitor-diff-core';

export async function POST(request: NextRequest) {
  try {
    const auth = authenticateServiceRole(request);
    if (!auth.authenticated) return auth.error;

    const body = await request.json();
    const { cast_name, competitor_cast_name, account_id } = body;

    if (!cast_name || !competitor_cast_name || !account_id) {
      return NextResponse.json(
        { error: 'cast_name, competitor_cast_name, account_id は必須です' },
        { status: 400 },
      );
    }

    const result = await competitorDiffCore(auth.supabase, cast_name, competitor_cast_name, account_id);
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status || 500 });
    }
    return NextResponse.json({ diff_report: result.diff_report });
  } catch (err) {
    await reportError(err, {
      file: 'api/analysis/competitor-diff',
      context: '競合差分分析',
    });
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
