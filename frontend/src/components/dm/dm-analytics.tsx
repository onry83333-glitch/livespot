'use client';

import { formatTokens, tokensToJPY } from '@/lib/utils';
import type { DmEffItem } from '@/types/dm';

interface DmAnalyticsProps {
  dmEffectiveness: DmEffItem[];
  dmEffLoading: boolean;
}

export default function DmAnalytics({ dmEffectiveness, dmEffLoading }: DmAnalyticsProps) {
  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-bold mb-3">📈 DM効果測定（セグメント別）</h3>
      {dmEffLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-10 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
          ))}
        </div>
      ) : dmEffectiveness.length === 0 ? (
        <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
          直近30日間のDM送信データがありません
        </p>
      ) : (
        <>
          {/* サマリーカード */}
          {(() => {
            const segMap = new Map<string, { sent: number; paid: number; tokens: number }>();
            dmEffectiveness.forEach(r => {
              const prev = segMap.get(r.segment) || { sent: 0, paid: 0, tokens: 0 };
              segMap.set(r.segment, {
                sent: prev.sent + r.sent_count,
                paid: prev.paid + r.paid_count,
                tokens: prev.tokens + r.total_tokens,
              });
            });
            const segArr = Array.from(segMap.entries())
              .map(([seg, v]) => ({ seg, ...v, cvr: v.sent > 0 ? (v.paid / v.sent) * 100 : 0 }))
              .sort((a, b) => b.cvr - a.cvr);
            const best = segArr[0];
            const totalSent = segArr.reduce((s, v) => s + v.sent, 0);
            const totalPaid = segArr.reduce((s, v) => s + v.paid, 0);
            const totalTk = segArr.reduce((s, v) => s + v.tokens, 0);
            return (
              <div className="grid grid-cols-4 gap-2 mb-4">
                <div className="glass-panel rounded-lg p-2 text-center">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>送信数</p>
                  <p className="text-lg font-bold">{totalSent.toLocaleString()}</p>
                </div>
                <div className="glass-panel rounded-lg p-2 text-center">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>応援CVR</p>
                  <p className="text-lg font-bold" style={{ color: 'var(--accent-green)' }}>
                    {totalSent > 0 ? ((totalPaid / totalSent) * 100).toFixed(1) : '0'}%
                  </p>
                </div>
                <div className="glass-panel rounded-lg p-2 text-center">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>売上貢献</p>
                  <p className="text-sm font-bold" style={{ color: 'var(--accent-amber)' }}>
                    {formatTokens(totalTk)}
                  </p>
                  <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(totalTk)}</p>
                </div>
                <div className="glass-panel rounded-lg p-2 text-center" style={{ border: '1px solid rgba(34,197,94,0.3)' }}>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>最高ROIセグメント</p>
                  <p className="text-sm font-bold" style={{ color: 'var(--accent-green)' }}>
                    {best ? best.seg : '-'}
                  </p>
                  <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                    CVR {best ? best.cvr.toFixed(1) : 0}%
                  </p>
                </div>
              </div>
            );
          })()}

          {/* テーブル */}
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                  <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>キャンペーン</th>
                  <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>セグメント</th>
                  <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>送信</th>
                  <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>来訪CVR</th>
                  <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>応援CVR</th>
                  <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>売上</th>
                </tr>
              </thead>
              <tbody>
                {dmEffectiveness.map((r, i) => {
                  const segColors: Record<string, string> = {
                    whale: '#f59e0b', vip: '#a78bfa', regular: '#38bdf8',
                    light: '#94a3b8', new: '#22c55e', churned: '#f43f5e', unknown: '#475569',
                  };
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td className="py-1.5 px-2 font-mono text-[10px]">{r.campaign || '-'}</td>
                      <td className="py-1.5 px-2">
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                          style={{
                            background: `${segColors[r.segment] || '#475569'}20`,
                            color: segColors[r.segment] || '#475569',
                          }}>
                          {r.segment}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-right">{r.sent_count}</td>
                      <td className="py-1.5 px-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                            <div className="h-full rounded-full" style={{
                              width: `${Math.min(r.visit_cvr || 0, 100)}%`,
                              background: 'var(--accent-primary)',
                            }} />
                          </div>
                          <span>{(r.visit_cvr || 0).toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <div className="w-12 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                            <div className="h-full rounded-full" style={{
                              width: `${Math.min(r.payment_cvr || 0, 100)}%`,
                              background: 'var(--accent-green)',
                            }} />
                          </div>
                          <span style={{ color: 'var(--accent-green)' }}>{(r.payment_cvr || 0).toFixed(1)}%</span>
                        </div>
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <span>{formatTokens(r.total_tokens)}</span>
                        <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(r.total_tokens)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
