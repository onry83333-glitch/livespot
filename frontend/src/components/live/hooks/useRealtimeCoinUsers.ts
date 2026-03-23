'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { getTodayStartJST } from '@/lib/utils';

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

export interface ViewerStatsPoint {
  totalViewers: number;
  coinUsers: number;
  ultimateMembers: number;
  recordedAt: string;
}

interface UseRealtimeCoinUsersOptions {
  castName: string;
}

/**
 * live_viewer_stats Realtime購読
 * Chrome拡張が1分ごとにinsertするコイン有りユーザー数・アルティメット会員数を受信
 */
export function useRealtimeCoinUsers({ castName }: UseRealtimeCoinUsersOptions) {
  const [history, setHistory] = useState<ViewerStatsPoint[]>([]);
  const [latest, setLatest] = useState<ViewerStatsPoint | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const supabase = useRef(createClient());
  const channelRef = useRef<ReturnType<typeof supabase.current.channel> | null>(null);

  // Initial load: today's data
  const loadHistory = useCallback(async () => {
    const todayStart = getTodayStartJST().toISOString();
    const { data } = await supabase.current
      .from('live_viewer_stats')
      .select('total_viewers, coin_users, ultimate_members, recorded_at')
      .eq('cast_name', castName)
      .eq('account_id', ACCOUNT_ID)
      .gte('recorded_at', todayStart)
      .order('recorded_at', { ascending: true });

    if (data && data.length > 0) {
      const points: ViewerStatsPoint[] = data.map((r) => ({
        totalViewers: r.total_viewers,
        coinUsers: r.coin_users,
        ultimateMembers: r.ultimate_members,
        recordedAt: r.recorded_at,
      }));
      setHistory(points);
      setLatest(points[points.length - 1]);
    }
  }, [castName]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Realtime subscription
  useEffect(() => {
    if (!castName) return;
    if (channelRef.current) return;

    const channel = supabase.current
      .channel(`live-coin-users-${castName}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'live_viewer_stats',
          filter: `cast_name=eq.${castName}`,
        },
        (payload) => {
          const row = payload.new as {
            account_id?: string;
            total_viewers: number;
            coin_users: number;
            ultimate_members: number;
            recorded_at: string;
          };
          if (row.account_id !== ACCOUNT_ID) return;

          const point: ViewerStatsPoint = {
            totalViewers: row.total_viewers,
            coinUsers: row.coin_users,
            ultimateMembers: row.ultimate_members,
            recordedAt: row.recorded_at,
          };

          setHistory((prev) => [...prev, point]);
          setLatest(point);
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

  return { history, latest, isConnected };
}
