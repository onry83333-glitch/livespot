import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateAndValidateAccount } from '@/lib/api-auth';
import { reportError } from '@/lib/error-handler';

// ============================================================
// /api/calendar-notes
// cast_calendar_notes テーブルの GET（日付指定） / POST（新規作成）
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

interface CreateBody {
  account_id: string;
  cast_name: string;
  note_date: string; // YYYY-MM-DD
  title?: string | null;
  content?: Record<string, unknown> | null;
  category?: Category;
  sort_order?: number;
}

// ============================================================
// GET /api/calendar-notes
//   ?cast_name=xxx&date=YYYY-MM-DD           -> 指定日のメモ一覧
//   ?cast_name=xxx&month=YYYY-MM              -> 月単位の日別件数（カレンダーセル用）
// ============================================================
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const castName = searchParams.get('cast_name');
  const date = searchParams.get('date');
  const month = searchParams.get('month');
  const accountId = searchParams.get('account_id');

  if (!castName) {
    return NextResponse.json({ error: 'cast_name は必須です' }, { status: 400 });
  }
  if (!date && !month) {
    return NextResponse.json(
      { error: 'date または month のいずれかを指定してください' },
      { status: 400 },
    );
  }

  const auth = await authenticateAndValidateAccount(req, accountId);
  if (!auth.authenticated) return auth.error;

  try {
    const sb = getAuthClient(auth.token);

    // 日指定: 該当日のメモ一覧を返す
    if (date) {
      let query = sb
        .from('cast_calendar_notes')
        .select('id, account_id, cast_name, note_date, title, content, category, sort_order, created_at, updated_at')
        .eq('cast_name', castName)
        .eq('note_date', date)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (accountId) query = query.eq('account_id', accountId);

      const { data, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ notes: data || [] });
    }

    // 月指定: note_date ごとの件数マップを返す（カレンダーセル表示用）
    const [yyyy, mm] = (month as string).split('-');
    if (!yyyy || !mm) {
      return NextResponse.json({ error: 'month は YYYY-MM 形式で指定してください' }, { status: 400 });
    }
    const startDate = `${yyyy}-${mm}-01`;
    const daysInMonth = new Date(Number(yyyy), Number(mm), 0).getDate();
    const endDate = `${yyyy}-${mm}-${String(daysInMonth).padStart(2, '0')}`;

    let query = sb
      .from('cast_calendar_notes')
      .select('note_date')
      .eq('cast_name', castName)
      .gte('note_date', startDate)
      .lte('note_date', endDate);
    if (accountId) query = query.eq('account_id', accountId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const counts: Record<string, number> = {};
    for (const row of (data || []) as { note_date: string }[]) {
      const key = row.note_date.substring(0, 10);
      counts[key] = (counts[key] || 0) + 1;
    }
    return NextResponse.json({ counts });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/calendar-notes', context: 'GET' });
    return NextResponse.json({ error: err.message || '取得エラー' }, { status: 500 });
  }
}

// ============================================================
// POST /api/calendar-notes — 新規メモ作成
// ============================================================
export async function POST(req: NextRequest) {
  const body = (await req.json()) as CreateBody;
  const { account_id, cast_name, note_date, title, content, category, sort_order } = body;

  if (!account_id || !cast_name || !note_date) {
    return NextResponse.json(
      { error: 'account_id, cast_name, note_date は必須です' },
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
      .from('cast_calendar_notes')
      .insert({
        account_id,
        cast_name,
        note_date,
        title: title ?? null,
        content: content ?? {},
        category: category ?? 'other',
        sort_order: sort_order ?? 0,
      })
      .select('id, account_id, cast_name, note_date, title, content, category, sort_order, created_at, updated_at')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ note: data });
  } catch (e: unknown) {
    const err = e as { message?: string };
    await reportError(e, { file: 'api/calendar-notes', context: 'POST' });
    return NextResponse.json({ error: err.message || '作成エラー' }, { status: 500 });
  }
}
