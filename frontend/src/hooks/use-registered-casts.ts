'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { RegisteredCast } from '@/types';

interface UseRegisteredCastsOptions {
  accountId: string | null;
  /** true（デフォルト）で is_active=true のみ取得 */
  activeOnly?: boolean;
  /** select するカラム（デフォルト: '*'） */
  columns?: string;
}

interface UseRegisteredCastsReturn {
  casts: RegisteredCast[];
  castNames: string[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * registered_casts テーブルからキャスト一覧を取得する共通hook。
 * 複数ページで重複していた SELECT registered_casts クエリを統合。
 */
export function useRegisteredCasts({
  accountId,
  activeOnly = true,
  columns = '*',
}: UseRegisteredCastsOptions): UseRegisteredCastsReturn {
  const [casts, setCasts] = useState<RegisteredCast[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!accountId) {
      setCasts([]);
      return;
    }
    setLoading(true);
    setError(null);

    const supabase = createClient();
    let query = supabase
      .from('registered_casts')
      .select(columns)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    query.then(({ data, error: err }) => {
      if (err) {
        setError(err.message);
        setCasts([]);
      } else {
        setCasts((data || []) as unknown as RegisteredCast[]);
      }
      setLoading(false);
    });
  }, [accountId, activeOnly, columns, tick]);

  const castNames = useMemo(() => casts.map(c => c.cast_name), [casts]);

  return { casts, castNames, loading, error, refetch };
}
