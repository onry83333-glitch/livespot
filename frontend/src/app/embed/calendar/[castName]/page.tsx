'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import ActivityCalendar from '@/components/calendar/activity-calendar';

/**
 * Notion 埋め込み用カレンダーページ。
 *
 * URL 例:
 *   https://livespot-rouge.vercel.app/embed/calendar/Risa_06
 *   https://livespot-rouge.vercel.app/embed/calendar/hanshakun
 *
 * - 認証不要（/embed/* は AuthProvider / AppShell でバイパス済み）
 * - 背景は透過（/embed/layout.tsx）
 * - 日付セルクリックで SLS の該当キャストページを新しいタブで開く
 */
export default function EmbedCalendarPage() {
  const params = useParams<{ castName: string }>();
  const castName = decodeURIComponent((params?.castName as string) || '');

  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // account_id をキャスト名から解決。
  // SLS は単一テナント運用のため、accounts テーブルの先頭 1 件を採用する
  // （既存の casts/[castName]/page.tsx と同一ロジック）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await sb
        .from('accounts')
        .select('id')
        .limit(1)
        .single();
      if (cancelled) return;
      if (error || !data) {
        setError('アカウント情報を取得できませんでした');
        return;
      }
      setAccountId(data.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [sb]);

  const targetHref = useMemo(
    () => `/casts/${encodeURIComponent(castName)}?tab=calendar`,
    [castName]
  );

  const handleDayClick = (_activityDate: string) => {
    // 日付セルクリックで SLS の該当キャスト運用カレンダーを新規タブで開く。
    // Notion 埋め込み iframe の同一オリジン制約を避けるため window.open を使用。
    if (typeof window === 'undefined') return;
    window.open(targetHref, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="dark"
      style={{
        // Notion のダークモードに馴染ませるための最小限のトーン調整。
        // ActivityCalendar 内は CSS 変数 (--bg-card, --border-primary 等) を参照するため、
        // globals.css 由来のダークテーマ変数が自動的に効く。
        color: 'var(--text-primary)',
        padding: '12px',
      }}
    >
      {error ? (
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
      ) : !accountId ? (
        <div
          className="flex items-center justify-center py-10 text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          <div className="flex items-center gap-2">
            <div
              className="w-4 h-4 border-2 rounded-full animate-spin"
              style={{
                borderColor: 'var(--border-primary)',
                borderTopColor: 'transparent',
              }}
            />
            読み込み中...
          </div>
        </div>
      ) : (
        <ActivityCalendar
          accountId={accountId}
          castName={castName}
          sb={sb}
          embedMode
          onDayClick={handleDayClick}
        />
      )}
    </div>
  );
}
