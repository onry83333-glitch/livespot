import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { StripchatAPI } from '@/lib/stripchat-api';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function GET(req: NextRequest) {
  // 1. 認証
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    return NextResponse.json({ error: '認証トークンが無効です' }, { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // 2. アカウント取得
  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .limit(1)
    .maybeSingle();

  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  // 3. セッション取得
  const { data: session } = await supabase
    .from('stripchat_sessions')
    .select('*')
    .eq('account_id', account.id)
    .eq('is_valid', true)
    .maybeSingle();

  const sessionValid = !!session;

  if (!session) {
    return NextResponse.json({
      ok: false,
      sessionValid: false,
      csrfAvailable: false,
      cfBlocked: false,
      detail: 'セッションがありません。Chrome拡張でエクスポートしてください。',
    });
  }

  // 4. StripchatAPI でテスト
  const api = new StripchatAPI(session);
  const testResult = await api.testConnection();

  // 5. CSRF確認
  const csrf = await api.getCsrfToken();
  const csrfAvailable = !!csrf;

  return NextResponse.json({
    ok: testResult.ok,
    status: testResult.status,
    sessionValid,
    csrfAvailable,
    cfBlocked: testResult.cfBlocked,
    detail: testResult.cfBlocked
      ? 'Cloudflare Bot検知が発生しています。サーバーサイドAPI送信は利用できません。'
      : testResult.ok
        ? '接続正常。サーバーサイドAPI送信が利用可能です。'
        : `接続エラー (HTTP ${testResult.status})`,
  });
}
