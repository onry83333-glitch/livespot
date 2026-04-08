import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';

// ============================================================
// /api/calendar-notes/[id]
// cast_calendar_notes の PATCH（更新） / DELETE
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

interface PatchBody {
  account_id?: string;
  title?: string | null;
  content?: Record<string, unknown> | null;
  category?: Category;
  sort_order?: number;
}

// ============================================================
// PATCH /api/calendar-notes/[id]
// ============================================================
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  if (!id) {
    return NextResponse.json({ error: 'id は必須です' }, { status: 400 });
  }

  const body = (await req.json()) as PatchBody;
  const { account_id, title, content, category, sort_order } = body;

  if (category && !VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `未対応のcategory。対応: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    );
  }

  const auth = await authenticateAndValidateAccount(req, account_id ?? null);
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);

    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (content !== undefined) patch.content = content ?? {};
    if (category !== undefined) patch.category = category;
    if (sort_order !== undefined) patch.sort_order = sort_order;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: '更新フィールドがありません' }, { status: 400 });
    }

    const { data, error } = await sb
      .from('cast_calendar_notes')
      .update(patch)
      .eq('id', id)
      .select('id, account_id, cast_name, note_date, title, content, category, sort_order, created_at, updated_at')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ note: data });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/calendar-notes/[id]', context: 'PATCH' });
    return NextResponse.json({ error: err.message || '更新エラー' }, { status: 500 });
  }
}

// ============================================================
// DELETE /api/calendar-notes/[id]
// ============================================================
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  if (!id) {
    return NextResponse.json({ error: 'id は必須です' }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get('account_id');

  const auth = await authenticateAndValidateAccount(req, accountId);
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);

    const { error } = await sb
      .from('cast_calendar_notes')
      .delete()
      .eq('id', id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/calendar-notes/[id]', context: 'DELETE' });
    return NextResponse.json({ error: err.message || '削除エラー' }, { status: 500 });
  }
}
