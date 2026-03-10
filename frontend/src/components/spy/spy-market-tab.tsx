'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

export default function MarketAnalysisTab() {
  const { user } = useAuth();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(7);
  const [marketNow, setMarketNow] = useState<{
    current_hour: number;
    active_casts: number;
    avg_viewers_now: number;
    best_cast: string | null;
    best_viewers: number | null;
    own_avg_viewers: number | null;
  } | null>(null);
  const [viewerTrends, setViewerTrends] = useState<{
    cast_name: string;
    hour_of_day: number;
    avg_viewers: number;
    max_viewers: number;
    broadcast_count: number;
  }[]>([]);
  const [revenueTypes, setRevenueTypes] = useState<{
    cast_name: string;
    tip_count: number;
    ticket_count: number;
    group_count: number;
    total_tokens: number;
    broadcast_days: number;
  }[]>([]);

  const sb = useMemo(() => createClient(), []);

  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id').limit(1).single().then(({ data }) => {
      if (data) setAccountId(data.id);
    });
  }, [user, sb]);

  useEffect(() => {
    if (!accountId) return;
    const load = async () => {
      setLoading(true);
      const [marketRes, trendsRes, revRes] = await Promise.all([
        sb.rpc('get_spy_market_now', { p_account_id: accountId, p_days: days }),
        sb.rpc('get_spy_viewer_trends', { p_account_id: accountId, p_days: days }),
        sb.rpc('get_spy_revenue_types', { p_account_id: accountId, p_days: days }),
      ]);
      if (marketRes.data && marketRes.data.length > 0) setMarketNow(marketRes.data[0]);
      if (trendsRes.data) setViewerTrends(trendsRes.data);
      if (revRes.data) setRevenueTypes(revRes.data);
      setLoading(false);
    };
    load();
  }, [accountId, days, sb]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>マーケットデータ読み込み中...</p>
        </div>
      </div>
    );
  }

  if (viewerTrends.length === 0 && revenueTypes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="glass-card p-8 text-center max-w-md">
          <p className="text-2xl mb-3">📊</p>
          <p className="text-sm font-bold mb-2">マーケットデータなし</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            他社キャストのSPYデータが蓄積されると、マーケット分析が表示されます
          </p>
        </div>
      </div>
    );
  }

  const castNames = Array.from(new Set(viewerTrends.map(v => v.cast_name)));
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const maxV = Math.max(...viewerTrends.map(v => v.avg_viewers), 1);
  const currentHour = marketNow?.current_hour ?? new Date().getHours();

  // Viewer ranking: sum avg_viewers across all hours
  const castViewerRank = castNames.map(cn => {
    const rows = viewerTrends.filter(v => v.cast_name === cn);
    const avgAll = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_viewers, 0) / rows.length : 0;
    const peakV = rows.length > 0 ? Math.max(...rows.map(r => r.max_viewers)) : 0;
    const bc = rows.length > 0 ? Math.max(...rows.map(r => r.broadcast_count)) : 0;
    return { cast_name: cn, avg_viewers: Math.round(avgAll), peak_viewers: peakV, broadcast_count: bc };
  }).sort((a, b) => b.avg_viewers - a.avg_viewers);

  return (
    <div className="flex-1 overflow-y-auto space-y-4 p-1">
      {/* Period Selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold" style={{ color: 'rgb(6,182,212)' }}>📊 マーケット分析</h2>
        <div className="flex items-center gap-1.5">
          {[7, 14, 30].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
              style={{
                background: days === d ? 'rgba(6,182,212,0.12)' : 'transparent',
                color: days === d ? '#06b6d4' : 'var(--text-muted)',
                border: days === d ? '1px solid rgba(6,182,212,0.3)' : '1px solid transparent',
              }}
            >{d}日</button>
          ))}
        </div>
      </div>

      {/* Market Now Summary */}
      {marketNow && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>現在のマーケット概況</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>時間帯</p>
              <p className="text-base font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.current_hour}時台</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>アクティブ他社</p>
              <p className="text-base font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.active_casts}配信</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>他社平均視聴者</p>
              <p className="text-base font-bold" style={{ color: 'rgb(6,182,212)' }}>{marketNow.avg_viewers_now ?? '-'}人</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>トップキャスト</p>
              <p className="text-xs font-bold truncate" style={{ color: 'var(--accent-purple)' }}>{marketNow.best_cast ?? '-'}</p>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>最大{marketNow.best_viewers ?? 0}人</p>
            </div>
            <div className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}>
              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>自社平均視聴者</p>
              <p className="text-base font-bold" style={{
                color: marketNow.own_avg_viewers != null && marketNow.avg_viewers_now > 0 && marketNow.own_avg_viewers >= marketNow.avg_viewers_now
                  ? 'var(--accent-green)' : 'var(--accent-amber)',
              }}>{marketNow.own_avg_viewers ?? '-'}人</p>
            </div>
          </div>
        </div>
      )}

      {/* Viewer Heatmap */}
      {viewerTrends.length > 0 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>時間帯別視聴者数ヒートマップ</p>
          <div className="overflow-x-auto">
            <table className="text-[9px] w-full" style={{ minWidth: '700px' }}>
              <thead>
                <tr>
                  <th className="text-left px-1 py-1 sticky left-0" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)', minWidth: '90px', zIndex: 1 }}>キャスト</th>
                  {hours.map(h => (
                    <th key={h} className="px-0.5 py-1 text-center font-normal" style={{
                      color: h === currentHour ? 'rgb(6,182,212)' : 'var(--text-muted)',
                      fontWeight: h === currentHour ? 700 : 400,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {castNames.map(cn => (
                  <tr key={cn}>
                    <td className="px-1 py-0.5 truncate sticky left-0" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', maxWidth: '90px', zIndex: 1 }}>
                      <Link href={`/spy/${encodeURIComponent(cn)}`} className="hover:underline">{cn}</Link>
                    </td>
                    {hours.map(h => {
                      const cell = viewerTrends.find(v => v.cast_name === cn && v.hour_of_day === h);
                      const val = cell ? cell.avg_viewers : 0;
                      const intensity = val / maxV;
                      return (
                        <td key={h} className="px-0.5 py-0.5 text-center" title={val > 0 ? `${cn} ${h}時台: 平均${Math.round(val)}人 / 最大${cell?.max_viewers ?? 0}人` : ''} style={{
                          background: val > 0
                            ? `rgba(6,182,212,${Math.max(0.08, intensity * 0.6)})`
                            : 'transparent',
                          color: val > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                          borderLeft: h === currentHour ? '2px solid rgba(6,182,212,0.5)' : undefined,
                          borderRight: h === currentHour ? '2px solid rgba(6,182,212,0.5)' : undefined,
                        }}>
                          {val > 0 ? Math.round(val) : ''}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>値 = 平均視聴者数 / 太線 = 現在時刻</p>
        </div>
      )}

      {/* Viewer Ranking */}
      {castViewerRank.length > 0 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>視聴者数ランキング</p>
          <div className="space-y-1.5">
            {castViewerRank.map((c, i) => {
              const barW = castViewerRank[0].avg_viewers > 0 ? (c.avg_viewers / castViewerRank[0].avg_viewers) * 100 : 0;
              return (
                <div key={c.cast_name} className="flex items-center gap-2">
                  <span className="text-[10px] font-bold w-5 text-right" style={{ color: i < 3 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                    {i + 1}
                  </span>
                  <Link href={`/spy/${encodeURIComponent(c.cast_name)}`} className="text-[10px] truncate hover:underline" style={{ color: 'var(--text-secondary)', width: '90px', minWidth: '90px' }}>
                    {c.cast_name}
                  </Link>
                  <div className="flex-1 h-4 rounded" style={{ background: 'rgba(6,182,212,0.06)' }}>
                    <div className="h-full rounded flex items-center px-1.5" style={{ width: `${barW}%`, background: 'rgba(6,182,212,0.2)', minWidth: '20px' }}>
                      <span className="text-[9px] font-bold" style={{ color: 'rgb(6,182,212)' }}>{c.avg_viewers}</span>
                    </div>
                  </div>
                  <span className="text-[9px] w-14 text-right" style={{ color: 'var(--text-muted)' }}>最大{c.peak_viewers}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Revenue Type Distribution */}
      {revenueTypes.length > 0 && (
        <div className="glass-card p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>応援タイプ分布</p>
          <div className="overflow-x-auto">
            <table className="text-[10px] w-full">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left px-2 py-1.5">キャスト</th>
                  <th className="text-right px-2 py-1.5">チップ</th>
                  <th className="text-right px-2 py-1.5">チケット</th>
                  <th className="text-right px-2 py-1.5">グループ</th>
                  <th className="text-right px-2 py-1.5">合計tk</th>
                  <th className="text-right px-2 py-1.5">配信日数</th>
                </tr>
              </thead>
              <tbody>
                {revenueTypes.sort((a, b) => b.total_tokens - a.total_tokens).map(r => {
                  const total = r.tip_count + r.ticket_count + r.group_count;
                  const tipPct = total > 0 ? (r.tip_count / total * 100).toFixed(0) : '0';
                  const ticketPct = total > 0 ? (r.ticket_count / total * 100).toFixed(0) : '0';
                  const groupPct = total > 0 ? (r.group_count / total * 100).toFixed(0) : '0';
                  return (
                    <tr key={r.cast_name} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                      <td className="px-2 py-1.5 truncate" style={{ color: 'var(--text-secondary)', maxWidth: '100px' }}>
                        <Link href={`/spy/${encodeURIComponent(r.cast_name)}`} className="hover:underline">{r.cast_name}</Link>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: r.tip_count > 0 ? 'var(--accent-amber)' : 'var(--text-muted)' }}>
                        {r.tip_count} <span className="text-[8px]">({tipPct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: r.ticket_count > 0 ? 'var(--accent-purple)' : 'var(--text-muted)' }}>
                        {r.ticket_count} <span className="text-[8px]">({ticketPct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right" style={{ color: r.group_count > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                        {r.group_count} <span className="text-[8px]">({groupPct}%)</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-bold" style={{ color: 'var(--accent-primary)' }}>{r.total_tokens.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right" style={{ color: 'var(--text-muted)' }}>{r.broadcast_days}日</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Stacked bar per cast */}
          <div className="mt-4 space-y-1.5">
            {revenueTypes.sort((a, b) => b.total_tokens - a.total_tokens).map(r => {
              const total = r.tip_count + r.ticket_count + r.group_count;
              if (total === 0) return null;
              const tipW = (r.tip_count / total) * 100;
              const ticketW = (r.ticket_count / total) * 100;
              const groupW = (r.group_count / total) * 100;
              return (
                <div key={r.cast_name} className="flex items-center gap-2">
                  <span className="text-[9px] truncate" style={{ color: 'var(--text-muted)', width: '80px', minWidth: '80px' }}>{r.cast_name}</span>
                  <div className="flex-1 h-3 rounded-full overflow-hidden flex" style={{ background: 'rgba(255,255,255,0.03)' }}>
                    {tipW > 0 && <div style={{ width: `${tipW}%`, background: 'var(--accent-amber)' }} />}
                    {ticketW > 0 && <div style={{ width: `${ticketW}%`, background: 'var(--accent-purple)' }} />}
                    {groupW > 0 && <div style={{ width: `${groupW}%`, background: 'var(--accent-green)' }} />}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center gap-4 mt-2 text-[9px]" style={{ color: 'var(--text-muted)' }}>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent-amber)' }} /> チップ</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent-purple)' }} /> チケット</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent-green)' }} /> グループ</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
