'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { mapChatLog } from '@/lib/table-mappers';
import type { SpyMessage } from '@/types';

interface UseRealtimeSpyOptions {
  castName?: string;
  accountId?: string;
  enabled?: boolean;
}

const MAX_MESSAGES = 2000;
const INITIAL_LOAD_LIMIT = 1000;

export function useRealtimeSpy({ castName, accountId, enabled = true }: UseRealtimeSpyOptions) {
  const [allMessages, setAllMessages] = useState<SpyMessage[]>([]);
  const [castNames, setCastNames] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const supabaseRef = useRef(createClient());
  // 既知のメッセージIDセット（重複防止）
  const knownIdsRef = useRef(new Set<number>());

  // キャスト一覧を取得（chat_logsのdistinct cast_name — 直近のみ）
  const loadCastNames = useCallback(async () => {
    let query = supabaseRef.current
      .from('chat_logs')
      .select('cast_name')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (accountId) query = query.eq('account_id', accountId);

    const { data, error } = await query;

    if (error) {
      return;
    }
    if (data) {
      const unique = Array.from(new Set(data.map(r => r.cast_name)));
      setCastNames(unique);
    }
  }, [accountId]);

  // DBからメッセージを取得（既存データとマージ）
  const loadMessages = useCallback(async () => {
    let query = supabaseRef.current
      .from('chat_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(INITIAL_LOAD_LIMIT);
    if (accountId) query = query.eq('account_id', accountId);

    const { data, error } = await query;

    if (error) {
      return;
    }
    if (data) {
      const sorted = data.map(mapChatLog).reverse(); // chat_logs→SpyMessageに変換 + 古い順に並べる

      // 既知IDセットを更新
      const newIds = new Set<number>();
      sorted.forEach(m => newIds.add(m.id));

      setAllMessages(prev => {
        // 既存のRealtimeメッセージとDBデータをマージ
        // DBにない（まだ反映されていない）Realtimeメッセージを保持
        const realtimeOnly = prev.filter(m => !newIds.has(m.id));
        const merged = [...sorted, ...realtimeOnly];
        // IDで重複排除
        const seen = new Set<number>();
        const deduped = merged.filter(m => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        // message_timeでソート
        deduped.sort((a, b) =>
          new Date(a.message_time).getTime() - new Date(b.message_time).getTime()
        );
        // 上限適用
        const result = deduped.slice(-MAX_MESSAGES);
        // knownIdsを更新
        knownIdsRef.current = new Set(result.map(m => m.id));
        return result;
      });
    }
  }, [accountId]);

  // デモデータ挿入 — エラーメッセージを返す
  const insertDemoData = useCallback(async (accountId: string): Promise<string | null> => {
    const now = new Date();
    const demoMessages = [
      { account_id: accountId, cast_name: 'サクラ', timestamp: new Date(now.getTime() - 4000).toISOString(), message_type: 'chat', username: 'BigSpender88', message: 'サクラちゃん今日もかわいいね！', tokens: 0, is_vip: false, metadata: {} },
      { account_id: accountId, cast_name: 'サクラ', timestamp: new Date(now.getTime() - 3000).toISOString(), message_type: 'tip', username: 'VIP_Dragon', message: 'いつも応援してるよ！', tokens: 500, is_vip: true, metadata: {} },
      { account_id: accountId, cast_name: 'サクラ', timestamp: new Date(now.getTime() - 2000).toISOString(), message_type: 'enter', username: 'NewUser_001', message: null, tokens: 0, is_vip: false, metadata: {} },
      { account_id: accountId, cast_name: 'ミキ', timestamp: new Date(now.getTime() - 1000).toISOString(), message_type: 'tip', username: 'WhaleKing', message: 'ミキちゃんにプレゼント！', tokens: 2000, is_vip: true, metadata: {} },
      { account_id: accountId, cast_name: 'サクラ', timestamp: now.toISOString(), message_type: 'chat', username: 'Regular_Fan', message: '今日の配信何時まで？', tokens: 0, is_vip: false, metadata: {} },
    ];

    const { error } = await supabaseRef.current
      .from('chat_logs')
      .insert(demoMessages);

    if (error) {
      return `${error.message}${error.hint ? ` (${error.hint})` : ''}`;
    }

    return null;
  }, []);

  // Realtime subscription — 全メッセージを購読（フィルタはUI側で行う）
  const channelRef = useRef<ReturnType<typeof supabaseRef.current.channel> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    loadMessages();
    loadCastNames();

    // 重複subscribe防止
    if (channelRef.current) return;

    const channelName = accountId ? `spy-realtime-${accountId.slice(0, 8)}` : 'spy-realtime';
    const channel = supabaseRef.current
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_logs',
          ...(accountId ? { filter: `account_id=eq.${accountId}` } : {}),
        },
        (payload) => {
          const msg = mapChatLog(payload.new) as SpyMessage;

          // 重複防止: 既にDBロードで取得済みのメッセージはスキップ
          if (knownIdsRef.current.has(msg.id)) return;
          knownIdsRef.current.add(msg.id);

          setAllMessages(prev => [...prev, msg].slice(-MAX_MESSAGES));

          // キャスト一覧にない新しいキャストなら追加
          setCastNames(prev =>
            prev.includes(msg.cast_name) ? prev : [...prev, msg.cast_name]
          );
        }
      )
    subscribeWithRetry(channel, (status) => {
        if (status === 'SUBSCRIBED') {
          setIsConnected(true);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setIsConnected(false);
        } else if (status === 'CLOSED') {
          setIsConnected(false);
        }
      });

    channelRef.current = channel;

    // Realtime再接続時にDBから再取得（件数リセット防止）
    reconnectRef.current = setInterval(() => {
      if (!channelRef.current) return;
      const state = channelRef.current.state;
      if (state === 'errored' || state === 'closed') {
        loadMessages();
        loadCastNames();
      }
    }, 30000);

    return () => {
      if (reconnectRef.current) clearInterval(reconnectRef.current);
      if (channelRef.current) {
        supabaseRef.current.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      setIsConnected(false);
    };
  }, [enabled]); // loadMessages/loadCastNamesはuseRef相当で安定、depsから除外

  // キャストフィルタ適用済みメッセージ
  const messages = castName
    ? allMessages.filter(m => m.cast_name === castName)
    : allMessages;

  // キャストの今日のchat_logsを削除（account_idフィルタ付き）
  const deleteCastMessages = useCallback(async (targetCastName: string): Promise<string | null> => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { error } = await supabaseRef.current
      .from('chat_logs')
      .delete()
      .eq('cast_name', targetCastName)
      .gte('timestamp', todayStart.toISOString());

    if (error) {
      return error.message;
    }

    // ローカルステートからも削除 + knownIdsも更新
    setAllMessages(prev => {
      const remaining = prev.filter(m => m.cast_name !== targetCastName);
      knownIdsRef.current = new Set(remaining.map(m => m.id));
      return remaining;
    });
    setCastNames(prev => prev.filter(n => n !== targetCastName));
    return null;
  }, []);

  return { messages, allMessages, castNames, isConnected, refresh: loadMessages, insertDemoData, deleteCastMessages };
}
