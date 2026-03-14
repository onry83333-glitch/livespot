'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

interface AggregatedUser {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
  tx_count: number;
  first_date: string | null;
}

type PeriodKey = '7d' | '30d' | '90d' | 'all' | 'custom';

interface TierDef {
  id: string;
  label: string;
  color: string;
  users: AggregatedUser[];
  minTk: number;
  maxTk: number;
}

interface Props {
  supabase: SupabaseClient;
  accountId: string;
  castName: string;
  onSendComplete?: () => void;
}

// ============================================================
// Constants
// ============================================================

const TIER_COLORS = ['#f59e0b', '#a78bfa', '#38bdf8', '#22c55e', '#94a3b8'];

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

function tkRangeLabel(minTk: number, maxTk: number): string {
  if (minTk === maxTk) return `${minTk.toLocaleString()}tk`;
  return `${minTk.toLocaleString()}〜${maxTk.toLocaleString()}tk`;
}

/**
 * 黄金比で自動分類。同一金額が多い場合は適応的にTier数を減らす。
 * 二次ソート: 同一tk → tx_count降順 → 初回課金日昇順（古い方が上位）
 */
function computeSmartTiers(users: AggregatedUser[]): TierDef[] {
  if (users.length === 0) return [];

  // 二次ソート: tk降順 → tx_count降順 → first_date昇順
  const sorted = [...users].sort((a, b) => {
    if (b.total_coins !== a.total_coins) return b.total_coins - a.total_coins;
    if (b.tx_count !== a.tx_count) return b.tx_count - a.tx_count;
    // 古い日付を上位に
    const da = a.first_date || '9999';
    const db = b.first_date || '9999';
    return da.localeCompare(db);
  });

  // ユニークな金額帯を確認
  const uniqueTkValues = new Set(sorted.map(u => u.total_coins));

  // 金額バリエーションが少なすぎる場合は無理に分けない
  if (uniqueTkValues.size === 1) {
    // 全員同じ金額
    const tk = sorted[0].total_coins;
    return [{
      id: 'all',
      label: `全員 ${tk.toLocaleString()}tk`,
      color: TIER_COLORS[0],
      users: sorted,
      minTk: tk,
      maxTk: tk,
    }];
  }

  if (uniqueTkValues.size === 2) {
    const vals = Array.from(uniqueTkValues).sort((a, b) => b - a);
    const upper = sorted.filter(u => u.total_coins === vals[0]);
    const lower = sorted.filter(u => u.total_coins === vals[1]);
    return [
      { id: 't1', label: `${vals[0].toLocaleString()}tk`, color: TIER_COLORS[0], users: upper, minTk: vals[0], maxTk: vals[0] },
      { id: 't2', label: `${vals[1].toLocaleString()}tk`, color: TIER_COLORS[2], users: lower, minTk: vals[1], maxTk: vals[1] },
    ];
  }

  // 黄金比で分割（境界で同一金額を分断しないよう調整）
  const n = sorted.length;

  function splitAtBoundary(arr: AggregatedUser[], ratio: number): [AggregatedUser[], AggregatedUser[]] {
    if (arr.length <= 1) return [arr, []];
    const idealCut = Math.max(1, Math.ceil(arr.length * ratio));
    // 境界の金額を確認
    let cut = idealCut;
    const boundaryTk = arr[Math.min(cut - 1, arr.length - 1)].total_coins;
    // 同じ金額は同じグループに入れる — 下に寄せる
    while (cut < arr.length && arr[cut].total_coins === boundaryTk) {
      cut++;
    }
    // もし全員同じグループに入ってしまったら、idealCutで強制分割
    if (cut >= arr.length) {
      // 上に寄せてみる
      cut = idealCut;
      while (cut > 1 && arr[cut - 1].total_coins === arr[cut].total_coins) {
        cut--;
      }
    }
    return [arr.slice(0, cut), arr.slice(cut)];
  }

  // 上位38.2% / 下位61.8%
  const [upper, lower] = splitAtBoundary(sorted, 0.382);

  if (lower.length === 0) {
    // 分割できなかった
    return [{
      id: 'all',
      label: tkRangeLabel(sorted[n - 1].total_coins, sorted[0].total_coins),
      color: TIER_COLORS[0],
      users: sorted,
      minTk: sorted[n - 1].total_coins,
      maxTk: sorted[0].total_coins,
    }];
  }

  // 上位をさらに分割
  const [tier1, tier2] = splitAtBoundary(upper, 0.382);

  // 下位をさらに分割
  const [tier3, lowerLower] = splitAtBoundary(lower, 0.382);
  const [tier4, tier5] = splitAtBoundary(lowerLower, 0.382);

  // 空でないTierだけ集める
  const rawTiers = [tier1, tier2, tier3, tier4, tier5].filter(t => t.length > 0);

  // 隣接Tierが同じtk範囲なら統合
  const merged: AggregatedUser[][] = [];
  for (const tier of rawTiers) {
    const tierMin = tier[tier.length - 1].total_coins;
    const tierMax = tier[0].total_coins;
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevMin = prev[prev.length - 1].total_coins;
      const prevMax = prev[0].total_coins;
      if (tierMin === prevMin && tierMax === prevMax) {
        merged[merged.length - 1] = [...prev, ...tier];
        continue;
      }
    }
    merged.push(tier);
  }

  return merged.map((tierUsers, i) => {
    const minTk = tierUsers[tierUsers.length - 1].total_coins;
    const maxTk = tierUsers[0].total_coins;
    return {
      id: `t${i}`,
      label: tkRangeLabel(minTk, maxTk),
      color: TIER_COLORS[i % TIER_COLORS.length],
      users: tierUsers,
      minTk,
      maxTk,
    };
  });
}

// ============================================================
// Component
// ============================================================

export default function DmSegmentSender({ supabase, accountId, castName }: Props) {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [customStart, setCustomStart] = useState(() => daysAgo(30));
  const [customEnd, setCustomEnd] = useState(() => formatDate(new Date()));
  const [activeTier, setActiveTier] = useState<number>(0);

  const [periodUsers, setPeriodUsers] = useState<AggregatedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [copySuccess, setCopySuccess] = useState(false);

  // Date range with labels
  const dateRange = useMemo(() => {
    const today = formatDate(new Date());
    if (period === 'custom') return { start: customStart, end: customEnd };
    if (period === '7d') return { start: daysAgo(7), end: today };
    if (period === '30d') return { start: daysAgo(30), end: today };
    if (period === '90d') return { start: daysAgo(90), end: today };
    return { start: '2025-02-15', end: today };
  }, [period, customStart, customEnd]);

  // Period button labels with date ranges
  const periodLabels = useMemo(() => {
    const today = formatDate(new Date());
    return [
      { key: '7d' as PeriodKey, label: `過去7日（${shortDate(daysAgo(7))}〜${shortDate(today)}）` },
      { key: '30d' as PeriodKey, label: `過去30日（${shortDate(daysAgo(30))}〜${shortDate(today)}）` },
      { key: '90d' as PeriodKey, label: `過去90日（${shortDate(daysAgo(90))}〜${shortDate(today)}）` },
      { key: 'all' as PeriodKey, label: '全期間' },
      { key: 'custom' as PeriodKey, label: 'カスタム' },
    ];
  }, []);

  // Fetch coin_transactions for the selected period
  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    setActiveTier(0);

    const fetchPeriodData = async () => {
      const { data, error } = await supabase
        .from('coin_transactions')
        .select('user_name, tokens, date')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .gt('tokens', 0)
        .gte('date', dateRange.start)
        .lte('date', dateRange.end);

      if (error) {
        console.error('[SegmentSender] query error:', error.message);
        setPeriodUsers([]);
        setLoading(false);
        return;
      }

      // Aggregate by user_name
      const map = new Map<string, { total: number; lastDate: string | null; firstDate: string | null; count: number }>();
      for (const row of data || []) {
        const name = row.user_name;
        if (!name || name === 'anonymous') continue;
        const existing = map.get(name);
        if (existing) {
          existing.total += row.tokens;
          existing.count += 1;
          if (row.date && (!existing.lastDate || row.date > existing.lastDate)) existing.lastDate = row.date;
          if (row.date && (!existing.firstDate || row.date < existing.firstDate)) existing.firstDate = row.date;
        } else {
          map.set(name, { total: row.tokens, lastDate: row.date, firstDate: row.date, count: 1 });
        }
      }

      const users: AggregatedUser[] = Array.from(map.entries()).map(([user_name, agg]) => ({
        user_name,
        total_coins: agg.total,
        last_payment_date: agg.lastDate,
        first_date: agg.firstDate,
        tx_count: agg.count,
      }));

      users.sort((a, b) => b.total_coins - a.total_coins);
      setPeriodUsers(users);
      setLoading(false);
    };

    fetchPeriodData();
  }, [supabase, accountId, castName, dateRange.start, dateRange.end]);

  // Compute tiers
  const tiers = useMemo(() => computeSmartTiers(periodUsers), [periodUsers]);

  const currentTier = tiers[activeTier] || null;
  const totalUsers = periodUsers.length;
  const totalTk = useMemo(() => periodUsers.reduce((s, u) => s + u.total_coins, 0), [periodUsers]);

  // Copy user names
  const handleCopy = useCallback(async () => {
    if (!currentTier || currentTier.users.length === 0) return;
    const text = currentTier.users.map(u => u.user_name).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  }, [currentTier]);

  return (
    <div className="space-y-4">
      {/* Period filter + stats */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold">🎯 黄金比セグメント分析</h3>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {loading ? '...' : `${totalUsers}名 / ${totalTk.toLocaleString()}tk`}
          </span>
        </div>

        <div className="mb-3">
          <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>
            📅 集計期間
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {periodLabels.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setPeriod(opt.key)}
                className="text-[11px] px-3 py-1.5 rounded-md transition-all"
                style={{
                  background: period === opt.key ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.04)',
                  color: period === opt.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  border: `1px solid ${period === opt.key ? 'rgba(56,189,248,0.3)' : 'rgba(56,189,248,0.06)'}`,
                  fontWeight: period === opt.key ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {period === 'custom' && (
          <div className="flex gap-2 mb-3">
            <div className="flex-1">
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>開始日</label>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="input-glass w-full text-xs" />
            </div>
            <div className="flex-1">
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>終了日</label>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="input-glass w-full text-xs" />
            </div>
          </div>
        )}
      </div>

      {/* Tier overview */}
      <div className="glass-card p-4">
        {loading ? (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>集計中...</span>
          </div>
        ) : tiers.length === 0 ? (
          <div className="text-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
            この期間のチッパーがいません
          </div>
        ) : (
          <>
            {/* Uniform detection message */}
            {tiers.length === 1 && tiers[0].minTk === tiers[0].maxTk && (
              <div className="mb-3 px-3 py-2 rounded-lg text-[11px]" style={{ background: 'rgba(245,158,11,0.08)', color: 'var(--accent-amber)' }}>
                この期間のチッパーは全員 {tiers[0].minTk.toLocaleString()}tk の均一課金です
              </div>
            )}

            {/* Tier tabs */}
            <div className="flex gap-1 mb-3 flex-wrap">
              {tiers.map((tier, i) => (
                <button
                  key={tier.id}
                  onClick={() => setActiveTier(i)}
                  className="text-[11px] px-3 py-2 rounded-lg transition-all flex-1 min-w-[70px] text-center"
                  style={{
                    background: activeTier === i ? `${tier.color}22` : 'rgba(255,255,255,0.03)',
                    color: activeTier === i ? tier.color : 'var(--text-muted)',
                    border: `1px solid ${activeTier === i ? `${tier.color}44` : 'rgba(255,255,255,0.05)'}`,
                    fontWeight: activeTier === i ? 600 : 400,
                  }}
                >
                  <div className="text-[10px]">{tier.label}</div>
                  <div className="text-[10px]">{tier.users.length}人</div>
                </button>
              ))}
            </div>

            {/* Active tier detail */}
            {currentTier && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="text-xs font-bold" style={{ color: currentTier.color }}>
                      {currentTier.label}
                    </span>
                    <span className="text-[10px] ml-2" style={{ color: 'var(--text-muted)' }}>
                      {currentTier.users.length}人
                    </span>
                  </div>
                  <button
                    onClick={handleCopy}
                    disabled={currentTier.users.length === 0}
                    className="text-[11px] px-3 py-1 rounded-lg font-semibold transition-colors disabled:opacity-30"
                    style={{
                      background: copySuccess ? 'rgba(34,197,94,0.15)' : 'rgba(56,189,248,0.1)',
                      border: `1px solid ${copySuccess ? 'rgba(34,197,94,0.3)' : 'rgba(56,189,248,0.2)'}`,
                      color: copySuccess ? 'var(--accent-green)' : 'var(--accent-primary)',
                    }}
                  >
                    {copySuccess ? 'Copied!' : 'ユーザー名コピー'}
                  </button>
                </div>

                {currentTier.users.length === 0 ? (
                  <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                    該当ユーザーなし
                  </div>
                ) : (
                  <div className="space-y-0.5 max-h-64 overflow-y-auto">
                    {currentTier.users.map((u, i) => (
                      <div
                        key={u.user_name}
                        className="flex items-center justify-between py-1 px-2 rounded text-xs"
                        style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}
                      >
                        <span style={{ color: 'var(--text-secondary)' }}>
                          <span className="text-[10px] mr-2" style={{ color: 'var(--text-muted)' }}>{i + 1}.</span>
                          {u.user_name}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {u.tx_count}回
                          </span>
                          <span style={{ color: currentTier.color }}>
                            {u.total_coins.toLocaleString()} tk
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Summary table */}
            {tiers.length > 1 && (
              <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>セグメント概要</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr style={{ color: 'var(--text-muted)' }}>
                        <th className="text-left py-1 px-2">金額帯</th>
                        <th className="text-right py-1 px-2">人数</th>
                        <th className="text-right py-1 px-2">%</th>
                        <th className="text-right py-1 px-2">合計tk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tiers.map((tier) => {
                        const tierTk = tier.users.reduce((s, u) => s + u.total_coins, 0);
                        const pct = totalUsers > 0 ? Math.round((tier.users.length / totalUsers) * 100) : 0;
                        return (
                          <tr key={tier.id} className="border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                            <td className="py-1 px-2" style={{ color: tier.color }}>
                              {tier.label}
                            </td>
                            <td className="py-1 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>
                              {tier.users.length}
                            </td>
                            <td className="py-1 px-2 text-right" style={{ color: 'var(--text-muted)' }}>
                              {pct}%
                            </td>
                            <td className="py-1 px-2 text-right font-bold" style={{ color: tier.color }}>
                              {tierTk.toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
