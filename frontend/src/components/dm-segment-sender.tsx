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
}

type PeriodKey = '7d' | '30d' | '90d' | 'all' | 'custom';

interface TierDef {
  id: string;
  label: string;
  icon: string;
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

const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string; days: number | null }> = [
  { key: '7d', label: '過去7日', days: 7 },
  { key: '30d', label: '過去30日', days: 30 },
  { key: '90d', label: '過去90日', days: 90 },
  { key: 'all', label: '全期間', days: null },
  { key: 'custom', label: 'カスタム', days: null },
];

const TIER_COLORS = ['#f59e0b', '#a78bfa', '#38bdf8', '#22c55e', '#94a3b8'];
const TIER_ICONS = ['👑', '⭐', '💎', '🌿', '🌱'];
const TIER_LABELS = ['Tier 1（最上位）', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'];

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

/**
 * 黄金比（61.8% / 38.2%）で5段階に分類
 * tk降順ソート済みの配列を受け取り、5つのTierに分割
 */
function computeGoldenTiers(users: AggregatedUser[]): TierDef[] {
  if (users.length === 0) {
    return TIER_LABELS.map((label, i) => ({
      id: `tier${i + 1}`,
      label,
      icon: TIER_ICONS[i],
      color: TIER_COLORS[i],
      users: [],
      minTk: 0,
      maxTk: 0,
    }));
  }

  const sorted = [...users].sort((a, b) => b.total_coins - a.total_coins);
  const n = sorted.length;

  // 上位38.2% / 下位61.8%
  const upperCut = Math.max(1, Math.ceil(n * 0.382));
  const upper = sorted.slice(0, upperCut);
  const lower = sorted.slice(upperCut);

  // 上位の中の上位38.2% = Tier1, 残り = Tier2
  const tier1Cut = Math.max(1, Math.ceil(upper.length * 0.382));
  const tier1 = upper.slice(0, tier1Cut);
  const tier2 = upper.slice(tier1Cut);

  // 下位61.8%をさらに上位38.2% / 下位61.8%に分割
  // 中間 = Tier3
  const midCut = Math.max(0, Math.ceil(lower.length * 0.382));
  const tier3 = lower.slice(0, midCut);
  const lowerLower = lower.slice(midCut);

  // 下位の中の上位38.2% = Tier4, 残り = Tier5
  const tier4Cut = Math.max(0, Math.ceil(lowerLower.length * 0.382));
  const tier4 = lowerLower.slice(0, tier4Cut);
  const tier5 = lowerLower.slice(tier4Cut);

  const tiers = [tier1, tier2, tier3, tier4, tier5];

  return tiers.map((tierUsers, i) => ({
    id: `tier${i + 1}`,
    label: TIER_LABELS[i],
    icon: TIER_ICONS[i],
    color: TIER_COLORS[i],
    users: tierUsers,
    minTk: tierUsers.length > 0 ? tierUsers[tierUsers.length - 1].total_coins : 0,
    maxTk: tierUsers.length > 0 ? tierUsers[0].total_coins : 0,
  }));
}

// ============================================================
// Component
// ============================================================

export default function DmSegmentSender({ supabase, accountId, castName }: Props) {
  // --- Filter state ---
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [customStart, setCustomStart] = useState(() => daysAgo(30));
  const [customEnd, setCustomEnd] = useState(() => formatDate(new Date()));
  const [activeTier, setActiveTier] = useState<number>(0); // 0-based index

  // --- Data state ---
  const [periodUsers, setPeriodUsers] = useState<AggregatedUser[]>([]);
  const [loading, setLoading] = useState(true);

  // --- Copy state ---
  const [copySuccess, setCopySuccess] = useState(false);

  // Compute date range from period
  const dateRange = useMemo(() => {
    if (period === 'custom') return { start: customStart, end: customEnd };
    const opt = PERIOD_OPTIONS.find((p) => p.key === period);
    if (!opt || opt.days === null) return { start: '2025-02-15', end: formatDate(new Date()) };
    return { start: daysAgo(opt.days), end: formatDate(new Date()) };
  }, [period, customStart, customEnd]);

  // Fetch coin_transactions for the selected period
  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);

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
        console.error('[SegmentSender] coin_transactions query error:', error.message);
        setPeriodUsers([]);
        setLoading(false);
        return;
      }

      // Aggregate by user_name
      const map = new Map<string, { total: number; lastDate: string | null; count: number }>();
      for (const row of data || []) {
        const name = row.user_name;
        if (!name || name === 'anonymous') continue;
        const existing = map.get(name);
        if (existing) {
          existing.total += row.tokens;
          existing.count += 1;
          if (row.date && (!existing.lastDate || row.date > existing.lastDate)) {
            existing.lastDate = row.date;
          }
        } else {
          map.set(name, { total: row.tokens, lastDate: row.date, count: 1 });
        }
      }

      const users: AggregatedUser[] = Array.from(map.entries()).map(([user_name, agg]) => ({
        user_name,
        total_coins: agg.total,
        last_payment_date: agg.lastDate,
        tx_count: agg.count,
      }));

      users.sort((a, b) => b.total_coins - a.total_coins);
      setPeriodUsers(users);
      setLoading(false);
    };

    fetchPeriodData();
  }, [supabase, accountId, castName, dateRange.start, dateRange.end]);

  // Compute golden ratio tiers
  const tiers = useMemo(() => computeGoldenTiers(periodUsers), [periodUsers]);

  const currentTier = tiers[activeTier];
  const totalUsers = periodUsers.length;
  const totalTk = periodUsers.reduce((s, u) => s + u.total_coins, 0);

  // Copy user names
  const handleCopy = useCallback(async () => {
    if (!currentTier || currentTier.users.length === 0) return;
    const text = currentTier.users.map(u => u.user_name).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  }, [currentTier]);

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className="space-y-4">
      {/* Period filter */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold">🎯 黄金比セグメント分析</h3>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {totalUsers}名 / {totalTk.toLocaleString()}tk
          </span>
        </div>

        {/* Period buttons */}
        <div className="mb-3">
          <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>
            📅 集計期間
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {PERIOD_OPTIONS.map((opt) => (
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

        {/* Custom date range */}
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
        <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
          黄金比（38.2%/61.8%）による自動分類
        </p>

        {loading ? (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>集計中...</span>
          </div>
        ) : (
          <>
            {/* Tier tabs */}
            <div className="flex gap-1 mb-3 flex-wrap">
              {tiers.map((tier, i) => (
                <button
                  key={tier.id}
                  onClick={() => setActiveTier(i)}
                  className="text-[11px] px-3 py-2 rounded-lg transition-all flex-1 min-w-[80px]"
                  style={{
                    background: activeTier === i ? `${tier.color}22` : 'rgba(255,255,255,0.03)',
                    color: activeTier === i ? tier.color : 'var(--text-muted)',
                    border: `1px solid ${activeTier === i ? `${tier.color}44` : 'rgba(255,255,255,0.05)'}`,
                    fontWeight: activeTier === i ? 600 : 400,
                  }}
                >
                  <div>{tier.icon}</div>
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
                      {currentTier.icon} {currentTier.label}
                    </span>
                    <span className="text-[10px] ml-2" style={{ color: 'var(--text-muted)' }}>
                      {currentTier.users.length}人 / {currentTier.minTk.toLocaleString()}〜{currentTier.maxTk.toLocaleString()}tk
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

            {/* Tier summary table */}
            <div className="mt-4 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>Tier概要</p>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr style={{ color: 'var(--text-muted)' }}>
                      <th className="text-left py-1 px-2">Tier</th>
                      <th className="text-right py-1 px-2">人数</th>
                      <th className="text-right py-1 px-2">%</th>
                      <th className="text-right py-1 px-2">tk範囲</th>
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
                            {tier.icon} {tier.label}
                          </td>
                          <td className="py-1 px-2 text-right" style={{ color: 'var(--text-secondary)' }}>
                            {tier.users.length}
                          </td>
                          <td className="py-1 px-2 text-right" style={{ color: 'var(--text-muted)' }}>
                            {pct}%
                          </td>
                          <td className="py-1 px-2 text-right text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {tier.users.length > 0 ? `${tier.minTk.toLocaleString()}〜${tier.maxTk.toLocaleString()}` : '-'}
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
          </>
        )}
      </div>
    </div>
  );
}
