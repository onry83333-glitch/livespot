'use client';

import { useState } from 'react';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import type { CampaignEffect } from '@/types/analytics';
import type { DmCvrItem } from '@/types/dm';

interface DmCampaignEffectProps {
  coinRate: number;
  campaignEffects: CampaignEffect[];
  dmCvr: DmCvrItem[];
}

export default function DmCampaignEffect({
  coinRate,
  campaignEffects,
  dmCvr,
}: DmCampaignEffectProps) {
  // Internal UI state
  const [dmCvrExpanded, setDmCvrExpanded] = useState<string | null>(null);

  return (<>
                  {/* Campaign effectiveness */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3">📊 DMキャンペーン効果</h3>
                    {campaignEffects.length === 0 ? (
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>キャンペーンデータなし</p>
                    ) : (
                      <div className="overflow-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                              <th className="text-left px-3 py-2 font-semibold">キャンペーン</th>
                              <th className="text-right px-3 py-2 font-semibold">送信数</th>
                              <th className="text-right px-3 py-2 font-semibold">来訪率</th>
                              <th className="text-right px-3 py-2 font-semibold">応援率</th>
                              <th className="text-right px-3 py-2 font-semibold">売上貢献</th>
                            </tr>
                          </thead>
                          <tbody>
                            {campaignEffects.map(c => (
                              <tr key={c.campaign} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                <td className="px-3 py-2 font-semibold">
                                  <span className="text-[10px] px-1.5 py-0.5 rounded"
                                    style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                    {c.campaign}
                                  </span>
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums">{c.sent_count}</td>
                                <td className="text-right px-3 py-2 tabular-nums" style={{ color: 'var(--accent-green)' }}>
                                  {c.success_count > 0 ? `${Math.round(c.visited_count / c.success_count * 100)}%` : '--'}
                                </td>
                                <td className="text-right px-3 py-2 tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                  {c.success_count > 0 ? `${Math.round(c.tipped_count / c.success_count * 100)}%` : '--'}
                                </td>
                                <td className="text-right px-3 py-2 font-bold tabular-nums">
                                  <span style={{ color: 'var(--accent-amber)' }}>{formatTokens(c.tip_amount)}</span>
                                  <br />
                                  <span className="text-[9px] font-normal" style={{ color: 'var(--accent-green)' }}>{tokensToJPY(c.tip_amount, coinRate)}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  {/* DM Campaign CVR (from Block 2) */}
                  {dmCvr.length > 0 && (
                    <div className="glass-card p-4">
                      <h3 className="text-sm font-bold mb-3">DM Campaign CVR</h3>
                      <div className="space-y-2">
                        {/* Header */}
                        <div className="grid grid-cols-12 gap-2 text-[10px] font-semibold px-2" style={{ color: 'var(--text-muted)' }}>
                          <div className="col-span-3">Campaign</div>
                          <div className="col-span-1 text-right">送信</div>
                          <div className="col-span-1 text-right">来場</div>
                          <div className="col-span-1 text-right">応援</div>
                          <div className="col-span-2 text-right">来場率</div>
                          <div className="col-span-2 text-right">応援率</div>
                          <div className="col-span-2 text-right">収益tk</div>
                        </div>
                        {/* Rows */}
                        {dmCvr.map(row => {
                          const payCvrColor = row.cvr_pct >= 50 ? 'var(--accent-green)'
                            : row.cvr_pct >= 20 ? 'var(--accent-amber)'
                            : 'var(--accent-pink)';
                          const visitCvrColor = (row.visit_cvr_pct || 0) >= 30 ? 'var(--accent-green)'
                            : (row.visit_cvr_pct || 0) >= 10 ? 'var(--accent-amber)'
                            : 'var(--accent-pink)';
                          const visitBarWidth = Math.min(row.visit_cvr_pct || 0, 100);
                          const payBarWidth = Math.min(row.cvr_pct, 100);
                          return (
                            <div key={row.campaign}>
                              <div
                                className="glass-panel px-2 py-2 rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
                                onClick={() => setDmCvrExpanded(dmCvrExpanded === row.campaign ? null : row.campaign)}
                              >
                                <div className="grid grid-cols-12 gap-2 items-center text-[11px]">
                                  <div className="col-span-3 truncate font-medium">{row.campaign}</div>
                                  <div className="col-span-1 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                                    {row.dm_sent.toLocaleString()}
                                  </div>
                                  <div className="col-span-1 text-right tabular-nums font-bold" style={{ color: visitCvrColor }}>
                                    {(row.visited_after || 0).toLocaleString()}
                                  </div>
                                  <div className="col-span-1 text-right tabular-nums font-bold" style={{ color: payCvrColor }}>
                                    {row.paid_after.toLocaleString()}
                                  </div>
                                  <div className="col-span-2 text-right tabular-nums font-bold" style={{ color: visitCvrColor }}>
                                    {Number(row.visit_cvr_pct || 0).toFixed(1)}%
                                  </div>
                                  <div className="col-span-2 text-right tabular-nums font-bold" style={{ color: payCvrColor }}>
                                    {Number(row.cvr_pct).toFixed(1)}%
                                  </div>
                                  <div className="col-span-2 text-right tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                    {row.total_tokens.toLocaleString()}
                                  </div>
                                </div>
                                {/* Dual CVR Bars: 来場(上) + 応援(下) */}
                                <div className="mt-1.5 space-y-0.5">
                                  <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                    <div
                                      className="h-full rounded-full transition-all"
                                      style={{ width: `${visitBarWidth}%`, background: visitCvrColor, opacity: 0.7 }}
                                    />
                                  </div>
                                  <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                    <div
                                      className="h-full rounded-full transition-all"
                                      style={{ width: `${payBarWidth}%`, background: payCvrColor }}
                                    />
                                  </div>
                                </div>
                              </div>
                              {/* Expanded detail */}
                              {dmCvrExpanded === row.campaign && (
                                <div className="mt-1 px-3 py-2 rounded-lg text-[10px] space-y-1" style={{ background: 'rgba(15,23,42,0.4)' }}>
                                  <div className="flex justify-between">
                                    <span style={{ color: 'var(--text-muted)' }}>来場率（チャット出現）</span>
                                    <span style={{ color: visitCvrColor }}>{(row.visited_after || 0).toLocaleString()}/{row.dm_sent.toLocaleString()} = {Number(row.visit_cvr_pct || 0).toFixed(1)}%</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span style={{ color: 'var(--text-muted)' }}>応援率（課金）</span>
                                    <span style={{ color: payCvrColor }}>{row.paid_after.toLocaleString()}/{row.dm_sent.toLocaleString()} = {Number(row.cvr_pct).toFixed(1)}%</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span style={{ color: 'var(--text-muted)' }}>初回送信</span>
                                    <span>{row.first_sent ? formatJST(row.first_sent) : '-'}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span style={{ color: 'var(--text-muted)' }}>最終送信</span>
                                    <span>{row.last_sent ? formatJST(row.last_sent) : '-'}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span style={{ color: 'var(--text-muted)' }}>合計収益</span>
                                    <span style={{ color: 'var(--accent-amber)' }}>{formatTokens(row.total_tokens)} <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(row.total_tokens, coinRate)})</span></span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span style={{ color: 'var(--text-muted)' }}>サポーター平均</span>
                                    <span style={{ color: 'var(--accent-amber)' }}>{formatTokens(Math.round(row.avg_tokens_per_payer || 0))} <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(row.avg_tokens_per_payer || 0, coinRate)})</span></span>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {/* Summary */}
                      <div className="mt-3 pt-3 flex items-center justify-between text-[10px]" style={{ borderTop: '1px solid var(--border-glass)' }}>
                        <span style={{ color: 'var(--text-muted)' }}>
                          {dmCvr.length}キャンペーン / 送信合計 {dmCvr.reduce((s, r) => s + r.dm_sent, 0).toLocaleString()}通
                        </span>
                        <span style={{ color: 'var(--accent-green)' }}>
                          総収益 {tokensToJPY(dmCvr.reduce((s, r) => s + r.total_tokens, 0), coinRate)}
                        </span>
                      </div>
                    </div>
                  )}
  </>);
}
