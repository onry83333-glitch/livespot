// ============================================================
// API Route 認証ユーティリティ
// Supabase JWT トークンを検証し、account_id を返す
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

interface AuthResult {
  authenticated: true;
  userId: string;
  accountIds: string[];
  token: string;
}

interface AuthError {
  authenticated: false;
  error: NextResponse;
}

export async function authenticateRequest(
  request: NextRequest,
): Promise<AuthResult | AuthError> {
  // Authorization ヘッダーからトークン取得
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return {
      authenticated: false,
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return {
        authenticated: false,
        error: NextResponse.json({ error: '無効なトークンです' }, { status: 401 }),
      };
    }

    // accounts テーブルから user の account_id 一覧を取得
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id')
      .eq('user_id', user.id);

    const accountIds = accounts?.map((a) => a.id) || [];

    return {
      authenticated: true,
      userId: user.id,
      accountIds,
      token,
    };
  } catch {
    return {
      authenticated: false,
      error: NextResponse.json({ error: '認証エラー' }, { status: 500 }),
    };
  }
}

/** リクエストの account_id がユーザーの所有アカウントに含まれるか検証 */
export function validateAccountAccess(
  requestAccountId: string,
  userAccountIds: string[],
): boolean {
  return userAccountIds.includes(requestAccountId);
}

/** 認証チェック + account_id 検証を一括で行うヘルパー */
export async function authenticateAndValidateAccount(
  request: NextRequest,
  accountId: string | null,
): Promise<AuthResult | AuthError> {
  const auth = await authenticateRequest(request);
  if (!auth.authenticated) return auth;

  if (accountId && !validateAccountAccess(accountId, auth.accountIds)) {
    return {
      authenticated: false,
      error: NextResponse.json(
        { error: 'アクセス権限がありません' },
        { status: 403 },
      ),
    };
  }

  return auth;
}

// ============================================================
// Rate Limiting（簡易版 — インメモリ）
// ============================================================
const RATE_LIMIT_MAP = new Map<string, number>();
const RATE_LIMIT_WINDOW = 5000; // 5秒

/** 同一キーでの連打を防止。true=許可、false=制限中 */
export function checkRateLimit(key: string, windowMs = RATE_LIMIT_WINDOW): boolean {
  const now = Date.now();
  const lastCall = RATE_LIMIT_MAP.get(key);
  if (lastCall && now - lastCall < windowMs) return false;
  RATE_LIMIT_MAP.set(key, now);
  // メモリリーク防止: 古いエントリを定期掃除
  if (RATE_LIMIT_MAP.size > 10000) {
    RATE_LIMIT_MAP.forEach((v, k) => {
      if (now - v > windowMs * 2) RATE_LIMIT_MAP.delete(k);
    });
  }
  return true;
}
