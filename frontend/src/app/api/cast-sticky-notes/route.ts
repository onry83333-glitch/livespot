import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';

// ============================================================
// /api/cast-sticky-notes
// cast_sticky_notes の GET（キャスト別一覧） / POST（新規作成）
// 145 で TipTap リッチテキスト対応（content_rich + category）
// ============================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

function getAuthClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

const VALID_CATEGORIES = ['plan', 'fb', 'idea', 'other'] as const;
type Category = (typeof VALID_CATEGORIES)[number];

const SELECT_COLS =
  'id, account_id, cast_name, title, content, content_rich, category, color, sort_order, created_at, updated_at';

interface CreateBody {
  account_id: string;
  cast_name: string;
  title?: string | null;
  content_rich?: Record<string, unknown> | null;
  category?: Category;
  sort_order?: number;
}

// ============================================================
// GET /api/cast-sticky-notes?cast_name=xxx[&account_id=yyy]
// ============================================================
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const castName = searchParams.get('cast_name');
  const accountId = searchParams.get('account_id');

  if (!castName) {
    return NextResponse.json({ error: 'cast_name は必須です' }, { status: 400 });
  }

  const auth = await authenticateAndValidateAccount(req, accountId);
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);
    let query = sb
      .from('cast_sticky_notes')
      .select(SELECT_COLS)
      .eq('cast_name', castName)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (accountId) query = query.eq('account_id', accountId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ notes: data || [] });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/cast-sticky-notes', context: 'GET' });
    return NextResponse.json({ error: err.message || '取得エラー' }, { status: 500 });
  }
}

// ============================================================
// POST /api/cast-sticky-notes — 新規付箋
// ============================================================
export async function POST(req: NextRequest) {
  const body = (await req.json()) as CreateBody;
  const { account_id, cast_name, title, content_rich, category, sort_order } = body;

  if (!account_id || !cast_name) {
    return NextResponse.json(
      { error: 'account_id, cast_name は必須です' },
      { status: 400 },
    );
  }
  if (category && !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `未対応のcategory。対応: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }

  const auth = await authenticateAndValidateAccount(req, account_id);
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);
    const { data, error } = await sb
      .from('cast_sticky_notes')
      .insert({
        account_id,
        cast_name,
        title: title ?? null,
        content_rich: content_rich ?? { type: 'doc', content: [{ type: 'paragraph' }] },
        category: category ?? 'other',
        sort_order: sort_order ?? 0,
      })
      .select(SELECT_COLS)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ note: data });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/cast-sticky-notes', context: 'POST' });
    return NextResponse.json({ error: err.message || '作成エラー' }, { status: 500 });
  }
}
