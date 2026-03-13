'use client';

import { useState } from 'react';
import { formatTokens, tokensToJPY, timeAgo, formatJST } from '@/lib/utils';
import { getUserColorFromCoins } from '@/lib/stripchat-levels';
import { Accordion } from '@/components/accordion';
import type { UserSegment } from '@/types';
import type { CoinTxItem, PaidUserItem, MonthlyPL, RevenueShareRow } from '@/types/analytics';

interface SegmentAnalysisProps {
  castName: string;
  coinRate: number;
  // Segment data
  segments: UserSegment[];
  segmentsLoading: boolean;
  segmentsLoadedAt: Date | null;
  refreshingSegments: boolean;
  refreshResult: string | null;
  handleRefreshSegments: () => void;
  sendSegmentDm: (segmentId: string, segmentName: string) => void;
  // Segment thresholds
  segThresholdVip: number;
  setSegThresholdVip: (v: number) => void;
  segThresholdRegular: number;
  setSegThresholdRegular: (v: number) => void;
  segThresholdMid: number;
  setSegThresholdMid: (v: number) => void;
  segThresholdLight: number;
  setSegThresholdLight: (v: number) => void;
  // Tips / ticket chats
  lastTips: { user_name: string; tokens: number; message_time: string; message: string }[];
  lastTicketChats: { user_name: string; tokens: number; date: string }[];
  // Sales
  salesLoading: boolean;
  coinTxs: CoinTxItem[];
  thisWeekCoins: number;
  salesThisWeek: number;
  salesLastWeek: number;
  // Monthly P/L
  monthlyPL: MonthlyPL[];
  monthlyPLLoading: boolean;
  monthlyPLError: boolean;
  // Revenue share
  revenueShare: RevenueShareRow[];
  revenueShareLoading: boolean;
}

export default function SegmentAnalysis({
  castName,
  coinRate,
  segments,
  segmentsLoading,
  segmentsLoadedAt,
  refreshingSegments,
  refreshResult,
  handleRefreshSegments,
  sendSegmentDm,
  segThresholdVip,
  setSegThresholdVip,
  segThresholdRegular,
  setSegThresholdRegular,
  segThresholdMid,
  setSegThresholdMid,
  segThresholdLight,
  setSegThresholdLight,
  lastTips,
  lastTicketChats,
  salesLoading,
  coinTxs,
  thisWeekCoins,
  salesThisWeek,
  salesLastWeek,
  monthlyPL,
  monthlyPLLoading,
  monthlyPLError,
  revenueShare,
  revenueShareLoading,
}: SegmentAnalysisProps) {
  // Internal UI state
  const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
  const [segmentUserExpanded, setSegmentUserExpanded] = useState<Set<string>>(new Set());
  const [segmentSortMode, setSegmentSortMode] = useState<'id' | 'users' | 'coins'>('id');
  const [segThresholdsOpen, setSegThresholdsOpen] = useState(false);
  const [revenueShareExpanded, setRevenueShareExpanded] = useState<string | null>(null);

  const toggleSegment = (id: string) => {
    setExpandedSegments(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (<>
                  {/* ============ SEGMENT ANALYSIS ============ */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h3 className="text-sm font-bold flex items-center gap-2">
                          📊 ユーザーセグメント分析
                          {/* M18: last update timestamp */}
                          {segmentsLoadedAt && (
                            <span className="text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                              最終読込: {segmentsLoadedAt.toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'})}
                            </span>
                          )}
                        </h3>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          コイン累計額 × 最終応援日の2軸で分類（coin_transactions基準）
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {refreshResult && (
                          <span className="text-[10px] px-2 py-1 rounded-full" style={{
                            background: refreshResult.startsWith('エラー') ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)',
                            color: refreshResult.startsWith('エラー') ? '#ef4444' : '#22c55e',
                          }}>
                            {refreshResult}
                          </span>
                        )}
                        <button
                          onClick={() => setSegThresholdsOpen(!segThresholdsOpen)}
                          className="text-[10px] px-3 py-1.5 rounded-lg font-medium transition-all"
                          style={{
                            background: segThresholdsOpen ? 'rgba(168,139,250,0.15)' : 'rgba(255,255,255,0.03)',
                            color: segThresholdsOpen ? '#a78bfa' : 'var(--text-secondary)',
                            border: `1px solid ${segThresholdsOpen ? 'rgba(168,139,250,0.3)' : 'var(--border-glass)'}`,
                          }}
                        >
                          ⚙ 閾値
                        </button>
                        <button
                          onClick={handleRefreshSegments}
                          disabled={refreshingSegments}
                          className="text-[10px] px-3 py-1.5 rounded-lg font-medium transition-all"
                          style={{
                            background: refreshingSegments ? 'rgba(56,189,248,0.1)' : 'rgba(56,189,248,0.15)',
                            color: 'var(--accent-primary)',
                            border: '1px solid rgba(56,189,248,0.2)',
                          }}
                        >
                          {refreshingSegments ? '更新中...' : '🔄 セグメント更新'}
                        </button>
                      </div>
                    </div>

                    {/* Threshold customization panel */}
                    {segThresholdsOpen && (
                      <div className="glass-panel p-3 rounded-xl mb-3" style={{ border: '1px solid rgba(168,139,250,0.2)' }}>
                        <p className="text-[10px] font-bold mb-2" style={{ color: '#a78bfa' }}>
                          セグメント閾値カスタマイズ（変更後「セグメント更新」で反映）
                        </p>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {([
                            { label: 'VIP境界', value: segThresholdVip, set: setSegThresholdVip, default_: 5000, color: '#ef4444' },
                            { label: '常連境界', value: segThresholdRegular, set: setSegThresholdRegular, default_: 1000, color: '#f59e0b' },
                            { label: '中堅境界', value: segThresholdMid, set: setSegThresholdMid, default_: 300, color: '#38bdf8' },
                            { label: 'ライト境界', value: segThresholdLight, set: setSegThresholdLight, default_: 50, color: '#94a3b8' },
                          ] as const).map(t => (
                            <div key={t.label}>
                              <label className="text-[9px] block mb-0.5" style={{ color: t.color }}>{t.label} (tk+)</label>
                              <input
                                type="number"
                                min={1}
                                value={t.value}
                                onChange={e => t.set(Math.max(1, parseInt(e.target.value) || t.default_))}
                                className="w-full text-[11px] px-2 py-1 rounded-md"
                                style={{
                                  background: 'rgba(255,255,255,0.04)',
                                  border: '1px solid var(--border-glass)',
                                  color: 'var(--text-primary)',
                                }}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between mt-2">
                          <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            S1-S3: {segThresholdVip}tk+ / S4-S6: {segThresholdRegular}-{segThresholdVip - 1}tk / S7-S8: {segThresholdMid}-{segThresholdRegular - 1}tk / S9: {segThresholdLight}-{segThresholdMid - 1}tk / S10: {segThresholdLight}tk未満
                          </p>
                          <button
                            onClick={() => { setSegThresholdVip(5000); setSegThresholdRegular(1000); setSegThresholdMid(300); setSegThresholdLight(50); }}
                            className="text-[9px] px-2 py-0.5 rounded"
                            style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-glass)' }}
                          >
                            デフォルトに戻す
                          </button>
                        </div>
                      </div>
                    )}

                    {segmentsLoading ? (
                      <div className="space-y-2">
                        {[0,1,2].map(i => (
                          <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                        ))}
                      </div>
                    ) : segments.length === 0 ? (
                      <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                        セグメントデータなし（コイン同期を先に実行してください）
                      </div>
                    ) : (
                      <>
                        {/* パレートサマリー */}
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <div className="glass-panel p-3 rounded-xl text-center">
                            <p className="text-lg font-bold" style={{ color: 'var(--accent-amber)' }}>
                              {segments.reduce((s, seg) => s + seg.user_count, 0).toLocaleString()}
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>有料ユーザー総数</p>
                          </div>
                          <div className="glass-panel p-3 rounded-xl text-center">
                            <p className="text-lg font-bold" style={{ color: 'var(--accent-green)' }}>
                              {formatTokens(segments.reduce((s, seg) => s + seg.total_coins, 0))}
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>総コイン</p>
                          </div>
                          <div className="glass-panel p-3 rounded-xl text-center">
                            <p className="text-lg font-bold" style={{ color: 'var(--accent-primary)' }}>
                              {segments.filter(s => ['S1','S2','S3','S4','S5'].includes(s.segment_id)).reduce((s, seg) => s + seg.user_count, 0).toLocaleString()}
                            </p>
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>高優先ターゲット</p>
                          </div>
                        </div>

                        {/* 直近チップ + チケットチャット */}
                        {(lastTips.length > 0 || lastTicketChats.length > 0) && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                            {/* 最後のチップ（このキャスト） */}
                            {lastTips.length > 0 && (
                              <div className="glass-panel p-3 rounded-xl">
                                <p className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
                                  💰 直近のチップ（このキャスト）
                                </p>
                                <div className="space-y-1">
                                  {lastTips.map((t, i) => (
                                    <div key={i} className="flex items-center justify-between text-[11px]">
                                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                                        {t.user_name || '?'}
                                      </span>
                                      <div className="flex items-center gap-2 flex-shrink-0">
                                        <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                          {formatTokens(t.tokens || 0)}
                                        </span>
                                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                          {t.message_time ? new Date(t.message_time).toLocaleDateString('ja-JP') : '--'}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {/* 直近のチケットチャット（このキャスト） */}
                            {lastTicketChats.length > 0 && (
                              <div className="glass-panel p-3 rounded-xl">
                                <p className="text-[10px] font-bold mb-2" style={{ color: 'var(--text-muted)' }}>
                                  🎟 直近のチケットチャット（{castName}）
                                </p>
                                <div className="space-y-1">
                                  {lastTicketChats.map((t, i) => (
                                    <div key={i} className="flex items-center justify-between text-[11px]">
                                      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                                        {t.user_name || '?'}
                                      </span>
                                      <div className="flex items-center gap-2 flex-shrink-0">
                                        <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                          {formatTokens(t.tokens || 0)}
                                        </span>
                                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                          {t.date ? new Date(t.date).toLocaleDateString('ja-JP') : '--'}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* H5: Segment legend (collapsible) */}
                        <div className="glass-card p-3 mb-4">
                          <Accordion id="segment-legend" title="凡例" defaultOpen={true}>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-[10px]">
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.06)' }}>
                                <span className="font-bold w-6">S1</span>
                                <span>Whale現役 — 高額応援＋最近も応援</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.04)' }}>
                                <span className="font-bold w-6">S2</span>
                                <span>Whale準現役 — 高額だがやや遠のく</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.02)' }}>
                                <span className="font-bold w-6">S3</span>
                                <span>Whale休眠 — 以前は高額、今は不在</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.06)' }}>
                                <span className="font-bold w-6">S4</span>
                                <span>VIP現役 — 中額＋アクティブ</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.04)' }}>
                                <span className="font-bold w-6">S5</span>
                                <span>VIP準現役 — 中額＋やや遠のく</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(245,158,11,0.02)' }}>
                                <span className="font-bold w-6">S6</span>
                                <span>VIP休眠 — 中額＋長期不在</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(56,189,248,0.06)' }}>
                                <span className="font-bold w-6">S7</span>
                                <span>ライト現役 — 少額＋アクティブ</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(56,189,248,0.04)' }}>
                                <span className="font-bold w-6">S8</span>
                                <span>ライト準現役 — 少額＋やや遠のく</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(56,189,248,0.02)' }}>
                                <span className="font-bold w-6">S9</span>
                                <span>ライト休眠 — 少額＋長期不在</span>
                              </div>
                              <div className="flex items-center gap-2 px-2 py-1 rounded" style={{ background: 'rgba(100,116,139,0.06)' }}>
                                <span className="font-bold w-6">S10</span>
                                <span>離脱 — 長期間来ていない</span>
                              </div>
                            </div>
                          </Accordion>
                        </div>

                        {/* M26: Segment sort options + M19: color legend */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>並び順:</span>
                            {([
                              { key: 'id' as const, label: 'ID順' },
                              { key: 'users' as const, label: 'ユーザー数順' },
                              { key: 'coins' as const, label: '合計コイン順' },
                            ]).map(opt => (
                              <button
                                key={opt.key}
                                onClick={() => setSegmentSortMode(opt.key)}
                                className="text-[10px] px-2 py-1 rounded-lg transition-all"
                                style={{
                                  background: segmentSortMode === opt.key ? 'rgba(56,189,248,0.15)' : 'rgba(255,255,255,0.03)',
                                  color: segmentSortMode === opt.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                  border: `1px solid ${segmentSortMode === opt.key ? 'rgba(56,189,248,0.25)' : 'var(--border-glass)'}`,
                                }}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                            色: <span style={{ color: '#aa00ff' }}>10,000tk+</span> / <span style={{ color: '#ff9100' }}>1,000tk+</span> / <span style={{ color: '#78909c' }}>1,000tk未満</span>
                          </span>
                        </div>

                        {/* セグメント一覧 */}
                        <div className="space-y-1.5">
                          {[...segments].sort((a, b) => {
                            if (segmentSortMode === 'users') return b.user_count - a.user_count;
                            if (segmentSortMode === 'coins') return b.total_coins - a.total_coins;
                            return parseInt(a.segment_id.replace('S','')) - parseInt(b.segment_id.replace('S',''));
                          }).map(seg => {
                            const isExpanded = expandedSegments.has(seg.segment_id);
                            const grandTotal = segments.reduce((s, x) => s + x.total_coins, 0);
                            const coinPct = grandTotal > 0 ? (seg.total_coins / grandTotal * 100).toFixed(1) : '0';
                            const priorityColor =
                              seg.priority.includes('最優先') ? '#ef4444' :
                              seg.priority.includes('高') ? '#f59e0b' :
                              seg.priority.includes('中') ? '#eab308' :
                              seg.priority.includes('通常') ? '#22c55e' :
                              seg.priority.includes('低') ? '#38bdf8' : '#64748b';

                            return (
                              <div key={seg.segment_id} className="glass-panel rounded-xl overflow-hidden">
                                {/* Header row */}
                                <button
                                  onClick={() => toggleSegment(seg.segment_id)}
                                  className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
                                >
                                  <div className="flex items-center gap-3">
                                    <span className="text-xs">{isExpanded ? '▼' : '▶'}</span>
                                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: priorityColor }} />
                                    <div>
                                      <span className="text-xs font-bold">{seg.segment_id}: {seg.segment_name}</span>
                                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{seg.tier}</p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-4 text-[11px]">
                                    <span className="tabular-nums">{(seg.user_count ?? 0).toLocaleString()}名</span>
                                    <span className="tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                      {formatTokens(seg.total_coins)}
                                    </span>
                                    <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                      ({coinPct}%)
                                    </span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      平均 {formatTokens(Math.round(seg.avg_coins))}
                                    </span>
                                  </div>
                                </button>

                                {/* Expanded: user list + DM button */}
                                {isExpanded && (() => {
                                  const isUserExpanded = segmentUserExpanded.has(seg.segment_id);
                                  const displayLimit = isUserExpanded ? 200 : 50;
                                  const visibleUsers = seg.users.slice(0, displayLimit);
                                  const remaining = seg.users.length - displayLimit;
                                  return (
                                  <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-glass)' }}>
                                    <div className="flex items-center justify-between mb-2">
                                      <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                                        ユーザー一覧（コイン順・上位{displayLimit}名表示）
                                      </span>
                                      <button
                                        onClick={() => sendSegmentDm(seg.segment_id, seg.segment_name)}
                                        className="btn-primary text-[10px] py-1 px-3"
                                      >
                                        📩 {seg.user_count}名にDM送信
                                      </button>
                                    </div>
                                    <div className={`overflow-auto space-y-0.5 ${isUserExpanded ? 'max-h-96' : 'max-h-60'}`}>
                                      {visibleUsers.map((u, i) => (
                                        <div key={u.user_name} className="flex items-center justify-between text-[11px] px-2 py-1 rounded hover:bg-white/[0.03]">
                                          <div className="flex items-center gap-2 min-w-0">
                                            <span className="font-bold w-5 text-center text-[10px]" style={{
                                              color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text-muted)'
                                            }}>{i + 1}</span>
                                            <span className="truncate font-medium" style={{ color: getUserColorFromCoins(u.total_coins) }}>{u.user_name}</span>
                                          </div>
                                          <div className="flex items-center gap-3 flex-shrink-0">
                                            <span className="tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                              {formatTokens(u.total_coins)}
                                            </span>
                                            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                              {u.last_payment_date ? new Date(u.last_payment_date).toLocaleDateString('ja-JP') : '--'}
                                            </span>
                                          </div>
                                        </div>
                                      ))}
                                      {/* M3: Expand beyond 50 */}
                                      {!isUserExpanded && seg.users.length > 50 && (
                                        <button
                                          onClick={() => setSegmentUserExpanded(prev => {
                                            const next = new Set(prev);
                                            next.add(seg.segment_id);
                                            return next;
                                          })}
                                          className="w-full text-[10px] text-center py-1.5 rounded-lg hover:bg-white/[0.03] transition-colors"
                                          style={{ color: 'var(--accent-primary)' }}
                                        >
                                          もっと表示（残り {seg.users.length - 50}名）
                                        </button>
                                      )}
                                      {isUserExpanded && remaining > 0 && (
                                        <p className="text-[10px] text-center py-1" style={{ color: 'var(--text-muted)' }}>
                                          ... 他 {remaining}名
                                        </p>
                                      )}
                                      {isUserExpanded && seg.users.length > 50 && (
                                        <button
                                          onClick={() => setSegmentUserExpanded(prev => {
                                            const next = new Set(prev);
                                            next.delete(seg.segment_id);
                                            return next;
                                          })}
                                          className="w-full text-[10px] text-center py-1 rounded-lg hover:bg-white/[0.03] transition-colors"
                                          style={{ color: 'var(--text-muted)' }}
                                        >
                                          折りたたむ
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  );
                                })()}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Sales data (from Block 2) - wrapped in salesLoading check */}
                  {salesLoading ? (
                    <div className="space-y-3">
                      <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
                      <div className="grid grid-cols-4 gap-3">
                        <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                        <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                        <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                        <div className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                      </div>
                    </div>
                  ) : (<>
                  {/* Weekly summary cards */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>
                        {formatTokens(thisWeekCoins)}
                      </p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(thisWeekCoins, coinRate)})</p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-primary)' }}>チャット内チップ（SPYログ）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--accent-amber)' }}>
                        {formatTokens(salesThisWeek)}
                      </p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(salesThisWeek, coinRate)})</p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>今週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全応援（コインAPI）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{ color: 'var(--text-secondary)' }}>
                        {formatTokens(salesLastWeek)}
                      </p>
                      <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>({tokensToJPY(salesLastWeek, coinRate)})</p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>先週売上</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全応援（コインAPI）</p>
                    </div>
                    <div className="glass-card p-4 text-center">
                      <p className="text-xl font-bold" style={{
                        color: salesLastWeek > 0 ? ((salesThisWeek - salesLastWeek) >= 0 ? 'var(--accent-green)' : 'var(--accent-pink)') : 'var(--text-muted)'
                      }}>
                        {salesLastWeek > 0
                          ? `${(salesThisWeek - salesLastWeek) >= 0 ? '↑' : '↓'} ${Math.abs(Math.round((salesThisWeek - salesLastWeek) / salesLastWeek * 100))}%`
                          : '--'}
                      </p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>前週比</p>
                      <p className="text-[9px] font-semibold" style={{ color: 'var(--accent-purple, #a855f7)' }}>全応援（コインAPI）</p>
                    </div>
                  </div>

                  {/* Coin History */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3">直近のコイン履歴 (このキャスト)</h3>
                    {coinTxs.length === 0 ? (
                      <div className="text-center py-6">
                        <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>コイン履歴なし</p>
                        <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          Chrome拡張からStripchatにログインし、Popupの「名簿同期」で取得できます
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1 max-h-80 overflow-auto">
                        {coinTxs.slice(0, 50).map(tx => (
                          <div key={tx.id} className="glass-panel px-3 py-2 flex items-center justify-between text-[11px]">
                            <div className="min-w-0 flex-1">
                              <span className="font-semibold">{tx.user_name}</span>
                              <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded"
                                style={{ background: 'rgba(168,139,250,0.1)', color: 'var(--accent-purple, #a855f7)' }}>
                                {tx.type}
                              </span>
                            </div>
                            <div className="flex-shrink-0 ml-2 text-right">
                              <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                {formatTokens(tx.tokens)}
                              </span>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{timeAgo(tx.date)}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Monthly P/L */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                      📅 月次P/L
                    </h3>
                    {monthlyPLLoading ? (
                      <div className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    ) : monthlyPLError ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--accent-pink)' }}>
                        月次P/Lの取得に失敗しました — ページを再読み込みしてください
                      </p>
                    ) : monthlyPL.length === 0 ? (
                      <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                        コスト未設定 — 設定タブの「コスト設定」で時給・手数料を入力してください
                      </p>
                    ) : (
                      <>
                        {/* 月次バーチャート */}
                        <div className="flex items-end gap-1 h-32 mb-4 px-2">
                          {(() => {
                            const maxRevenue = Math.max(...monthlyPL.map(m => Math.abs(m.net_revenue_jpy)), 1);
                            return Array.from(monthlyPL).reverse().map((m, i) => {
                              const isProfit = m.gross_profit_jpy >= 0;
                              const barH = Math.max((Math.abs(m.net_revenue_jpy) / maxRevenue) * 100, 4);
                              return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                  <span className="text-[9px] font-bold tabular-nums"
                                    style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                    {Math.round(m.gross_profit_jpy / 1000)}k
                                  </span>
                                  <div className="w-full rounded-t-md transition-all" style={{
                                    height: `${barH}%`,
                                    background: isProfit
                                      ? 'linear-gradient(to top, rgba(34,197,94,0.3), rgba(34,197,94,0.6))'
                                      : 'linear-gradient(to top, rgba(244,63,94,0.3), rgba(244,63,94,0.6))',
                                    border: `1px solid ${isProfit ? 'rgba(34,197,94,0.3)' : 'rgba(244,63,94,0.3)'}`,
                                  }} />
                                  <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                    {m.month.slice(5)}月
                                  </span>
                                </div>
                              );
                            });
                          })()}
                        </div>

                        {/* 月次テーブル */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                <th className="text-left py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>月</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>配信数</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>時間</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>ネット売上</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>人件費</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>固定費</th>
                                <th className="text-right py-2 px-1.5 font-bold" style={{ color: 'var(--text-muted)' }}>粗利</th>
                                <th className="text-right py-2 px-1.5" style={{ color: 'var(--text-muted)' }}>利益率</th>
                              </tr>
                            </thead>
                            <tbody>
                              {monthlyPL.map((m, i) => {
                                const isProfit = m.gross_profit_jpy >= 0;
                                return (
                                  <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                    <td className="py-1.5 px-1.5 font-medium">{m.month}</td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums">{m.total_sessions}</td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums">{m.total_hours}h</td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums">
                                      {Math.round(m.net_revenue_jpy).toLocaleString()}円
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-pink)' }}>
                                      -{Math.round(m.total_cast_cost_jpy).toLocaleString()}
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums" style={{ color: 'var(--accent-pink)' }}>
                                      {(m.monthly_fixed_cost_jpy ?? 0) > 0 ? `-${(m.monthly_fixed_cost_jpy ?? 0).toLocaleString()}` : '—'}
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums font-bold"
                                      style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                      {isProfit ? '+' : ''}{Math.round(m.gross_profit_jpy).toLocaleString()}円
                                    </td>
                                    <td className="py-1.5 px-1.5 text-right tabular-nums"
                                      style={{ color: isProfit ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                                      {m.profit_margin > 0 ? '+' : ''}{m.profit_margin}%
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

                  {/* Revenue Share */}
                  <div className="glass-card p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold flex items-center gap-2">
                        <span style={{ color: 'var(--accent-primary)' }}>$</span>
                        レベニューシェア（週次）
                      </h3>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        直近90日 / coin_transactions.tokens / 月曜03:00 JST境界
                      </span>
                    </div>

                    {revenueShareLoading ? (
                      <div className="h-32 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                    ) : revenueShare.length === 0 ? (
                      <div className="text-center py-6 rounded-xl" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
                        <p className="text-xs" style={{ color: 'var(--accent-amber)' }}>データなし</p>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          cast_cost_settings に設定がないか、該当期間の取引がありません
                        </p>
                      </div>
                    ) : (() => {
                      const rsTotals = revenueShare.reduce(
                        (acc, r) => ({
                          tokens: acc.tokens + r.total_tokens,
                          txCount: acc.txCount + r.transaction_count,
                          gross: acc.gross + r.gross_usd,
                          fee: acc.fee + r.platform_fee_usd,
                          net: acc.net + r.net_usd,
                          payment: acc.payment + r.cast_payment_usd,
                        }),
                        { tokens: 0, txCount: 0, gross: 0, fee: 0, net: 0, payment: 0 },
                      );
                      const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                      return (
                        <>
                          {/* Summary cards */}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                            <div className="glass-panel p-3 rounded-xl text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>グロス売上</p>
                              <p className="text-lg font-bold font-mono">{fmtUsd(rsTotals.gross)}</p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                {formatTokens(rsTotals.tokens)} × ${revenueShare[0]?.setting_token_to_usd ?? 0.05}
                              </p>
                            </div>
                            <div className="glass-panel p-3 rounded-xl text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>PF手数料</p>
                              <p className="text-lg font-bold font-mono" style={{ color: 'var(--accent-pink)' }}>-{fmtUsd(rsTotals.fee)}</p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                {revenueShare[0]?.setting_platform_fee_pct ?? 40}%
                              </p>
                            </div>
                            <div className="glass-panel p-3 rounded-xl text-center">
                              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ネット売上</p>
                              <p className="text-lg font-bold font-mono">{fmtUsd(rsTotals.net)}</p>
                            </div>
                            <div className="glass-panel p-3 rounded-xl text-center" style={{ border: '1px solid rgba(56,189,248,0.15)' }}>
                              <p className="text-[10px]" style={{ color: 'var(--accent-primary)' }}>キャスト支払い</p>
                              <p className="text-xl font-bold font-mono" style={{ color: 'var(--accent-primary)' }}>{fmtUsd(rsTotals.payment)}</p>
                              <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                ネット × {revenueShare[0]?.setting_revenue_share_pct ?? 50}%
                              </p>
                            </div>
                          </div>

                          {/* Weekly table */}
                          <div className="overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr style={{ color: 'var(--text-muted)' }}>
                                  <th className="text-left pb-2 font-medium">週</th>
                                  <th className="text-right pb-2 font-medium">トークン</th>
                                  <th className="text-right pb-2 font-medium">グロス</th>
                                  <th className="text-right pb-2 font-medium">手数料</th>
                                  <th className="text-right pb-2 font-medium">ネット</th>
                                  <th className="text-right pb-2 font-medium" style={{ color: 'var(--accent-primary)' }}>支払い</th>
                                  <th className="text-center pb-2 font-medium">根拠</th>
                                </tr>
                              </thead>
                              <tbody>
                                {revenueShare.map(r => (
                                  <tr key={r.week_start} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                                    <td className="py-1.5 font-mono">{r.week_label}</td>
                                    <td className="py-1.5 text-right tabular-nums">{(r.total_tokens ?? 0).toLocaleString()}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono">{fmtUsd(r.gross_usd)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono" style={{ color: 'var(--accent-pink)' }}>-{fmtUsd(r.platform_fee_usd)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono">{fmtUsd(r.net_usd)}</td>
                                    <td className="py-1.5 text-right tabular-nums font-mono font-bold" style={{ color: 'var(--accent-primary)' }}>{fmtUsd(r.cast_payment_usd)}</td>
                                    <td className="py-1.5 text-center">
                                      <button
                                        className="text-[10px] hover:text-sky-400 transition-colors"
                                        style={{ color: 'var(--text-muted)' }}
                                        onClick={() => setRevenueShareExpanded(revenueShareExpanded === r.week_start ? null : r.week_start)}
                                      >
                                        {revenueShareExpanded === r.week_start ? '閉じる' : '詳細'}
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                                {revenueShareExpanded && (() => {
                                  const r = revenueShare.find(r => r.week_start === revenueShareExpanded);
                                  if (!r) return null;
                                  return (
                                    <tr>
                                      <td colSpan={7} className="p-0">
                                        <div className="p-3 space-y-1.5 text-[10px] font-mono" style={{ background: 'rgba(56,189,248,0.03)', borderTop: '1px solid rgba(56,189,248,0.1)', borderBottom: '1px solid rgba(56,189,248,0.1)' }}>
                                          <p style={{ color: 'var(--text-muted)' }}>
                                            設定: 1tk=${r.setting_token_to_usd} / PF手数料={r.setting_platform_fee_pct}% / 分配率={r.setting_revenue_share_pct}%
                                          </p>
                                          <p>1. グロス: <span style={{ color: 'var(--text-primary)' }}>{r.formula_gross}</span></p>
                                          <p>2. PF手数料: <span style={{ color: 'var(--accent-pink)' }}>{r.formula_fee}</span></p>
                                          <p>3. ネット: <span style={{ color: 'var(--text-primary)' }}>{r.formula_net}</span></p>
                                          <p>4. キャスト支払い: <span style={{ color: 'var(--accent-primary)' }}>{r.formula_payment}</span></p>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })()}
                              </tbody>
                              <tfoot>
                                <tr className="font-bold" style={{ borderTop: '2px solid rgba(56,189,248,0.15)' }}>
                                  <td className="py-2">合計 ({revenueShare.length}週)</td>
                                  <td className="py-2 text-right tabular-nums">{(rsTotals.tokens ?? 0).toLocaleString()}</td>
                                  <td className="py-2 text-right tabular-nums font-mono">{fmtUsd(rsTotals.gross)}</td>
                                  <td className="py-2 text-right tabular-nums font-mono" style={{ color: 'var(--accent-pink)' }}>-{fmtUsd(rsTotals.fee)}</td>
                                  <td className="py-2 text-right tabular-nums font-mono">{fmtUsd(rsTotals.net)}</td>
                                  <td className="py-2 text-right tabular-nums font-mono" style={{ color: 'var(--accent-primary)' }}>{fmtUsd(rsTotals.payment)}</td>
                                  <td />
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  </>)}
  </>);
}
