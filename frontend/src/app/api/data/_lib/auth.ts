/**
 * 内部データAPI用の認証ヘルパー
 * Supabase service_role key による認証チェック
 */
import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

/** service_role key を検証し、管理者用Supabaseクライアントを返す */
export function authenticateServiceRole(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || token !== SERVICE_ROLE_KEY) {
    return {
      authenticated: false as const,
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    };
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  return {
    authenticated: true as const,
    supabase,
  };
}
