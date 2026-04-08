'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import TipTapEditor from './tiptap-editor';

// ============================================================
// StickyNotesModal
// 単一の付箋（cast_sticky_notes 1 レコード）を編集するモーダル。
// CalendarNotesModal と同じツール構成・自動保存パターン。
// ============================================================

export interface StickyNoteRich {
  id: string;
  account_id: string;
  cast_name: string;
  title: string | null;
  content: string | null;            // legacy plain text
  content_rich: Record<string, unknown> | null;
  category: string;
  color: string | null;              // legacy
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  castName: string;
  note: StickyNoteRich | null;
  sb: SupabaseClient;
  /** 閉じる時に親の一覧を再取得する */
  onChanged?: () => void;
  /** 削除時のハンドラ。親でモーダルを閉じた上で一覧を再取得する */
  onDelete?: (id: string) => void;
}

const CATEGORIES: { key: string; label: string; color: string }[] = [
  { key: 'plan', label: '企画', color: '#c084fc' },
  { key: 'fb', label: '配信FB', color: '#38bdf8' },
  { key: 'idea', label: 'アイデア', color: '#4ade80' },
  { key: 'other', label: 'その他', color: '#94a3b8' },
];

async function apiAuthHeaders(sb: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 既存 content (TEXT) のみ持つ legacy 付箋を TipTap JSON にフォールバック変換。
 * 新規付箋や content_rich を既に持つものはそのまま返す。
 */
function initialContent(note: StickyNoteRich): Record<string, unknown> {
  if (note.content_rich && Object.keys(note.content_rich).length > 0) {
    return note.content_rich;
  }
  const text = (note.content || '').trim();
  if (!text) return { type: 'doc', content: [{ type: 'paragraph' }] };
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

export default function StickyNotesModal({
  open,
  onClose,
  accountId,
  castName,
  note,
  sb,
  onChanged,
  onDelete,
}: Props) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('other');
  const [content, setContent] = useState<Record<string, unknown>>({
    type: 'doc',
    content: [{ type: 'paragraph' }],
  });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const changedRef = useRef(false);

  // Reset when note changes
  useEffect(() => {
    if (note) {
      setTitle(note.title || '');
      setCategory(note.category || 'other');
      setContent(initialContent(note));
      setSaveState('idle');
      changedRef.current = false;
      setError(null);
    }
  }, [note]);

  // ============================================================
  // Debounced auto-save
  // ============================================================
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = useCallback(
    (patch: Partial<Pick<StickyNoteRich, 'title' | 'category'>> & {
      content_rich?: Record<string, unknown>;
    }) => {
      if (!note) return;
      setSaveState('saving');
      changedRef.current = true;

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          const headers = {
            'Content-Type': 'application/json',
            ...(await apiAuthHeaders(sb)),
          };
          const res = await fetch(`/api/cast-sticky-notes/${note.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ account_id: accountId, ...patch }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          setSaveState('saved');
          setTimeout(() => {
            setSaveState((prev) => (prev === 'saved' ? 'idle' : prev));
          }, 1500);
        } catch (e: unknown) {
          const err = e as { message?: string };
          setError(err.message || '保存エラー');
          setSaveState('idle');
        }
      }, 1000);
    },
    [sb, accountId, note],
  );

  const onTitleChange = (v: string) => {
    setTitle(v);
    scheduleSave({ title: v });
  };
  const onCategoryChange = (v: string) => {
    setCategory(v);
    scheduleSave({ category: v as 'plan' | 'fb' | 'idea' | 'other' });
  };
  const onContentChange = (json: Record<string, unknown>) => {
    setContent(json);
    scheduleSave({ content_rich: json });
  };

  // ============================================================
  // Delete
  // ============================================================
  const handleDelete = async () => {
    if (!note) return;
    if (!confirm('この付箋を削除しますか？')) return;
    setError(null);
    try {
      const headers = await apiAuthHeaders(sb);
      const res = await fetch(
        `/api/cast-sticky-notes/${note.id}?account_id=${accountId}`,
        { method: 'DELETE', headers },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      onDelete?.(note.id);
      onClose();
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err.message || '削除エラー');
    }
  };

  // ============================================================
  // Close
  // ============================================================
  const handleClose = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (changedRef.current) onChanged?.();
    changedRef.current = false;
    onClose();
  };

  const uploadPrefix = useMemo(() => `sticky/${castName}`, [castName]);

  if (!open || !note) return null;

  const catInfo = CATEGORIES.find((c) => c.key === category) || CATEGORIES[3];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 py-8 overflow-y-auto"
      onClick={handleClose}
    >
      <div
        className="rounded-xl w-[720px] max-w-[95vw] max-h-[88vh] flex flex-col"
        style={{
          background: 'var(--bg-card)',
          border: `1px solid ${catInfo.color}40`,
          boxShadow: `0 0 0 2px ${catInfo.color}22`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-5 py-3 rounded-t-xl"
          style={{ borderBottom: '1px solid var(--border-primary)' }}
        >
          <span className="text-base">📌</span>
          <input
            type="text"
            value={title}
            placeholder="付箋のタイトル..."
            onChange={(e) => onTitleChange(e.target.value)}
            className="flex-1 min-w-0 text-base font-bold bg-transparent outline-none"
            style={{ color: 'var(--text-primary)' }}
            autoFocus
          />
          {saveState === 'saving' && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              保存中...
            </span>
          )}
          {saveState === 'saved' && (
            <span className="text-[11px]" style={{ color: '#4ade80' }}>
              ✓ 保存済み
            </span>
          )}
          <button
            onClick={handleDelete}
            className="text-sm opacity-50 hover:opacity-100 transition-opacity px-2"
            title="削除"
          >
            🗑
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

          {/* Category selector */}
          <div className="flex items-center gap-2">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              カテゴリ:
            </span>
            <div className="flex gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  onClick={() => onCategoryChange(c.key)}
                  className="text-[11px] px-2.5 py-1 rounded-full transition-colors"
                  style={{
                    background:
                      category === c.key ? `${c.color}33` : 'rgba(255,255,255,0.03)',
                    color: category === c.key ? c.color : 'var(--text-muted)',
                    border: `1px solid ${
                      category === c.key ? `${c.color}60` : 'rgba(255,255,255,0.08)'
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
            value={content}
            onChange={onContentChange}
            sb={sb}
            uploadPrefix={uploadPrefix}
          />
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
          付箋メモはキャスト全体に紐づくグローバルメモです。編集内容は1秒後に自動保存されます。
        </div>
      </div>
    </div>
  );
}
