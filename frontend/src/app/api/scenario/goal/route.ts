import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { checkGoalReached } from '@/lib/scenario-engine';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * POST /api/scenario/goal
 * ゴール到達チェック: ユーザーイベント（reply/visit/payment）を受けてゴール検出
 * body: { account_id, cast_name, username, event: 'reply'|'visit'|'payment' }
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const accountId = body.account_id as string;
  const castName = body.cast_name as string;
  const username = body.username as string;
  const event = body.event as 'reply' | 'visit' | 'payment';

  if (!accountId || !castName || !username || !event) {
    return NextResponse.json(
      { error: 'account_id, cast_name, username, event は必須です' },
      { status: 400 },
    );
  }

  if (!['reply', 'visit', 'payment'].includes(event)) {
    return NextResponse.json(
      { error: 'event は reply, visit, payment のいずれかです' },
      { status: 400 },
    );
  }

  const auth = await authenticateAndValidateAccount(req, accountId);
  if (!auth.authenticated) return auth.error;

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.token}` } },
  });

  const goalReached = await checkGoalReached(supabase, accountId, castName, username, event);

  return NextResponse.json({
    success: true,
    goal_reached: goalReached,
    username,
    event,
  });
}
