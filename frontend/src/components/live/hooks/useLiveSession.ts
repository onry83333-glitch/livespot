'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getTodayStartJST } from '@/lib/utils';

export interface LiveSessionData {
  sessionId: string | null;
  startedAt: string | null;
  elapsedSeconds: number;
  viewerCount: number;
  peakViewerCount: number;
  todayRevenue: number;
  todayTipCount: number;
  isLive: boolean;
}

export function useLiveSession(castName: string) {
  const [data, setData] = useState<LiveSessionData>({
    sessionId: null,
    startedAt: null,
    elapsedSeconds: 0,
    viewerCount: 0,
    peakViewerCount: 0,
    todayRevenue: 0,
    todayTipCount: 0,
    isLive: false,
  });
  const supabase = useRef(createClient());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<string | null>(null);

  // Load today's session + revenue
  const loadSession = useCallback(async () => {
    const sb = supabase.current;
    const todayStart = getTodayStartJST().toISOString();

    // Get the latest session for this cast today
    const { data: sessions } = await sb
      .from('sessions')
      .select('id, session_id, started_at, ended_at')
      .eq('cast_name', castName)
      .gte('started_at', todayStart)
      .order('started_at', { ascending: false })
      .limit(1);

    const session = sessions?.[0];
    const isLive = session ? !session.ended_at : false;

    // Get today's revenue from coin_transactions
    const { data: revenue } = await sb
      .from('coin_transactions')
      .select('tokens')
      .eq('cast_name', castName)
      .gte('transaction_date', todayStart);

    const todayRevenue = revenue?.reduce((sum, r) => sum + (r.tokens || 0), 0) ?? 0;
    const todayTipCount = revenue?.length ?? 0;

    // Get latest viewer count from spy_viewers
    const { data: viewers } = await sb
      .from('spy_viewers')
      .select('user_name')
      .eq('cast_name', castName)
      .gte('last_seen_at', new Date(Date.now() - 5 * 60000).toISOString());

    const viewerCount = viewers?.length ?? 0;

    startedAtRef.current = session?.started_at ?? null;

    setData(prev => ({
      sessionId: session?.session_id ?? null,
      startedAt: session?.started_at ?? null,
      elapsedSeconds: session?.started_at
        ? Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000)
        : 0,
      viewerCount,
      peakViewerCount: Math.max(prev.peakViewerCount, viewerCount),
      todayRevenue,
      todayTipCount,
      isLive,
    }));
  }, [castName]);

  // Elapsed time ticker
  useEffect(() => {
    loadSession();
    timerRef.current = setInterval(() => {
      if (startedAtRef.current) {
        setData(prev => ({
          ...prev,
          elapsedSeconds: Math.floor(
            (Date.now() - new Date(startedAtRef.current!).getTime()) / 1000
          ),
        }));
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [loadSession]);

  // Update viewer count from realtime events
  const updateViewerCount = useCallback((count: number) => {
    setData(prev => ({
      ...prev,
      viewerCount: count,
      peakViewerCount: Math.max(prev.peakViewerCount, count),
    }));
  }, []);

  // Add revenue from realtime tip events
  const addRevenue = useCallback((tokens: number) => {
    setData(prev => ({
      ...prev,
      todayRevenue: prev.todayRevenue + tokens,
      todayTipCount: prev.todayTipCount + 1,
    }));
  }, []);

  return { ...data, updateViewerCount, addRevenue, refresh: loadSession };
}
