import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { StripchatAPI } from '@/lib/stripchat-api';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ============================================================
// 認証ヘルパー
// ============================================================
async function authenticate(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: '認証が必要です', status: 401 };
  }
  const token = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    return { error: '認証トークンが無効です', status: 401 };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  return { supabase, token };
}

// ============================================================
// POST /api/dm/send — 単発DM送信
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  let body: {
    target_username: string;
    message: string;
    account_id?: string;
    dm_log_id?: number;
    campaign?: string;
    cast_name?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { target_username, message, account_id, dm_log_id } = body;
  if (!target_username || !message) {
    return NextResponse.json(
      { error: 'target_username and message are required' },
      { status: 400 },
    );
  }

  // 1. アカウント取得
  let accountQuery = supabase.from('accounts').select('id').limit(1);
  if (account_id) {
    accountQuery = accountQuery.eq('id', account_id);
  }
  const { data: account } = await accountQuery.maybeSingle();
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  // 2. 有効なセッション取得
  const { data: session } = await supabase
    .from('stripchat_sessions')
    .select('*')
    .eq('account_id', account.id)
    .eq('is_valid', true)
    .maybeSingle();

  if (!session) {
    return NextResponse.json(
      {
        error: 'No active Stripchat session',
        fallback: 'extension',
        detail: 'Chrome拡張を開いてセッションを同期してください',
      },
      { status: 400 },
    );
  }

  // StripchatAPI インスタンス作成
  const api = new StripchatAPI({
    id: session.id,
    session_cookie: session.session_cookie,
    csrf_token: session.csrf_token,
    csrf_timestamp: session.csrf_timestamp,
    stripchat_user_id: session.stripchat_user_id,
    front_version: session.front_version,
    cookies_json: session.cookies_json || {},
    jwt_token: session.jwt_token,
  });

  // 3. targetUserId 解決
  const { userId: targetUserId, error: resolveError } =
    await api.resolveUserId(target_username, supabase);
  if (!targetUserId) {
    return NextResponse.json(
      {
        error: `userId解決失敗: ${target_username}`,
        detail: resolveError,
        fallback: 'extension',
      },
      { status: 400 },
    );
  }

  // 4. DM送信
  const result = await api.sendDM(targetUserId, message, target_username);

  if (result.success) {
    // 成功: dm_send_log 更新
    if (dm_log_id) {
      await supabase
        .from('dm_send_log')
        .update({
          status: 'success',
          sent_via: 'api',
          sent_at: new Date().toISOString(),
          error: null,
        })
        .eq('id', dm_log_id);
    }

    return NextResponse.json({
      success: true,
      message_id: result.messageId,
      sent_via: 'api',
    });
  }

  // 失敗処理
  if (dm_log_id) {
    await supabase
      .from('dm_send_log')
      .update({
        status: 'error',
        sent_via: 'api',
        error: result.error,
      })
      .eq('id', dm_log_id);
  }

  // セッション無効化（セッション期限切れの場合）
  if (result.sessionExpired) {
    await supabase
      .from('stripchat_sessions')
      .update({ is_valid: false, updated_at: new Date().toISOString() })
      .eq('id', session.id);

    return NextResponse.json(
      {
        error: 'Session expired',
        fallback: 'extension',
        detail: 'Chrome拡張でセッションを再同期してください',
      },
      { status: 401 },
    );
  }

  // csrfToken 取得失敗の場合
  if (result.error === 'csrfToken取得失敗') {
    return NextResponse.json(
      {
        error: 'csrfToken取得失敗',
        fallback: 'extension',
        detail: 'セッションを再同期してください',
      },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { error: 'DM送信失敗', detail: result.error, fallback: 'extension' },
    { status: 502 },
  );
}
