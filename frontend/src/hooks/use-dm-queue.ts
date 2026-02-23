'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { DMLog } from '@/types';

export function useDMQueue(accountId: string) {
  const [queue, setQueue] = useState<DMLog[]>([]);
  const [stats, setStats] = useState({ queued: 0, sending: 0, success: 0, error: 0 });
  const supabaseRef = useRef(createClient());
  const channelRef = useRef<ReturnType<typeof supabaseRef.current.channel> | null>(null);
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;

  const loadQueue = useCallback(async () => {
    const aid = accountIdRef.current;
    if (!aid) return;
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data } = await supabaseRef.current
        .from('dm_send_log')
        .select('*')
        .eq('account_id', aid)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100);
      const items = data ?? [];
      setQueue(items);
      const s = { queued: 0, sending: 0, success: 0, error: 0 };
      for (const item of items) {
        if (item.status in s) s[item.status as keyof typeof s]++;
      }
      setStats(s);
    } catch {
      /* ignore */
    }
  }, []);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!accountId) return;
    loadQueue();

    // 重複subscribe防止
    if (channelRef.current) {
      supabaseRef.current.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabaseRef.current
      .channel(`dm-queue-${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'dm_send_log',
          filter: `account_id=eq.${accountId}`,
        },
        () => { loadQueue(); }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[Realtime] dm-queue error:', status, err);
        }
      });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabaseRef.current.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [accountId]); // loadQueueはuseCallback([])で安定

  return { queue, stats, refresh: loadQueue };
}
