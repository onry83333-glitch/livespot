'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';
import CalendarNotesModal from './calendar-notes-modal';
import StickyNotesModal, { type StickyNoteRich } from './sticky-notes-modal';

interface ActivityCalendarProps {
  accountId: string;
  castName: string;
  sb: SupabaseClient;
  /** 埋め込み表示モード。付箋・編集モーダルを非表示にする。 */
  embedMode?: boolean;
  /** 日付セルクリック時のカスタムハンドラ（埋め込み用）。指定時はモーダルを開かない。 */
  onDayClick?: (activityDate: string) => void;
}

interface ActivityDay {
  activity_date: string;
  has_session: boolean;
  session_count: number;
  has_dm: boolean;
  dm_count: number;
  has_report: boolean;
  report_count: number;
  has_revenue: boolean;
  revenue_tokens: number;
}

interface CastPlan {
  id: string;
  plan_date: string;
  title: string | null;
  content: string | null;
  color: string;
}

// StickyNoteRich は sticky-notes-modal.tsx からインポート（リッチテキスト対応）
type StickyNote = StickyNoteRich;

/**
 * TipTap JSON ドキュメントからプレビュー用プレーンテキストを抽出。
 * 先頭 N 文字まで、改行はスペース化。
 */
function extractPreviewText(doc: Record<string, unknown> | null, maxLen = 140): string {
  if (!doc) return '';
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

// STICKY_COLORS (legacy 色ピッカー) は 145 でカテゴリタグに移行したため削除。
// 既存データの color カラムは DB 上に保持されるが UI では使用しない。

// 修正4: メモ文字色パレット
const MEMO_COLORS: { key: string; hex: string; label: string }[] = [
  { key: 'white', hex: '#e2e8f0', label: '白' },
  { key: 'yellow', hex: '#facc15', label: '黄' },
  { key: 'red', hex: '#f87171', label: '赤' },
  { key: 'green', hex: '#4ade80', label: '緑' },
  { key: 'cyan', hex: '#22d3ee', label: '水色' },
  { key: 'purple', hex: '#c084fc', label: '紫' },
];

const getMemoColorHex = (key: string | undefined | null) =>
  MEMO_COLORS.find(c => c.key === key)?.hex || MEMO_COLORS[0].hex;

// cast_calendar_notes のカテゴリ別配色（セル表示用）
const NOTE_CATEGORY_COLORS: Record<string, string> = {
  plan: '#c084fc',  // 企画: 紫
  fb: '#38bdf8',    // 配信FB: 青
  idea: '#4ade80',  // アイデア: 緑
  other: '#94a3b8', // その他: グレー
};
const getNoteCategoryColor = (category: string): string =>
  NOTE_CATEGORY_COLORS[category] || NOTE_CATEGORY_COLORS.other;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const TK_TO_YEN = 7.7;
const MAX_STICKIES = 8;

// 修正3: localStorage key for filter state
const getFilterKey = (castName: string) => `calendar_filters_${castName}`;

interface FilterState {
  showSession: boolean;
  showDm: boolean;
  showReport: boolean;
  showRevenue: boolean;
  showMemo: boolean;
}

const DEFAULT_FILTERS: FilterState = {
  showSession: true,
  showDm: true,
  showReport: true,
  showRevenue: true,
  showMemo: true,
};

function loadFilters(castName: string): FilterState {
  if (typeof window === 'undefined') return DEFAULT_FILTERS;
  try {
    const raw = localStorage.getItem(getFilterKey(castName));
    if (!raw) return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(castName: string, filters: FilterState) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getFilterKey(castName), JSON.stringify(filters));
  } catch { /* ignore */ }
}

export default function ActivityCalendar({ accountId, castName, sb, embedMode = false, onDayClick }: ActivityCalendarProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-based
  const [data, setData] = useState<ActivityDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);

  // Memo state (multiple per day)
  const [plans, setPlans] = useState<Map<string, CastPlan[]>>(new Map());
  const [memoTitle, setMemoTitle] = useState('');
  const [memoContent, setMemoContent] = useState('');
  const [memoColor, setMemoColor] = useState('white');
  const [memoSaving, setMemoSaving] = useState(false);

  // 修正3: Filter state from localStorage
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  useEffect(() => {
    setFilters(loadFilters(castName));
  }, [castName]);

  const updateFilter = (key: keyof FilterState) => {
    setFilters(prev => {
      const next = { ...prev, [key]: !prev[key] };
      saveFilters(castName, next);
      return next;
    });
  };

  // Calendar notes (TipTap リッチメモ) — 日付ごとの要約リスト（タイトル・カテゴリ）
  interface NoteSummary {
    id: string;
    title: string | null;
    category: string;
  }
  const [noteSummaries, setNoteSummaries] = useState<Record<string, NoteSummary[]>>({});
  // 新モーダル: 日付クリックで開くリッチメモモーダル（embedMode ではオープンしない）
  const [notesModalDate, setNotesModalDate] = useState<string | null>(null);

  // Sticky notes state (リッチ化済み: cast_sticky_notes.content_rich)
  const [stickies, setStickies] = useState<StickyNote[]>([]);
  const [stickyError, setStickyError] = useState<string | null>(null);
  // 編集中の付箋 ID。モーダルに渡すノート参照。
  const [editStickyId, setEditStickyId] = useState<string | null>(null);

  // Fetch activity data
  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    sb.rpc('get_cast_activity_calendar', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_year: year,
      p_month: month,
    }).then(({ data: result }) => {
      setData((result || []) as ActivityDay[]);
      setLoading(false);
    });
  }, [accountId, castName, year, month, sb]);

  // Fetch cast_plans for this month (multiple per day)
  const fetchPlans = useCallback(async () => {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    const { data: planData } = await sb
      .from('cast_plans')
      .select('id, plan_date, title, content, color')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('plan_date', startDate)
      .lte('plan_date', endDate)
      .order('created_at', { ascending: true });
    const map = new Map<string, CastPlan[]>();
    for (const p of (planData || []) as CastPlan[]) {
      const dateKey = p.plan_date.substring(0, 10);
      const arr = map.get(dateKey) || [];
      arr.push({ ...p, plan_date: dateKey });
      map.set(dateKey, arr);
    }
    setPlans(map);
  }, [sb, accountId, castName, year, month]);

  useEffect(() => {
    if (!accountId || !castName) return;
    fetchPlans();
  }, [accountId, castName, fetchPlans]);

  // Fetch cast_calendar_notes の日別要約（タイトル・カテゴリ）
  // embed/通常モード共通。anon SELECT 許可済みのため直接 sb から取得。
  const fetchNoteSummaries = useCallback(async () => {
    if (!accountId || !castName) return;
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
    const { data, error } = await sb
      .from('cast_calendar_notes')
      .select('id, note_date, title, category, sort_order, created_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('note_date', startDate)
      .lte('note_date', endDate)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) {
      console.warn('[CalendarNotes] fetch summaries error:', error.message);
      return;
    }
    const map: Record<string, NoteSummary[]> = {};
    for (const row of (data || []) as {
      id: string;
      note_date: string;
      title: string | null;
      category: string;
    }[]) {
      const key = row.note_date.substring(0, 10);
      if (!map[key]) map[key] = [];
      map[key].push({ id: row.id, title: row.title, category: row.category });
    }
    setNoteSummaries(map);
  }, [sb, accountId, castName, year, month]);

  useEffect(() => {
    fetchNoteSummaries();
  }, [fetchNoteSummaries]);

  // Reset memo form when selectedDay changes
  useEffect(() => {
    setMemoTitle('');
    setMemoContent('');
    setMemoColor('white');
  }, [selectedDay]);

  // Add new memo (insert, not upsert)
  const handleAddMemo = async () => {
    if (!selectedDay) return;
    const dateKey = selectedDay.activity_date.substring(0, 10);
    const dayPlans = plans.get(dateKey) || [];
    if (dayPlans.length >= 8) return;
    if (!memoTitle.trim() && !memoContent.trim()) return;

    setMemoSaving(true);
    try {
      await sb.from('cast_plans').insert({
        account_id: accountId,
        cast_name: castName,
        plan_date: dateKey,
        title: memoTitle.trim() || null,
        content: memoContent.trim() || null,
        color: memoColor,
      });
      setMemoTitle('');
      setMemoContent('');
      setMemoColor('white');
      await fetchPlans();
    } catch (e) {
      alert('保存エラー: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setMemoSaving(false);
    }
  };

  // Delete a specific memo
  const handleDeleteMemo = async (id: string) => {
    await sb.from('cast_plans').delete().eq('id', id);
    await fetchPlans();
  };

  // Update memo color
  const handleUpdateMemoColor = async (id: string, color: string) => {
    await sb.from('cast_plans').update({ color }).eq('id', id);
    await fetchPlans();
  };

  // Sticky notes CRUD — cast_sticky_notes をリッチテキスト対応で取得
  // RLS で anon SELECT 許可されているため直接 sb から取得（認証は write 時のみ API 経由）
  const fetchStickies = useCallback(async () => {
    const { data: notes, error } = await sb
      .from('cast_sticky_notes')
      .select('id, account_id, cast_name, title, content, content_rich, category, color, sort_order, created_at, updated_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(MAX_STICKIES);
    if (error) {
      console.error('[StickyNotes] fetch error:', error.message);
      setStickyError('付箋の読み込みに失敗しました');
    } else {
      setStickies((notes || []) as StickyNote[]);
      setStickyError(null);
    }
  }, [sb, accountId, castName]);

  useEffect(() => {
    if (embedMode) return;
    if (accountId && castName) fetchStickies();
  }, [accountId, castName, fetchStickies, embedMode]);

  // 新規付箋作成: API 経由で POST → 返却 ID を editStickyId にセットしてモーダル展開
  const handleAddSticky = async () => {
    if (stickies.length >= MAX_STICKIES) return;
    setStickyError(null);
    try {
      const { data: authData } = await sb.auth.getSession();
      const token = authData.session?.access_token;
      if (!token) {
        setStickyError('認証が必要です');
        return;
      }
      const maxOrder =
        stickies.length > 0 ? Math.max(...stickies.map((s) => s.sort_order)) + 1 : 0;
      const res = await fetch('/api/cast-sticky-notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          account_id: accountId,
          cast_name: castName,
          title: '',
          content_rich: { type: 'doc', content: [{ type: 'paragraph' }] },
          category: 'other',
          sort_order: maxOrder,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { note: StickyNote };
      setStickies((prev) => [...prev, body.note]);
      setEditStickyId(body.note.id);
    } catch (e: unknown) {
      const err = e as { message?: string };
      setStickyError(`追加失敗: ${err.message || 'unknown'}`);
    }
  };

  // 削除時: stickies から除外（モーダル側で DELETE 完了後にコールバック）
  const handleStickyDeleted = (id: string) => {
    setStickies((prev) => prev.filter((s) => s.id !== id));
  };

  const todayStr = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }, []);

  // Build calendar grid
  const grid = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayMap = new Map<number, ActivityDay>();
    for (const d of data) {
      const dayNum = new Date(d.activity_date).getDate();
      dayMap.set(dayNum, d);
    }
    const cells: (ActivityDay & { dayNum: number } | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const act = dayMap.get(d);
      cells.push(act ? { ...act, dayNum: d } : {
        dayNum: d,
        activity_date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        has_session: false, session_count: 0,
        has_dm: false, dm_count: 0,
        has_report: false, report_count: 0,
        has_revenue: false, revenue_tokens: 0,
      });
    }
    return cells;
  }, [data, year, month]);

  const goPrev = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const goNext = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };

  // 修正1: メモタイトル表示ヘルパー
  const renderMemoInCell = (dayPlans: CastPlan[]) => {
    if (dayPlans.length === 0) return null;
    // 1件: タイトルのみ
    if (dayPlans.length === 1) {
      const title = dayPlans[0].title || dayPlans[0].content?.substring(0, 15) || 'メモ';
      return (
        <div className="truncate" style={{ color: getMemoColorHex(dayPlans[0].color) }}>
          <span className="text-[11px]">📝</span> {title}
        </div>
      );
    }
    // 2件: 2行表示
    if (dayPlans.length === 2) {
      return dayPlans.map((p, i) => {
        const title = p.title || p.content?.substring(0, 15) || 'メモ';
        return (
          <div key={i} className="truncate" style={{ color: getMemoColorHex(p.color) }}>
            <span className="text-[11px]">📝</span> {title}
          </div>
        );
      });
    }
    // 3件以上: 最初の2件 + 他N件
    return (
      <>
        {dayPlans.slice(0, 2).map((p, i) => {
          const title = p.title || p.content?.substring(0, 15) || 'メモ';
          return (
            <div key={i} className="truncate" style={{ color: getMemoColorHex(p.color) }}>
              <span className="text-[11px]">📝</span> {title}
            </div>
          );
        })}
        <div className="truncate" style={{ color: 'var(--text-muted)' }}>
          他{dayPlans.length - 2}件
        </div>
      </>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header: nav + month label */}
      <div className="flex items-center justify-between">
        <button onClick={goPrev} className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-white/[0.05]"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}>◀</button>
        <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
          {year}年{month}月
        </h3>
        <button onClick={goNext} className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-white/[0.05]"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}>▶</button>
      </div>

      {/* Filter checkboxes — 修正3: localStorage保存 */}
      <div className="flex flex-wrap gap-3 px-1">
        {([
          { key: 'showSession' as const, icon: '🎙️', label: '配信' },
          { key: 'showDm' as const, icon: '✉️', label: 'DM' },
          { key: 'showReport' as const, icon: '📊', label: 'レポート' },
          { key: 'showRevenue' as const, icon: '💰', label: '売上' },
          { key: 'showMemo' as const, icon: '📝', label: 'メモ' },
        ]).map(f => (
          <label
            key={f.label}
            className="flex items-center gap-1 cursor-pointer select-none text-[11px] transition-opacity"
            style={{ color: 'var(--text-secondary)', opacity: filters[f.key] ? 1 : 0.4 }}
          >
            <input
              type="checkbox"
              checked={filters[f.key]}
              onChange={() => updateFilter(f.key)}
              className="w-3 h-3 rounded accent-sky-400"
            />
            <span>{f.icon}</span>
            <span>{f.label}</span>
          </label>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
        {/* Weekday headers */}
        <div className="grid grid-cols-7" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          {WEEKDAYS.map((w, i) => (
            <div key={w} className="text-center py-2 text-[11px] font-medium"
              style={{ color: i === 0 ? '#ef4444' : i === 6 ? '#38bdf8' : 'var(--text-muted)' }}>
              {w}
            </div>
          ))}
        </div>

        {/* Day cells */}
        {loading ? (
          <div className="h-64 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : (
          <div className="grid grid-cols-7">
            {grid.map((cell, i) => {
              if (!cell) {
                return <div key={`empty-${i}`} className="min-h-[100px] p-1" style={{ borderBottom: '1px solid var(--border-primary)', borderRight: i % 7 !== 6 ? '1px solid var(--border-primary)' : undefined }} />;
              }
              const isToday = cell.activity_date === todayStr;
              const dayPlans = plans.get(cell.activity_date) || [];
              const hasMemo = dayPlans.length > 0;
              const dayOfWeek = (new Date(year, month - 1, cell.dayNum).getDay());
              return (
                <div
                  key={cell.dayNum}
                  onClick={() => {
                    if (onDayClick) {
                      // 埋め込みモード: 新規タブで SLS を開く（embed 側で処理）
                      onDayClick(cell.activity_date);
                    } else {
                      // 通常モード: リッチメモ（cast_calendar_notes）モーダルを開く
                      setNotesModalDate(cell.activity_date.substring(0, 10));
                    }
                  }}
                  className="min-h-[100px] p-1.5 transition-all duration-150 cursor-pointer hover:brightness-125 hover:scale-[1.02]"
                  style={{
                    borderBottom: '1px solid var(--border-primary)',
                    borderRight: i % 7 !== 6 ? '1px solid var(--border-primary)' : undefined,
                    background: isToday ? 'rgba(56,189,248,0.08)' : undefined,
                    boxShadow: isToday ? 'inset 0 0 0 2px rgba(56,189,248,0.4)' : undefined,
                  }}
                >
                  <div className="text-[11px] font-bold mb-0.5"
                    style={{ color: isToday ? '#38bdf8' : dayOfWeek === 0 ? '#ef4444' : dayOfWeek === 6 ? '#38bdf8' : 'var(--text-primary)' }}>
                    {cell.dayNum}
                  </div>
                  <div className="space-y-px text-[10px] leading-tight">
                    {filters.showSession && cell.has_session && (
                      <div className="flex items-center gap-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
                        <span className="text-[11px]">🎙️</span>
                        <span>配信 {cell.session_count}回</span>
                      </div>
                    )}
                    {filters.showRevenue && cell.has_revenue && (
                      <div className="flex items-center gap-0.5 truncate" style={{ color: 'var(--accent-green)' }}>
                        <span className="text-[11px]">💰</span>
                        <span>¥{Math.round(Number(cell.revenue_tokens) * TK_TO_YEN).toLocaleString()}</span>
                      </div>
                    )}
                    {filters.showReport && cell.has_report && (
                      <div className="flex items-center gap-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                        <span className="text-[11px]">📊</span>
                        <span>レポート {cell.report_count}件</span>
                      </div>
                    )}
                    {filters.showDm && cell.has_dm && (
                      <div className="flex items-center gap-0.5 truncate" style={{ color: 'var(--accent-primary)' }}>
                        <span className="text-[11px]">✉️</span>
                        <span>DM {cell.dm_count}件</span>
                      </div>
                    )}
                    {/* 修正1: メモタイトル表示 */}
                    {filters.showMemo && hasMemo && renderMemoInCell(dayPlans)}
                    {/* リッチメモ (cast_calendar_notes) — 各メモのタイトルをカテゴリ色で表示 */}
                    {filters.showMemo && (() => {
                      const dayNotes = noteSummaries[cell.activity_date] || [];
                      if (dayNotes.length === 0) return null;
                      const visible = dayNotes.slice(0, 3);
                      const remaining = dayNotes.length - visible.length;
                      return (
                        <>
                          {visible.map((n) => (
                            <div
                              key={n.id}
                              className="flex items-center gap-0.5 truncate"
                              style={{ color: getNoteCategoryColor(n.category) }}
                              title={n.title || '(無題)'}
                            >
                              <span className="text-[11px]">📓</span>
                              <span className="truncate">{n.title || '(無題)'}</span>
                            </div>
                          ))}
                          {remaining > 0 && (
                            <div className="truncate" style={{ color: 'var(--text-muted)' }}>
                              +{remaining}件
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>🎙️ 配信</span>
        <span>✉️ DM送信</span>
        <span>📊 レポート</span>
        <span>💰 売上</span>
        <span>📝 メモ</span>
      </div>

      {/* Sticky Notes (リッチテキスト対応) — キャスト全体のグローバルメモ */}
      {!embedMode && (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>📌 付箋メモ</h4>
          {stickies.length < MAX_STICKIES && (
            <button
              onClick={handleAddSticky}
              className="text-[11px] px-2.5 py-1 rounded-lg transition-colors hover:brightness-125"
              style={{ background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.3)', color: 'var(--accent-primary)' }}
            >
              ＋ 新規付箋
            </button>
          )}
        </div>
        {stickyError && (
          <div className="text-[11px] px-3 py-1.5 rounded-lg" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444' }}>
            {stickyError}
          </div>
        )}
        {stickies.length === 0 ? (
          <div className="text-[11px] py-4 text-center rounded-xl" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
            付箋メモはまだありません
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {stickies.map((note) => {
              // カテゴリ色でカード装飾（cast_calendar_notes と整合）
              const catColor = getNoteCategoryColor(note.category || 'other');
              // プレビュー: content_rich があればそこから抽出、無ければ legacy content を使う
              const previewText = note.content_rich
                ? extractPreviewText(note.content_rich)
                : (note.content || '').substring(0, 140);
              return (
                <div
                  key={note.id}
                  onClick={() => setEditStickyId(note.id)}
                  className="min-w-[220px] flex-1 max-w-[320px] min-h-[160px] rounded-xl p-3 flex flex-col cursor-pointer transition-all duration-150 hover:scale-[1.02] hover:brightness-110"
                  style={{
                    background: `${catColor}12`,
                    border: `1px solid ${catColor}40`,
                    boxShadow: `0 2px 8px rgba(0,0,0,0.2), inset 0 0 0 1px ${catColor}10`,
                  }}
                >
                  {/* Category badge */}
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                      style={{
                        background: `${catColor}22`,
                        color: catColor,
                        border: `1px solid ${catColor}40`,
                      }}
                    >
                      {note.category === 'plan' ? '企画'
                        : note.category === 'fb' ? '配信FB'
                        : note.category === 'idea' ? 'アイデア'
                        : 'その他'}
                    </span>
                  </div>
                  {/* Title */}
                  <div
                    className="text-[12px] font-bold truncate mb-1"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {note.title || '(無題)'}
                  </div>
                  {/* Rich content preview */}
                  <div
                    className="text-[10px] flex-1 overflow-hidden"
                    style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}
                  >
                    {previewText ? (
                      <span className="line-clamp-5 whitespace-pre-wrap">{previewText}</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>クリックして編集...</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Detail Modal */}
      {!embedMode && selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedDay(null)}>
          <div className="rounded-xl p-5 w-[360px] max-w-[90vw] space-y-3"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {(() => {
                  const d = new Date(selectedDay.activity_date);
                  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
                })()}
              </h4>
              <button onClick={() => setSelectedDay(null)} className="text-lg leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
            </div>

            {/* Activity summary */}
            <div className="space-y-1.5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
              {selectedDay.has_session && (
                <div className="flex items-center gap-2">
                  <span>🎙️</span>
                  <span>配信: {selectedDay.session_count}回</span>
                </div>
              )}
              {selectedDay.has_revenue && (
                <div className="flex items-center gap-2">
                  <span>💰</span>
                  <span>売上: {Number(selectedDay.revenue_tokens).toLocaleString()} tk（¥{Math.round(Number(selectedDay.revenue_tokens) * TK_TO_YEN).toLocaleString()}）</span>
                </div>
              )}
              {selectedDay.has_report && (
                <div className="flex items-center gap-2">
                  <span>📊</span>
                  <span>レポート: {selectedDay.report_count}件</span>
                </div>
              )}
              {selectedDay.has_dm && (
                <div className="flex items-center gap-2">
                  <span>✉️</span>
                  <span>DM: {selectedDay.dm_count}件送信</span>
                </div>
              )}
            </div>

            {/* Memo section — 修正1,4: タイトル表示 + カラーピッカー */}
            {(() => {
              const dateKey = selectedDay.activity_date.substring(0, 10);
              const dayMemos = plans.get(dateKey) || [];
              return (
                <div className="space-y-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-bold flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                      📝 メモ ({dayMemos.length}/8)
                    </label>
                  </div>

                  {/* Existing memos */}
                  {dayMemos.map(memo => (
                    <div key={memo.id} className="flex items-start gap-2 rounded-lg px-2.5 py-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div className="flex-1 min-w-0">
                        {memo.title && <p className="text-[11px] font-bold truncate" style={{ color: getMemoColorHex(memo.color) }}>{memo.title}</p>}
                        <p className="text-[10px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
                          {memo.content || '(内容なし)'}
                        </p>
                        {/* 修正4: カラー変更ボタン */}
                        <div className="flex gap-1 mt-1">
                          {MEMO_COLORS.map(c => (
                            <button
                              key={c.key}
                              onClick={() => handleUpdateMemoColor(memo.id, c.key)}
                              className="w-3.5 h-3.5 rounded-full transition-transform hover:scale-125"
                              style={{
                                background: c.hex,
                                border: `2px solid ${memo.color === c.key ? 'white' : 'transparent'}`,
                                opacity: memo.color === c.key ? 1 : 0.5,
                              }}
                              title={c.label}
                            />
                          ))}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteMemo(memo.id)}
                        className="text-[10px] shrink-0 opacity-40 hover:opacity-100 transition-opacity"
                        title="削除"
                      >
                        🗑️
                      </button>
                    </div>
                  ))}

                  {/* Add new memo form */}
                  {dayMemos.length < 8 && (
                    <>
                      <input
                        type="text"
                        placeholder="タイトル（任意）"
                        value={memoTitle}
                        onChange={e => setMemoTitle(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg text-xs"
                        style={{
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          color: getMemoColorHex(memoColor),
                          outline: 'none',
                        }}
                      />
                      <textarea
                        placeholder="メモを入力..."
                        value={memoContent}
                        onChange={e => setMemoContent(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 rounded-lg text-xs resize-none"
                        style={{
                          background: 'rgba(255,255,255,0.05)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          color: 'var(--text-primary)',
                          outline: 'none',
                        }}
                      />
                      {/* 修正4: 新規メモのカラーピッカー */}
                      <div className="flex items-center gap-2">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>文字色:</span>
                        <div className="flex gap-1.5">
                          {MEMO_COLORS.map(c => (
                            <button
                              key={c.key}
                              onClick={() => setMemoColor(c.key)}
                              className="w-5 h-5 rounded-full transition-transform hover:scale-125"
                              style={{
                                background: c.hex,
                                border: `2px solid ${memoColor === c.key ? 'white' : 'transparent'}`,
                                opacity: memoColor === c.key ? 1 : 0.5,
                              }}
                              title={c.label}
                            />
                          ))}
                        </div>
                      </div>
                      <button
                        onClick={handleAddMemo}
                        disabled={memoSaving || (!memoTitle.trim() && !memoContent.trim())}
                        className="w-full py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                        style={{
                          background: 'rgba(56,189,248,0.15)',
                          border: '1px solid rgba(56,189,248,0.3)',
                          color: 'var(--accent-primary)',
                        }}
                      >
                        {memoSaving ? '保存中...' : '＋ メモ追加'}
                      </button>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* リッチメモモーダル (cast_calendar_notes) — 通常モードのみ */}
      {!embedMode && notesModalDate && (
        <CalendarNotesModal
          open={!!notesModalDate}
          onClose={() => setNotesModalDate(null)}
          accountId={accountId}
          castName={castName}
          date={notesModalDate}
          sb={sb}
          onNotesChanged={fetchNoteSummaries}
        />
      )}

      {/* 付箋メモ編集モーダル (cast_sticky_notes) — 通常モードのみ */}
      {!embedMode && editStickyId && (
        <StickyNotesModal
          open={!!editStickyId}
          onClose={() => setEditStickyId(null)}
          accountId={accountId}
          castName={castName}
          note={stickies.find((s) => s.id === editStickyId) || null}
          sb={sb}
          onChanged={fetchStickies}
          onDelete={handleStickyDeleted}
        />
      )}
    </div>
  );
}
