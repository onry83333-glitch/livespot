'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { getWeekStartJST } from '@/lib/utils';

interface UseCoinStatsOptions {
  accountId: string | null;
  castName: string;
  /** registeredAt以降のみ取得（データ分離用） */
  registeredAt?: string | null;
}

interface CoinStats {
  totalTokens: number;
  thisWeekTokens: number;
  lastWeekTokens: number;
  daysSinceSync: number | null;
}

interface UseCoinStatsReturn extends CoinStats {
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * coin_transactions テーブルからキャスト別のトークン集計を取得する共通hook。
 * 各ページで重複していた total / weekly / lastSync クエリを統合。
 */
export function useCoinStats({
  accountId,
  castName,
  registeredAt,
}: UseCoinStatsOptions): UseCoinStatsReturn {
  const [stats, setStats] = useState<CoinStats>({
    totalTokens: 0,
    thisWeekTokens: 0,
    lastWeekTokens: 0,
    daysSinceSync: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const thisMonday = getWeekStartJST(0);
    const lastMonday = getWeekStartJST(1);
    const regFilter = registeredAt || null;
    const thisStart = regFilter && regFilter > thisMonday.toISOString() ? regFilter : thisMonday.toISOString();
    const lastStart = regFilter && regFilter > lastMonday.toISOString() ? regFilter : lastMonday.toISOString();

    Promise.all([
      // 1. total tokens (all time, exclude studio)
      supabase
        .from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .neq('type', 'studio')
        .limit(50000),
      // 2. this week tokens
      supabase
        .from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .neq('type', 'studio')
        .gte('date', thisStart)
        .limit(10000),
      // 3. last week tokens
      supabase
        .from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .neq('type', 'studio')
        .gte('date', lastStart)
        .lt('date', thisMonday.toISOString())
        .limit(10000),
      // 4. last sync date
      supabase
        .from('coin_transactions')
        .select('date')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .order('date', { ascending: false })
        .limit(1)
        .single(),
    ]).then(([totalRes, thisWeekRes, lastWeekRes, syncRes]) => {
      const sum = (data: { tokens: number }[] | null) =>
        (data || []).reduce((s, r) => s + (r.tokens || 0), 0);

      let daysSinceSync: number | null = null;
      if (syncRes.data?.date) {
        daysSinceSync = Math.floor(
          (Date.now() - new Date(syncRes.data.date).getTime()) / (1000 * 60 * 60 * 24)
        );
      }

      setStats({
        totalTokens: sum(totalRes.data),
        thisWeekTokens: sum(thisWeekRes.data),
        lastWeekTokens: sum(lastWeekRes.data),
        daysSinceSync,
      });
      setLoading(false);
    }).catch(err => {
      setError(err?.message || 'coin_transactions fetch error');
      setLoading(false);
    });
  }, [accountId, castName, registeredAt, tick]);

  return { ...stats, loading, error, refetch };
}
