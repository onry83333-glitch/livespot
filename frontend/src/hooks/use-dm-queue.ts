'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { DMLog } from '@/types';

export function useDMQueue(accountId: string) {
  const [queue, setQueue] = useState<DMLog[]>([]);
  const [stats, setStats] = useState({ queued: 0, sending: 0, success: 0, error: 0 });

  const loadQueue = useCallback(async () => {
    if (!accountId) return;
    try {
      const supabase = createClient();
      const since = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const { data } = await supabase
        .from('dm_send_log')
        .select('*')
        .eq('account_id', accountId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(100);
      setQueue(data ?? []);
      updateStats(data ?? []);
    } catch (e) {
    }
  }, [accountId]);

  function updateStats(items: DMLog[]) {
    const s = { queued: 0, sending: 0, success: 0, error: 0 };
    for (const item of items) {
      if (item.status in s) s[item.status as keyof typeof s]++;
    }
    setStats(s);
  }

  // Subscribe to realtime updates
  useEffect(() => {
    if (!accountId) return;
    loadQueue();

    const supabase = createClient();
    const channel = supabase
      .channel(`dm:${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'dm_send_log',
          filter: `account_id=eq.${accountId}`,
        },
        () => {
          // Reload on any change
          loadQueue();
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [accountId, loadQueue]);

  return { queue, stats, refresh: loadQueue };
}
