'use client';
import { useState, useEffect } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';

interface FanAnalysisProps {
  accountId: string;
  castName: string;
  sb: SupabaseClient;
}

interface RepeatRow { last_month_users: number; returning_users: number; repeat_rate: number; }
interface RetentionRow { new_users_last_month: number; returned_users: number; retention_rate: number; }
interface ChurnRow { user_name: string; last_month_tokens: number; last_visit: string; }

export default function FanAnalysis({ accountId, castName, sb }: FanAnalysisProps) {
  const [repeat, setRepeat] = useState<RepeatRow | null>(null);
  const [retention, setRetention] = useState<RetentionRow | null>(null);
  const [churn, setChurn] = useState<ChurnRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    Promise.all([
      sb.rpc('get_repeat_rate', { p_account_id: accountId, p_cast_name: castName }),
      sb.rpc('get_new_user_retention', { p_account_id: accountId, p_cast_name: castName }),
      sb.rpc('get_churn_risk', { p_account_id: accountId, p_cast_name: castName, p_limit: 20 }),
    ]).then(([repRes, retRes, churnRes]) => {
      const repData = repRes.data as RepeatRow[] | null;
      setRepeat(repData?.[0] ?? null);
      const retData = retRes.data as RetentionRow[] | null;
      setRetention(retData?.[0] ?? null);
      setChurn((churnRes.data || []) as ChurnRow[]);
      setLoading(false);
    });
  }, [accountId, castName, sb]);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          ))}
        </div>
        <div className="h-48 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
      </div>
    );
  }

  const kpis = [
    {
      label: 'リピート率',
      value: `${repeat?.repeat_rate ?? 0}%`,
      sub: `${repeat?.returning_users ?? 0} / ${repeat?.last_month_users ?? 0}人`,
      desc: '先月来た人のうち今月も来た割合',
    },
    {
      label: '新規定着率',
      value: `${retention?.retention_rate ?? 0}%`,
      sub: `${retention?.returned_users ?? 0} / ${retention?.new_users_last_month ?? 0}人`,
      desc: '先月初回の人が今月も来た率',
    },
    {
      label: '離脱リスク',
      value: `${churn.length}人`,
      sub: `${churn.reduce((s, c) => s + Number(c.last_month_tokens), 0).toLocaleString()}tk分`,
      desc: '先月来たが今月未訪問',
      color: churn.length > 10 ? '#ef4444' : churn.length > 5 ? '#f59e0b' : '#22c55e',
    },
  ];

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-3">
        {kpis.map((k, i) => (
          <div key={i} className="rounded-xl p-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{k.label}</p>
            <p className="text-lg font-bold mt-1" style={{ color: k.color || 'var(--text-primary)' }}>{k.value}</p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{k.sub}</p>
            <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{k.desc}</p>
          </div>
        ))}
      </div>

      {/* Churn Risk Table */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
        <div className="px-4 py-2.5" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            離脱リスク（先月来たが今月未訪問）
          </p>
        </div>
        {churn.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>離脱リスクユーザーなし</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                  <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>#</th>
                  <th className="text-left px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>ユーザー名</th>
                  <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>先月課金額</th>
                  <th className="text-right px-4 py-2 font-medium" style={{ color: 'var(--text-muted)' }}>最終訪問</th>
                </tr>
              </thead>
              <tbody>
                {churn.map((u, i) => (
                  <tr key={u.user_name} style={{ borderBottom: '1px solid var(--border-primary)' }}
                    className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                    <td className="px-4 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{u.user_name}</td>
                    <td className="px-4 py-2 text-right" style={{ color: '#f59e0b' }}>
                      {Number(u.last_month_tokens).toLocaleString()}tk
                    </td>
                    <td className="px-4 py-2 text-right" style={{ color: 'var(--text-muted)' }}>
                      {new Date(u.last_visit).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
