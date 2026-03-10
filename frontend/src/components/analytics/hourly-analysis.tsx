'use client';

import { formatTokens, tokensToJPY } from '@/lib/utils';
import type { HourlyPerfItem } from '@/types/analytics';

interface HourlyAnalysisProps {
  hourlyPerf: HourlyPerfItem[];
  hourlyPerfLoading: boolean;
}

export default function HourlyAnalysis({
  hourlyPerf,
  hourlyPerfLoading,
}: HourlyAnalysisProps) {
  return (<>
              {/* 時間帯別パフォーマンス */}
              <div className="glass-card p-4">
                <h3 className="text-sm font-bold mb-3">⏰ 時間帯別パフォーマンス（直近30日）</h3>
                {hourlyPerfLoading ? (
                  <div className="h-40 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
                ) : hourlyPerf.length === 0 ? (
                  <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
                    配信データがありません（SPYログから自動推定）
                  </p>
                ) : (
                  <>
                    {/* 24時間バーチャート */}
                    {(() => {
                      const maxTph = Math.max(...hourlyPerf.map(h => h.avg_tokens_per_hour || 0), 1);
                      const top3Hours = [...hourlyPerf]
                        .sort((a, b) => (b.avg_tokens_per_hour || 0) - (a.avg_tokens_per_hour || 0))
                        .slice(0, 3)
                        .map(h => h.hour_jst);
                      const allHours = Array.from({ length: 24 }, (_, i) => i);
                      return (
                        <div className="mb-4">
                          <div className="flex items-end gap-[2px]" style={{ height: '120px' }}>
                            {allHours.map(h => {
                              const item = hourlyPerf.find(p => p.hour_jst === h);
                              const tph = item?.avg_tokens_per_hour || 0;
                              const pct = maxTph > 0 ? (tph / maxTph) * 100 : 0;
                              const isTop = top3Hours.includes(h);
                              return (
                                <div key={h} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                                  <div
                                    className="w-full rounded-t transition-all"
                                    style={{
                                      height: `${Math.max(pct, 2)}%`,
                                      background: isTop
                                        ? 'linear-gradient(180deg, rgba(34,197,94,0.8), rgba(34,197,94,0.3))'
                                        : item?.session_count
                                          ? 'linear-gradient(180deg, rgba(56,189,248,0.6), rgba(56,189,248,0.2))'
                                          : 'rgba(255,255,255,0.03)',
                                      minHeight: '2px',
                                    }}
                                  />
                                  <span className="text-[8px] mt-0.5" style={{ color: isTop ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                                    {h}
                                  </span>
                                  {/* ツールチップ */}
                                  {item && item.session_count > 0 && (
                                    <div className="absolute bottom-full mb-1 hidden group-hover:block z-10 glass-panel rounded p-1.5 text-[9px] whitespace-nowrap"
                                      style={{ minWidth: '100px' }}>
                                      <p>{h}時台 (JST)</p>
                                      <p>配信{item.session_count}回 / 平均{item.avg_duration_min}分</p>
                                      <p>時給: {formatTokens(item.avg_tokens_per_hour)} ({tokensToJPY(item.avg_tokens_per_hour)})</p>
                                      <p>平均視聴者: {item.avg_viewers}人</p>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex items-center gap-3 mt-2 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(34,197,94,0.6)' }} /> 推奨時間帯（TOP3）
                            </span>
                            <span className="flex items-center gap-1">
                              <span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(56,189,248,0.4)' }} /> その他
                            </span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* 詳細テーブル */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                            <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>時間(JST)</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>配信回数</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均時間</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均視聴者</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>平均売上</th>
                            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>時給換算</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hourlyPerf
                            .filter(h => h.session_count > 0)
                            .sort((a, b) => a.hour_jst - b.hour_jst)
                            .map(h => {
                              const maxTph = Math.max(...hourlyPerf.map(p => p.avg_tokens_per_hour || 0), 1);
                              const top3 = [...hourlyPerf]
                                .sort((a, b) => (b.avg_tokens_per_hour || 0) - (a.avg_tokens_per_hour || 0))
                                .slice(0, 3)
                                .map(p => p.hour_jst);
                              const isTop = top3.includes(h.hour_jst);
                              return (
                                <tr key={h.hour_jst}
                                  style={{
                                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                                    background: isTop ? 'rgba(34,197,94,0.05)' : undefined,
                                  }}>
                                  <td className="py-1.5 px-2 font-mono">
                                    {isTop && <span className="mr-1">🏆</span>}
                                    {h.hour_jst}:00
                                  </td>
                                  <td className="py-1.5 px-2 text-right">{h.session_count}回</td>
                                  <td className="py-1.5 px-2 text-right">{h.avg_duration_min}分</td>
                                  <td className="py-1.5 px-2 text-right">{h.avg_viewers}人</td>
                                  <td className="py-1.5 px-2 text-right">
                                    {formatTokens(h.avg_tokens)}
                                    <span className="text-[9px] ml-1" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(h.avg_tokens)}</span>
                                  </td>
                                  <td className="py-1.5 px-2 text-right font-bold" style={{ color: isTop ? 'var(--accent-green)' : 'var(--text-primary)' }}>
                                    {formatTokens(h.avg_tokens_per_hour)}/h
                                    <span className="text-[9px] ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>{tokensToJPY(h.avg_tokens_per_hour)}/h</span>
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
  </>);
}
