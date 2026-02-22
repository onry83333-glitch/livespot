import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { StripchatAPI } from '@/lib/stripchat-api';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export async function GET(req: NextRequest) {
  // 認証はオプショナル — Bearer トークンがあれば使う、なければ公開APIテストのみ
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // --- Phase 1: 公開APIテスト（認証不要） ---
  // Stripchat公開APIに直接アクセスしてCloudflare検知をテスト
  let cfTestOk = false;
  let cfTestStatus = 0;
  let cfBlocked = false;

  try {
    const configRes = await fetch('https://ja.stripchat.com/api/front/v2/config', {
      headers: { Accept: 'application/json' },
    });
    cfTestStatus = configRes.status;
    cfBlocked = configRes.status === 403;

    if (!cfBlocked) {
      const cfMitigated = configRes.headers.get('cf-mitigated');
      if (cfMitigated) cfBlocked = true;
    }

    if (!cfBlocked && configRes.ok) {
      const text = await configRes.text();
      if (text.includes('cf-') && text.includes('<html')) {
        cfBlocked = true;
      }
    }

    cfTestOk = configRes.ok && !cfBlocked;
  } catch (err) {
    cfTestStatus = 0;
    cfBlocked = false;
  }

  // --- Phase 2: セッション付きテスト（認証がある場合のみ） ---
  let sessionValid = false;
  let csrfAvailable = false;
  let sessionTestOk = false;

  if (token) {
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });

      const { data: account } = await supabase
        .from('accounts')
        .select('id')
        .limit(1)
        .maybeSingle();

      if (account) {
        const { data: session } = await supabase
          .from('stripchat_sessions')
          .select('*')
          .eq('account_id', account.id)
          .eq('is_valid', true)
          .maybeSingle();

        if (session) {
          sessionValid = true;
          const api = new StripchatAPI(session);
          const result = await api.testConnection();
          sessionTestOk = result.ok;
          if (result.cfBlocked) cfBlocked = true;

          const csrf = await api.getCsrfToken();
          csrfAvailable = !!csrf;
        }
      }
    } catch {
      // auth failed — ignore, still return public test results
    }
  }

  return NextResponse.json({
    ok: cfTestOk,
    status: cfTestStatus,
    cfBlocked,
    sessionValid,
    sessionTestOk,
    csrfAvailable,
    authProvided: !!token,
    detail: cfBlocked
      ? 'Cloudflare Bot検知が発生しています。サーバーサイドAPI送信は利用できません。'
      : cfTestOk
        ? sessionValid
          ? csrfAvailable
            ? '接続正常。サーバーサイドAPI送信が利用可能です。'
            : '接続正常。csrfTokenが未取得です（Chrome拡張で再同期してください）。'
          : '公開APIは正常。セッションがありません（Chrome拡張でエクスポートしてください）。'
        : `接続エラー (HTTP ${cfTestStatus})`,
  });
}
