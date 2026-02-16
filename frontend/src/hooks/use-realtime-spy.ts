'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SpyMessage } from '@/types';

interface UseRealtimeSpyOptions {
  castName?: string;
  enabled?: boolean;
}

export function useRealtimeSpy({ castName, enabled = true }: UseRealtimeSpyOptions) {
  const [allMessages, setAllMessages] = useState<SpyMessage[]>([]);
  const [castNames, setCastNames] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const supabaseRef = useRef(createClient());

  // キャスト一覧を取得（spy_messagesのdistinct cast_name）
  const loadCastNames = useCallback(async () => {
    const { data, error } = await supabaseRef.current
      .from('spy_messages')
      .select('cast_name')
      .order('created_at', { ascending: false });

    if (error) {
      return;
    }
    if (data) {
      const unique = Array.from(new Set(data.map(r => r.cast_name)));
      setCastNames(unique);
    }
  }, []);

  // 初回ロード: 直近200件を取得（全キャスト）
  const loadMessages = useCallback(async () => {
    const { data, error } = await supabaseRef.current
      .from('spy_messages')
      .select('*')
      .order('message_time', { ascending: false })
      .limit(200);

    if (error) {
      return;
    }
    if (data) {
      setAllMessages(data.reverse()); // 古い順に並べる
    }
  }, []);

  // デモデータ挿入 — エラーメッセージを返す
  const insertDemoData = useCallback(async (accountId: string): Promise<string | null> => {
    const now = new Date();
    const demoMessages = [
      { account_id: accountId, cast_name: 'サクラ', message_time: new Date(now.getTime() - 4000).toISOString(), msg_type: 'chat', user_name: 'BigSpender88', message: 'サクラちゃん今日もかわいいね！', tokens: 0, is_vip: false, metadata: {} },
      { account_id: accountId, cast_name: 'サクラ', message_time: new Date(now.getTime() - 3000).toISOString(), msg_type: 'tip', user_name: 'VIP_Dragon', message: 'いつも応援してるよ！', tokens: 500, is_vip: true, metadata: {} },
      { account_id: accountId, cast_name: 'サクラ', message_time: new Date(now.getTime() - 2000).toISOString(), msg_type: 'enter', user_name: 'NewUser_001', message: null, tokens: 0, is_vip: false, metadata: {} },
      { account_id: accountId, cast_name: 'ミキ', message_time: new Date(now.getTime() - 1000).toISOString(), msg_type: 'tip', user_name: 'WhaleKing', message: 'ミキちゃんにプレゼント！', tokens: 2000, is_vip: true, metadata: {} },
      { account_id: accountId, cast_name: 'サクラ', message_time: now.toISOString(), msg_type: 'chat', user_name: 'Regular_Fan', message: '今日の配信何時まで？', tokens: 0, is_vip: false, metadata: {} },
    ];

    const { error } = await supabaseRef.current
      .from('spy_messages')
      .insert(demoMessages);

    if (error) {
      return `${error.message}${error.hint ? ` (${error.hint})` : ''}`;
    }

    return null;
  }, []);

  // Realtime subscription — 全メッセージを購読（フィルタはUI側で行う）
  useEffect(() => {
    if (!enabled) return;

    loadMessages();
    loadCastNames();

    const channel = supabaseRef.current
      .channel('spy-realtime')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'spy_messages',
        },
        (payload) => {
          const msg = payload.new as SpyMessage;

          setAllMessages(prev => [...prev, msg].slice(-500));

          // キャスト一覧にない新しいキャストなら追加
          setCastNames(prev =>
            prev.includes(msg.cast_name) ? prev : [...prev, msg.cast_name]
          );
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      supabaseRef.current.removeChannel(channel);
      setIsConnected(false);
    };
  }, [enabled, loadMessages, loadCastNames]);

  // キャストフィルタ適用済みメッセージ
  const messages = castName
    ? allMessages.filter(m => m.cast_name === castName)
    : allMessages;

  // キャストの今日のspy_messagesを削除（account_idフィルタ付き）
  const deleteCastMessages = useCallback(async (targetCastName: string): Promise<string | null> => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { error } = await supabaseRef.current
      .from('spy_messages')
      .delete()
      .eq('cast_name', targetCastName)
      .gte('message_time', todayStart.toISOString());

    if (error) {
      return error.message;
    }

    // ローカルステートからも削除
    setAllMessages(prev => prev.filter(m => m.cast_name !== targetCastName));
    setCastNames(prev => prev.filter(n => n !== targetCastName));
    return null;
  }, []);

  return { messages, allMessages, castNames, isConnected, refresh: loadMessages, insertDemoData, deleteCastMessages };
}
