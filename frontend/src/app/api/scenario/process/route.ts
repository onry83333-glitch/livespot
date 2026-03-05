import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { processScenarioQueue } from '@/lib/scenario-engine';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * POST /api/scenario/process
 * シナリオキュー処理: 期日到来のエンロールメントのDMをキューに登録
 * body: { account_id: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const accountId = body.account_id as string;

  if (!accountId) {
    return NextResponse.json({ error: 'account_id は必須です' }, { status: 400 });
  }

  const auth = await authenticateAndValidateAccount(req, accountId);
  if (!auth.authenticated) return auth.error;

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.token}` } },
  });

  // baseUrl を自動解決（リクエストのorigin）
  const url = new URL(req.url);
  const baseUrl = url.origin;

  const result = await processScenarioQueue(supabase, accountId, {
    baseUrl,
    token: auth.token,
  });

  return NextResponse.json({
    success: true,
    ...result,
  });
}
