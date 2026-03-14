'use client';
import { useState, useEffect, useMemo } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface RevenueTrendProps {
  accountId: string;
  castName: string;
  sb: SupabaseClient;
  coinRate: number;
}

interface WeekRow { week_start: string; week_end: string; total_tokens: number; transaction_count: number; }
interface MonthRow { month_start: string; total_tokens: number; transaction_count: number; }

export default function RevenueTrend({ accountId, castName, sb, coinRate }: RevenueTrendProps) {
  const [mode, setMode] = useState<'weekly' | 'monthly'>('weekly');
  const [weekly, setWeekly] = useState<WeekRow[]>([]);
  const [monthly, setMonthly] = useState<MonthRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    Promise.all([
      sb.rpc('get_weekly_revenue_trend', { p_account_id: accountId, p_cast_name: castName, p_weeks: 12 }),
      sb.rpc('get_monthly_revenue_trend', { p_account_id: accountId, p_cast_name: castName, p_months: 6 }),
    ]).then(([wRes, mRes]) => {
      setWeekly((wRes.data || []) as WeekRow[]);
      setMonthly((mRes.data || []) as MonthRow[]);
      setLoading(false);
    });
  }, [accountId, castName, sb]);

  const chartData = useMemo(() => {
    if (mode === 'weekly') {
      return [...weekly].reverse().map(w => ({
        label: new Date(w.week_start).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }),
        tk: Number(w.total_tokens),
        count: Number(w.transaction_count),
      }));
    }
    return [...monthly].reverse().map(m => ({
      label: new Date(m.month_start).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric' }),
      tk: Number(m.total_tokens),
      count: Number(m.transaction_count),
    }));
  }, [mode, weekly, monthly]);

  const thisWeek = Number(weekly[0]?.total_tokens ?? 0);
  const lastWeek = Number(weekly[1]?.total_tokens ?? 0);
  const weekChange = lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek * 100) : 0;

  const thisMonth = Number(monthly[0]?.total_tokens ?? 0);
  const lastMonth = Number(monthly[1]?.total_tokens ?? 0);
  const monthChange = lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth * 100) : 0;

  const kpiCards = [
    { label: '今週の売上', value: `${thisWeek.toLocaleString()}tk`, sub: `${Math.round(thisWeek * coinRate).toLocaleString()}` },
    { label: '前週比', value: `${weekChange >= 0 ? '+' : ''}${weekChange.toFixed(1)}%`, color: weekChange >= 0 ? '#22c55e' : '#ef4444' },
    { label: '前月比', value: `${monthChange >= 0 ? '+' : ''}${monthChange.toFixed(1)}%`, color: monthChange >= 0 ? '#22c55e' : '#ef4444' },
  ];

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
        <div className="h-48 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toggle */}
      <div className="flex gap-2">
        {(['weekly', 'monthly'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`text-[11px] px-4 py-1.5 rounded-lg font-medium transition-all ${
              mode === m ? 'text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
            style={mode === m ? {
              background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(56,189,248,0.05))',
              border: '1px solid rgba(56,189,248,0.2)',
            } : {}}>
            {m === 'weekly' ? '週次' : '月次'}
          </button>
        ))}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-3">
        {kpiCards.map((k, i) => (
          <div key={i} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
            <p className="text-lg font-bold mt-1" style={{ color: k.color || 'var(--text-primary)' }}>{k.value}</p>
            {k.sub && <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{k.sub}</p>}
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#94a3b8' }}
              formatter={(value: number) => [`${value.toLocaleString()}tk`, '売上']}
            />
            <Line type="monotone" dataKey="tk" stroke="#38bdf8" strokeWidth={2} dot={{ r: 3, fill: '#38bdf8' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Alert */}
      {weekChange <= -10 && (
        <div className="rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-[12px] font-medium" style={{ color: '#ef4444' }}>
            先週より売上が{Math.abs(weekChange).toFixed(1)}%下がっています。企画は練れていましたか？
          </p>
        </div>
      )}
    </div>
  );
}
