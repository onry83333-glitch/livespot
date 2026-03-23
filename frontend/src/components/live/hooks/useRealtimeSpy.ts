'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { mapChatLog } from '@/lib/table-mappers';
import type { SpyMessage } from '@/types';

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

interface UseRealtimeSpyLiveOptions {
  castName: string;
  onMessage?: (msg: SpyMessage) => void;
}

/**
 * spy_messages (chat_logs) Realtime購読 — /live ページ専用
 * 新規INSERTをリアルタイム受信し、コールバックで通知する
 */
export function useRealtimeSpyLive({ castName, onMessage }: UseRealtimeSpyLiveOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const supabase = useRef(createClient());
  const channelRef = useRef<ReturnType<typeof supabase.current.channel> | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!castName) return;

    // 重複subscribe防止
    if (channelRef.current) return;

    const channel = supabase.current
      .channel(`live-spy-${castName}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_logs',
          filter: `cast_name=eq.${castName}`,
        },
        (payload) => {
          const msg = mapChatLog(payload.new) as SpyMessage;
          // account_idフィルタ（Realtimeはカラム1つのみフィルタ可能）
          if (msg.account_id !== ACCOUNT_ID) return;
          onMessageRef.current?.(msg);
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
