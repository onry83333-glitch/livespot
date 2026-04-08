'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import TipTapEditor from './tiptap-editor';

// ============================================================
// CalendarNotesModal
// 日付単位で複数の TipTap メモを管理するモーダル。
// Notion 風の「スレッド形式」でアコーディオン展開。
// ============================================================

export interface CalendarNote {
  id: string;
  account_id: string;
  cast_name: string;
  note_date: string;
  title: string | null;
  content: Record<string, unknown> | null;
  category: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  castName: string;
  date: string; // YYYY-MM-DD
  sb: SupabaseClient;
  /** 閉じる時にこのコールバックを呼んで、親カレンダーの件数カウントを更新する */
  onNotesChanged?: () => void;
}

const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'plan', label: '企画', color: '#c084fc' },
  { key: 'fb', label: '配信FB', color: '#38bdf8' },
  { key: 'idea', label: 'アイデア', color: '#facc15' },
  { key: 'other', label: 'その他', color: '#94a3b8' },
];

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function formatDateJP(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

async function apiAuthHeaders(sb: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function CalendarNotesModal({
  open,
  onClose,
  accountId,
  castName,
  date,
  sb,
  onNotesChanged,
}: Props) {
  const [notes, setNotes] = useState<CalendarNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [savingMap, setSavingMap] = useState<Record<string, 'idle' | 'saving' | 'saved'>>({});
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(false);

  // ============================================================
  // Load notes
  // ============================================================
  const loadNotes = useCallback(async () => {
    if (!open || !castName || !date || !accountId) return;
    setLoading(true);
    setError(null);
    try {
      const headers = await apiAuthHeaders(sb);
      const res = await fetch(
        `/api/calendar-notes?cast_name=${encodeURIComponent(castName)}&date=${date}&account_id=${accountId}`,
        { headers },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { notes: CalendarNote[] };
      setNotes(body.notes || []);
      // 最新1件をデフォルトで開く
      if (body.notes && body.notes.length > 0) {
        setExpanded(new Set([body.notes[body.notes.length - 1].id]));
      } else {
        setExpanded(new Set());
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err.message || '読み込みエラー');
    } finally {
      setLoading(false);
    }
  }, [open, castName, date, accountId, sb]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  // ============================================================
  // Create
  // ============================================================
  const handleCreate = async () => {
    setError(null);
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(await apiAuthHeaders(sb)),
      };
      const res = await fetch('/api/calendar-notes', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          account_id: accountId,
          cast_name: castName,
          note_date: date,
          title: '',
          content: { type: 'doc', content: [{ type: 'paragraph' }] },
          category: 'other',
          sort_order: notes.length,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { note: CalendarNote };
      setNotes((prev) => [...prev, body.note]);
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(body.note.id);
        return next;
      });
      changedRef.current = true;
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err.message || '作成エラー');
    }
  };

  // ============================================================
  // Delete
  // ============================================================
  const handleDelete = async (id: string) => {
    if (!confirm('このメモを削除しますか？')) return;
    setError(null);
    try {
      const headers = await apiAuthHeaders(sb);
      const res = await fetch(
        `/api/calendar-notes/${id}?account_id=${accountId}`,
        { method: 'DELETE', headers },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setNotes((prev) => prev.filter((n) => n.id !== id));
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      changedRef.current = true;
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err.message || '削除エラー');
    }
  };

  // ============================================================
  // Patch (auto-save, debounced per-note)
  // ============================================================
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scheduleSave = useCallback(
    (id: string, patch: Partial<Pick<CalendarNote, 'title' | 'content' | 'category'>>) => {
      // オプティミスティック更新
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...patch } : n)));
      setSavingMap((prev) => ({ ...prev, [id]: 'saving' }));
      changedRef.current = true;

      const existing = saveTimers.current.get(id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        try {
          const headers = {
            'Content-Type': 'application/json',
            ...(await apiAuthHeaders(sb)),
          };
          const res = await fetch(`/api/calendar-notes/${id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ account_id: accountId, ...patch }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          setSavingMap((prev) => ({ ...prev, [id]: 'saved' }));
          setTimeout(() => {
            setSavingMap((prev) => {
              if (prev[id] !== 'saved') return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }, 1500);
        } catch (e: unknown) {
          const err = e as { message?: string };
          setError(err.message || '保存エラー');
          setSavingMap((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }
      }, 1000);
      saveTimers.current.set(id, timer);
    },
    [sb, accountId],
  );

  // ============================================================
  // Close handler — 未保存の debounce をフラッシュ
  // ============================================================
  const handleClose = () => {
    // 残っている debounce を即時発火
    saveTimers.current.forEach((t) => clearTimeout(t));
    saveTimers.current.clear();
    if (changedRef.current) onNotesChanged?.();
    changedRef.current = false;
    onClose();
  };

  // ============================================================
  // Toggle accordion
  // ============================================================
  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const uploadPrefix = useMemo(
    () => `${castName}/${date}`,
    [castName, date],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 py-8 overflow-y-auto"
      onClick={handleClose}
    >
      <div
        className="rounded-xl w-[780px] max-w-[95vw] max-h-[88vh] flex flex-col"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-primary)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 rounded-t-xl"
          style={{ borderBottom: '1px solid var(--border-primary)' }}
        >
          <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
            📅 {formatDateJP(date)} のメモ
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCreate}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: 'rgba(56,189,248,0.15)',
                border: '1px solid rgba(56,189,248,0.3)',
                color: 'var(--accent-primary)',
              }}
            >
              ＋ 新規メモ
            </button>
            <button
              onClick={handleClose}
              className="text-xl leading-none px-2"
              style={{ color: 'var(--text-muted)' }}
              title="閉じる"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {error && (
            <div
              className="text-xs px-3 py-2 rounded-lg"
              style={{
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: '#ef4444',
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div
                className="w-6 h-6 border-2 rounded-full animate-spin"
                style={{
                  borderColor: 'var(--border-primary)',
                  borderTopColor: 'transparent',
                }}
              />
            </div>
          ) : notes.length === 0 ? (
            <div
              className="text-center py-12 text-sm rounded-xl"
              style={{
                color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.02)',
                border: '1px dashed rgba(255,255,255,0.08)',
              }}
            >
              この日のメモはまだありません。右上「＋ 新規メモ」から追加してください。
            </div>
          ) : (
            notes.map((note) => {
              const isOpen = expanded.has(note.id);
              const saving = savingMap[note.id];
              const catInfo =
                CATEGORIES.find((c) => c.key === note.category) || CATEGORIES[3];
              return (
                <div
                  key={note.id}
                  className="rounded-xl overflow-hidden"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  {/* Accordion header */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.03] transition-colors"
                    onClick={() => toggleExpand(note.id)}
                  >
                    <span
                      className="text-xs transition-transform"
                      style={{
                        display: 'inline-block',
                        transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      ▶
                    </span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                      style={{
                        background: `${catInfo.color}22`,
                        color: catInfo.color,
                        border: `1px solid ${catInfo.color}40`,
                      }}
                    >
                      {catInfo.label}
                    </span>
                    <input
                      type="text"
                      value={note.title || ''}
                      placeholder="メモのタイトル..."
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        scheduleSave(note.id, { title: e.target.value })
                      }
                      className="flex-1 min-w-0 text-sm font-bold bg-transparent outline-none"
                      style={{ color: 'var(--text-primary)' }}
                    />
                    {saving === 'saving' && (
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        保存中...
                      </span>
                    )}
                    {saving === 'saved' && (
                      <span className="text-[10px]" style={{ color: '#4ade80' }}>
                        ✓ 保存済み
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(note.id);
                      }}
                      className="text-xs opacity-40 hover:opacity-100 transition-opacity px-1"
                      title="削除"
                    >
                      🗑
                    </button>
                  </div>

                  {/* Accordion body */}
                  {isOpen && (
                    <div
                      className="px-3 py-3 space-y-2"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                    >
                      {/* Category selector */}
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[11px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          カテゴリ:
                        </span>
                        <div className="flex gap-1">
                          {CATEGORIES.map((c) => (
                            <button
                              key={c.key}
                              onClick={() =>
                                scheduleSave(note.id, { category: c.key })
                              }
                              className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
                              style={{
                                background:
                                  note.category === c.key
                                    ? `${c.color}33`
                                    : 'rgba(255,255,255,0.03)',
                                color:
                                  note.category === c.key
                                    ? c.color
                                    : 'var(--text-muted)',
                                border: `1px solid ${
                                  note.category === c.key ? `${c.color}60` : 'rgba(255,255,255,0.08)'
                                }`,
                              }}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Editor */}
                      <TipTapEditor
                        value={note.content}
                        onChange={(json) => scheduleSave(note.id, { content: json })}
                        sb={sb}
                        uploadPrefix={uploadPrefix}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div
          className="px-5 py-2 text-[10px] rounded-b-xl"
          style={{
            color: 'var(--text-muted)',
            borderTop: '1px solid var(--border-primary)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          画像はクリップボードから直接貼り付け可能。編集内容は1秒後に自動保存されます。
        </div>
      </div>
    </div>
  );
}
