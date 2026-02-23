'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';

/* ============================================================
   Types
   ============================================================ */
interface CastInfo {
  cast_name: string;
  display_name: string | null;
  account_id: string;
}

interface CastDmStats {
  cast_name: string;
  last_sent_at: string | null;
  queued_count: number;
  total_sent: number;
}

/* ============================================================
   Page — キャスト選択 → /casts/{castName}?tab=dm にリダイレクト
   ============================================================ */
export default function DmPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [casts, setCasts] = useState<CastInfo[]>([]);
  const [dmStats, setDmStats] = useState<Map<string, CastDmStats>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    const sb = createClient();

    const load = async () => {
      // キャスト一覧取得
      const { data: castData } = await sb
        .from('registered_casts')
        .select('cast_name, display_name, account_id')
        .eq('is_active', true)
        .order('cast_name');

      const castList = (castData || []) as CastInfo[];
      setCasts(castList);

      // キャスト1人 → 自動リダイレクト
      if (castList.length === 1) {
        router.replace(`/casts/${encodeURIComponent(castList[0].cast_name)}?tab=dm`);
        return;
      }

      // 各キャストのDM統計を取得
      if (castList.length > 0) {
        const accountIds = Array.from(new Set(castList.map(c => c.account_id)));

        const { data: logData } = await sb
          .from('dm_send_log')
          .select('cast_name, status, sent_at')
          .in('account_id', accountIds)
          .order('sent_at', { ascending: false });

        const statsMap = new Map<string, CastDmStats>();
        for (const cast of castList) {
          statsMap.set(cast.cast_name, {
            cast_name: cast.cast_name,
            last_sent_at: null,
            queued_count: 0,
            total_sent: 0,
          });
        }

        for (const log of (logData || [])) {
          const cn = log.cast_name;
          if (!cn || !statsMap.has(cn)) continue;
          const s = statsMap.get(cn)!;
          s.total_sent++;
          if (log.status === 'queued' || log.status === 'sending') s.queued_count++;
          if (log.status === 'success' && log.sent_at && (!s.last_sent_at || log.sent_at > s.last_sent_at)) {
            s.last_sent_at = log.sent_at;
          }
        }
        setDmStats(statsMap);
      }

      setLoading(false);
    };

    load();
  }, [user, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-2 rounded-full animate-spin mb-3"
            style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</p>
        </div>
      </div>
    );
  }

  if (casts.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="glass-card p-8 text-center max-w-md">
          <p className="text-3xl mb-3">📨</p>
          <h2 className="text-lg font-bold mb-2">DM管理</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
            キャストを登録するとDM管理機能が使えます
          </p>
          <button
            onClick={() => router.push('/casts')}
            className="btn-primary text-sm px-6 py-2"
          >
            キャスト一覧へ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold">📨 DM管理</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          キャストを選択してDM管理画面に移動します
        </p>
      </div>

      {/* Cast cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {casts.map(cast => {
          const stats = dmStats.get(cast.cast_name);
          return (
            <button
              key={cast.cast_name}
              onClick={() => router.push(`/casts/${encodeURIComponent(cast.cast_name)}?tab=dm`)}
              className="glass-card-hover p-5 text-left transition-all"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg"
                  style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(168,85,247,0.2))' }}>
                  🎭
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold truncate">{cast.cast_name}</p>
                  {cast.display_name && (
                    <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {cast.display_name}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                {stats && stats.queued_count > 0 && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent-amber)' }} />
                    <span style={{ color: 'var(--accent-amber)' }}>
                      送信待ち: {stats.queued_count}件
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  <span>送信済み: {stats?.total_sent?.toLocaleString() ?? 0}件</span>
                  <span>
                    {stats?.last_sent_at
                      ? `最終: ${new Date(stats.last_sent_at).toLocaleDateString('ja-JP')}`
                      : '未送信'}
                  </span>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t text-center" style={{ borderColor: 'var(--border-glass)' }}>
                <span className="text-[11px] font-semibold" style={{ color: 'var(--accent-primary)' }}>
                  DM管理を開く →
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
