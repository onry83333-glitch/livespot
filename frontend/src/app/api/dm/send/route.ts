import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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
// username → Stripchat userId 解決
// ============================================================
async function resolveUserId(
  username: string,
  supabase: SupabaseClient,
  sessionCookie: string,
): Promise<{ userId: string | null; error?: string }> {
  // 1. paid_users キャッシュ確認
  const { data: cached } = await supabase
    .from('paid_users')
    .select('user_id_stripchat')
    .eq('user_name', username)
    .not('user_id_stripchat', 'is', null)
    .limit(1)
    .maybeSingle();

  if ((cached as Record<string, unknown>)?.user_id_stripchat) {
    return { userId: (cached as Record<string, unknown>).user_id_stripchat as string };
  }

  // 2. Stripchat API で解決
  try {
    const res = await fetch(
      `https://stripchat.com/api/front/v2/models/username/${username}`,
      {
        headers: {
          Accept: 'application/json',
          Cookie: `stripchat_com_sessionId=${sessionCookie}`,
        },
      },
    );
    if (!res.ok) {
      return { userId: null, error: `Stripchat API ${res.status}` };
    }
    const data = await res.json();
    const userId = data?.user?.id ? String(data.user.id) : null;
    if (!userId) {
      return { userId: null, error: 'userId not found in response' };
    }

    // キャッシュ保存（ベストエフォート）
    await supabase
      .from('paid_users')
      .update({ user_id_stripchat: userId } as Record<string, unknown>)
      .eq('user_name', username)
      .then(() => {});

    return { userId };
  } catch (err) {
    return { userId: null, error: String(err) };
  }
}

// ============================================================
// csrfToken 取得
// ============================================================
async function getCsrfToken(session: {
  csrf_token: string | null;
  session_cookie: string;
  cookies_json: Record<string, string>;
}): Promise<{
  token: string;
  timestamp: string;
  notifyTimestamp: string;
} | null> {
  // 方法1: 保存済みcsrfTokenを使用
  if (session.csrf_token) {
    const now = new Date();
    return {
      token: session.csrf_token,
      timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      notifyTimestamp: new Date(now.getTime() + 36 * 3600 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  // 方法2: /api/front/v2/config から取得
  try {
    const cookieStr = Object.entries(session.cookies_json || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const configRes = await fetch('https://ja.stripchat.com/api/front/v2/config', {
      headers: {
        Accept: 'application/json',
        Cookie: cookieStr || `stripchat_com_sessionId=${session.session_cookie}`,
      },
    });
    if (configRes.ok) {
      const config = await configRes.json();
      const csrfToken =
        config?.csrfToken || config?.config?.csrfToken || null;
      if (csrfToken) {
        const now = new Date();
        return {
          token: csrfToken,
          timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          notifyTimestamp: new Date(now.getTime() + 36 * 3600 * 1000)
            .toISOString()
            .replace(/\.\d{3}Z$/, 'Z'),
        };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// ============================================================
// Cookie文字列構築
// ============================================================
function buildCookieString(
  cookiesJson: Record<string, string>,
  sessionCookie: string,
): string {
  if (cookiesJson && Object.keys(cookiesJson).length > 0) {
    return Object.entries(cookiesJson)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return `stripchat_com_sessionId=${sessionCookie}`;
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

  const { target_username, message, account_id, dm_log_id, campaign, cast_name } = body;
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

  // 3. targetUserId 解決
  const { userId: targetUserId, error: resolveError } = await resolveUserId(
    target_username,
    supabase,
    session.session_cookie,
  );
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

  // 4. csrfToken 取得
  const csrf = await getCsrfToken(session);
  if (!csrf) {
    return NextResponse.json(
      {
        error: 'csrfToken取得失敗',
        fallback: 'extension',
        detail: 'セッションを再同期してください',
      },
      { status: 400 },
    );
  }

  // 5. uniq 生成
  const uniq = crypto.randomBytes(12).toString('hex').slice(0, 16);

  // 6. Stripchat DM API 呼び出し
  const cookieStr = buildCookieString(
    session.cookies_json || {},
    session.session_cookie,
  );

  try {
    const scRes = await fetch(
      `https://ja.stripchat.com/api/front/users/${session.stripchat_user_id}/conversations/${targetUserId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieStr,
          Origin: 'https://ja.stripchat.com',
          Referer: `https://ja.stripchat.com/user/${target_username}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'front-version': session.front_version || '11.5.57',
        },
        body: JSON.stringify({
          body: message,
          csrfToken: csrf.token,
          csrfTimestamp: csrf.timestamp,
          csrfNotifyTimestamp: csrf.notifyTimestamp,
          uniq,
        }),
      },
    );

    const scData = await scRes.json().catch(() => ({}));

    if (scRes.ok && scData.message) {
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
        message_id: scData.message.id,
        sent_via: 'api',
      });
    }

    // 失敗
    const errorMsg = JSON.stringify(scData).slice(0, 500);

    if (dm_log_id) {
      await supabase
        .from('dm_send_log')
        .update({
          status: 'error',
          sent_via: 'api',
          error: errorMsg,
        })
        .eq('id', dm_log_id);
    }

    // セッション無効化（401/403の場合）
    if (scRes.status === 401 || scRes.status === 403) {
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

    return NextResponse.json(
      { error: 'DM送信失敗', detail: errorMsg, fallback: 'extension' },
      { status: 502 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'DM送信エラー', detail: String(err), fallback: 'extension' },
      { status: 500 },
    );
  }
}
