'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import type { DMLog } from '@/types';

export function useDMQueue(accountId: string, castName: string) {
  const [queue, setQueue] = useState<DMLog[]>([]);
  const [stats, setStats] = useState({ queued: 0, sending: 0, success: 0, error: 0 });
  const supabaseRef = useRef(createClient());
  const channelRef = useRef<ReturnType<typeof supabaseRef.current.channel> | null>(null);
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;
  const castNameRef = useRef(castName);
  castNameRef.current = castName;

  const loadQueue = useCallback(async () => {
    const aid = accountIdRef.current;
    const cn = castNameRef.current;
    if (!aid || !cn) return;
    try {
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data } = await supabaseRef.current
        .from('dm_send_log')
        .select('*')
        .eq('account_id', aid)
        .eq('cast_name', cn)
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
    if (!accountId || !castName) return;
    loadQueue();

    // 重複subscribe防止
    if (channelRef.current) {
      supabaseRef.current.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channel = supabaseRef.current
      .channel('dm-queue-realtime')
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
    subscribeWithRetry(channel);

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabaseRef.current.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [accountId, castName]); // loadQueueはuseCallback([])で安定

  return { queue, stats, refresh: loadQueue };
}
