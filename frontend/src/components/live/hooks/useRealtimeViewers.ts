'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

interface UseRealtimeViewersOptions {
  castName: string;
  onViewerUpdate?: (count: number) => void;
}

/**
 * spy_viewers Realtime購読 — 視聴者スナップショットの更新を検出
 */
export function useRealtimeViewers({ castName, onViewerUpdate }: UseRealtimeViewersOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const supabase = useRef(createClient());
  const channelRef = useRef<ReturnType<typeof supabase.current.channel> | null>(null);
  const onViewerUpdateRef = useRef(onViewerUpdate);
  onViewerUpdateRef.current = onViewerUpdate;

  useEffect(() => {
    if (!castName) return;
    if (channelRef.current) return;

    const channel = supabase.current
      .channel(`live-viewers-${castName}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'spy_viewers',
          filter: `cast_name=eq.${castName}`,
        },
        (payload) => {
          const row = payload.new as { account_id?: string };
          if (row.account_id !== ACCOUNT_ID) return;

          // viewer_countの取得: spy_viewersの直近5分のユニークユーザー数をカウント
          supabase.current
            .from('spy_viewers')
            .select('user_name', { count: 'exact', head: true })
            .eq('cast_name', castName)
            .eq('account_id', ACCOUNT_ID)
            .gte('last_seen_at', new Date(Date.now() - 5 * 60000).toISOString())
            .then(({ count }) => {
              if (count != null) onViewerUpdateRef.current?.(count);
            });
        }
      );

    subscribeWithRetry(channel, (status) => {
      if (status === 'SUBSCRIBED') setIsConnected(true);
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setIsConnected(false);
      }
    });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.current.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      setIsConnected(false);
    };
  }, [castName]);

  return { isConnected };
}
