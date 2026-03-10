'use client';

import { useState, useMemo } from 'react';
import { formatTokens, tokensToJPY, formatJST } from '@/lib/utils';
import { getUserColorFromCoins } from '@/lib/stripchat-levels';
import type { AcquisitionUser } from '@/types/analytics';

interface UserAcquisitionProps {
  coinRate: number;
  // Acquisition data
  acqUsers: AcquisitionUser[];
  acqLoading: boolean;
  acqDays: number;
  setAcqDays: (v: number) => void;
  acqMinCoins: number;
  setAcqMinCoins: (v: number) => void;
  acqMaxCoins: number;
  setAcqMaxCoins: (v: number) => void;
  acqPreset: string;
  setAcqPreset: (v: string) => void;
  acqFilter: 'all' | 'new' | 'dm_sent' | 'dm_converted';
  setAcqFilter: (v: 'all' | 'new' | 'dm_sent' | 'dm_converted') => void;
  acqSortKey: 'total_coins' | 'tx_count' | 'last_payment_date' | 'user_name';
  setAcqSortKey: (v: 'total_coins' | 'tx_count' | 'last_payment_date' | 'user_name') => void;
  acqSortAsc: boolean;
  setAcqSortAsc: (v: boolean) => void;
  // Target search
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  searchResults: {
    user_name: string; total_coins: number; last_payment_date: string | null;
    last_actual_payment: string | null; first_seen: string | null;
    tx_count: number; segment: string; found: boolean;
    dm_history: { campaign: string; sent_date: string; status: string }[];
    recent_transactions: { date: string; amount: number; type: string }[];
  }[];
  searchLoading: boolean;
  handleSearchUser: () => void;
  // Overlap / Competitor
  overlapLoading: boolean;
  overlapRefreshing: boolean;
  overlapMatrix: { own_cast: string; spy_cast: string; overlap_users: number; overlap_tokens: number; own_total_users: number }[];
  spyTopUsers: { user_name: string; spy_casts: string[]; spy_total_tokens: number; own_total_coins: number; own_segment: string | null; cast_count: number }[];
  lastProfileUpdate: string | null;
  handleRefreshProfiles: () => void;
}

export default function UserAcquisition({
  coinRate,
  acqUsers,
  acqLoading,
  acqDays,
  setAcqDays,
  acqMinCoins,
  setAcqMinCoins,
  acqMaxCoins,
  setAcqMaxCoins,
  acqPreset,
  setAcqPreset,
  acqFilter,
  setAcqFilter,
  acqSortKey,
  setAcqSortKey,
  acqSortAsc,
  setAcqSortAsc,
  searchQuery,
  setSearchQuery,
  searchResults,
  searchLoading,
  handleSearchUser,
  overlapLoading,
  overlapRefreshing,
  overlapMatrix,
  spyTopUsers,
  lastProfileUpdate,
  handleRefreshProfiles,
}: UserAcquisitionProps) {
  // Internal UI state
  const [showTicketUsers, setShowTicketUsers] = useState(false);
  const [acqShowAll, setAcqShowAll] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<string | null>(null);
  const [searchMissesOpen, setSearchMissesOpen] = useState(false);

  const toggleAcqSort = (key: typeof acqSortKey) => {
    if (acqSortKey === key) setAcqSortAsc(!acqSortAsc);
    else { setAcqSortKey(key); setAcqSortAsc(false); }
  };

  const acqFiltered = useMemo(() => {
    let list = [...acqUsers];
    if (acqFilter === 'new') list = list.filter(u => u.is_new_user);
    else if (acqFilter === 'dm_sent') list = list.filter(u => u.dm_sent);
    else if (acqFilter === 'dm_converted') list = list.filter(u => u.converted_after_dm);
    list.sort((a, b) => {
      let cmp = 0;
      if (acqSortKey === 'total_coins') cmp = a.total_coins - b.total_coins;
      else if (acqSortKey === 'tx_count') cmp = a.tx_count - b.tx_count;
      else if (acqSortKey === 'last_payment_date') cmp = (a.last_payment_date || '').localeCompare(b.last_payment_date || '');
      else if (acqSortKey === 'user_name') cmp = a.user_name.localeCompare(b.user_name);
      return acqSortAsc ? cmp : -cmp;
    });
    return list;
  }, [acqUsers, acqFilter, acqSortKey, acqSortAsc]);

  const acqSummary = useMemo(() => {
    const total = acqUsers.length;
    const newUsers = acqUsers.filter(u => u.is_new_user).length;
    const dmSent = acqUsers.filter(u => u.dm_sent).length;
    const dmConverted = acqUsers.filter(u => u.converted_after_dm).length;
    const cvr = dmSent > 0 ? Math.round(dmConverted / dmSent * 100) : 0;
    const ticketCandidates = acqUsers.filter(u => u.total_coins >= 150 && u.total_coins <= 300 && u.tx_count <= 3);
    return { total, newUsers, dmSent, dmConverted, cvr, ticketCandidates };
  }, [acqUsers]);

  return (<>
                  {/* ============ ACQUISITION DASHBOARD ============ */}
                  <div className="glass-card p-4">
                    <h3 className="text-sm font-bold mb-1">📊 ユーザー獲得ダッシュボード</h3>
                    <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>
                      新規応援ユーザーの特定・DM施策の効果測定・チケットチャット初回ユーザー抽出
                    </p>

                    {/* Target search */}
                    <div className="glass-panel rounded-xl p-3 mb-4">
                      <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>🔍 ターゲット検索</p>
                      <div className="flex gap-2 items-end">
                        <textarea
                          placeholder="ユーザー名またはURLを1行ずつ入力（改行区切り）"
                          value={searchQuery}
                          onChange={e => setSearchQuery(e.target.value)}
                          rows={3}
                          className="input-glass text-[11px] flex-1 py-1.5 px-3 resize-y min-h-[60px]"
                        />
                        <div className="flex flex-col gap-1">
                          <button onClick={handleSearchUser} disabled={searchLoading || !searchQuery.trim()}
                            className="btn-primary text-[10px] py-1.5 px-4 disabled:opacity-40">
                            {searchLoading
                              ? `${Array.from(new Set(searchQuery.split('\n').map(s => s.trim()).filter(Boolean))).length}名検索中...`
                              : '検索'}
                          </button>
                          {searchQuery.trim() && (
                            <span className="text-[9px] text-center tabular-nums" style={{ color: 'var(--text-muted)' }}>
                              {Array.from(new Set(searchQuery.split('\n').map(s => s.trim()).filter(Boolean))).length}名
                            </span>
                          )}
                        </div>
                      </div>
                      {searchResults.length > 0 && (() => {
                        const hits = searchResults.filter(r => r.found);
                        const misses = searchResults.filter(r => !r.found);
                        return (
                        <div className="mt-3 space-y-2">
                          <p className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                            {searchResults.length}名中{' '}
                            <span style={{ color: 'var(--accent-green)' }}>{hits.length}名ヒット</span>
                            {misses.length > 0 && (
                              <> / <span style={{ color: 'var(--accent-pink)' }}>{misses.length}名該当なし</span></>
                            )}
                          </p>
                          {/* Hit cards */}
                          {hits.map(r => (
                            <div key={r.user_name} className="glass-panel rounded-xl p-3" style={{ borderLeft: '3px solid var(--accent-primary)' }}>
                              <div className="flex items-start justify-between mb-2">
                                <div>
                                  <span className="text-xs font-bold" style={{ color: getUserColorFromCoins(r.total_coins) }}>
                                    👤 {r.user_name}
                                  </span>
                                  <span className="text-[9px] ml-2 px-1.5 py-0.5 rounded" style={{
                                    background: r.segment.includes('Whale') ? 'rgba(239,68,68,0.15)' :
                                      r.segment.includes('VIP') ? 'rgba(245,158,11,0.15)' : 'rgba(255,255,255,0.05)',
                                    color: r.segment.includes('Whale') ? '#ef4444' :
                                      r.segment.includes('VIP') ? '#f59e0b' : 'var(--text-muted)',
                                  }}>{r.segment}</span>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] mb-2">
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>累計: </span>
                                  <span className="font-bold" style={{ color: 'var(--accent-amber)' }}>{formatTokens(r.total_coins)}</span>
                                  <span style={{ color: 'var(--text-muted)' }}> ({r.tx_count}回)</span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>最終応援: </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {(r.last_actual_payment || r.last_payment_date)
                                      ? new Date(r.last_actual_payment || r.last_payment_date!).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                      : '--'}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>初回登録: </span>
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {r.first_seen ? new Date(r.first_seen).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}
                                  </span>
                                </div>
                                <div>
                                  <span style={{ color: 'var(--text-muted)' }}>DM履歴: </span>
                                  {r.dm_history.length > 0 ? (
                                    <span style={{ color: '#a855f7' }}>
                                      {r.dm_history[0].campaign} ({new Date(r.dm_history[0].sent_date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })})
                                    </span>
                                  ) : (
                                    <span style={{ color: 'var(--text-muted)' }}>なし</span>
                                  )}
                                </div>
                              </div>
                              {/* Recent transactions - collapsible */}
                              {r.recent_transactions.length > 0 && (
                                <div>
                                  <button onClick={() => setSearchExpanded(searchExpanded === r.user_name ? null : r.user_name)}
                                    className="text-[10px] hover:underline" style={{ color: 'var(--accent-primary)' }}>
                                    {searchExpanded === r.user_name ? '▼' : '▶'} 直近トランザクション ({r.recent_transactions.length}件)
                                  </button>
                                  {searchExpanded === r.user_name && (
                                    <div className="mt-1 space-y-0.5 max-h-40 overflow-auto">
                                      {r.recent_transactions.map((tx, i) => (
                                        <div key={i} className="flex items-center justify-between text-[10px] px-2 py-0.5 rounded hover:bg-white/[0.03]">
                                          <span style={{ color: 'var(--text-muted)' }}>
                                            {new Date(tx.date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                          <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                                            {formatTokens(tx.amount)}
                                          </span>
                                          <span className="text-[9px]" style={{ color: 'var(--text-secondary)' }}>
                                            {tx.type === 'ticketShow' ? 'チケットチャット' :
                                             tx.type === 'publicPresent' ? '公開プレゼント' :
                                             tx.type === 'privatePresent' ? '非公開プレゼント' :
                                             tx.type === 'spy' ? 'スパイ' : tx.type}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                          {/* Misses - collapsible */}
                          {misses.length > 0 && (
                            <div className="glass-panel rounded-xl overflow-hidden" style={{ background: 'rgba(244,63,94,0.04)' }}>
                              <button onClick={() => setSearchMissesOpen(!searchMissesOpen)}
                                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-white/[0.02] transition-colors">
                                <span className="text-[10px]">{searchMissesOpen ? '▼' : '▶'}</span>
                                <span className="text-[11px] font-semibold" style={{ color: 'var(--accent-pink)' }}>
                                  ❌ 該当なし（{misses.length}名）
                                </span>
                              </button>
                              {searchMissesOpen && (
                                <div className="px-3 pb-2 space-y-0.5">
                                  {misses.map(m => (
                                    <div key={m.user_name} className="text-[11px] px-2 py-1 rounded" style={{ color: 'var(--accent-pink)' }}>
                                      {m.user_name}
                                      <span className="ml-2" style={{ color: 'var(--text-muted)' }}>— このキャストの応援履歴なし</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        );
                      })()}
                    </div>

                    {/* Filter bar - sticky */}
                    <div className="sticky top-0 z-10 glass-panel rounded-xl p-3 mb-4 space-y-2" style={{ backdropFilter: 'blur(16px)' }}>
                      {/* Period */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>期間:</span>
                        {[7, 14, 30, 60, 90].map(d => (
                          <button key={d} onClick={() => setAcqDays(d)}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqDays === d ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqDays === d ? 'var(--accent-primary)' : 'var(--text-secondary)',
                              border: `1px solid ${acqDays === d ? 'rgba(56,189,248,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {d}日
                          </button>
                        ))}
                      </div>
                      {/* Coin range: presets + custom inputs */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>閾値:</span>
                        {([
                          { key: 'ticket', label: '初回チケット', min: 150, max: 300 },
                          { key: 'mid', label: '中堅', min: 200, max: 550 },
                          { key: 'regular', label: '常連', min: 550, max: 1400 },
                          { key: 'vip', label: 'VIP', min: 1400, max: 3500 },
                          { key: 'whale', label: 'Whale', min: 3500, max: 999999 },
                          { key: 'all', label: '全範囲', min: 0, max: 999999 },
                        ] as const).map(p => (
                          <button key={p.key} onClick={() => { setAcqMinCoins(p.min); setAcqMaxCoins(p.max); setAcqPreset(p.key); }}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqPreset === p.key ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqPreset === p.key ? 'var(--accent-amber)' : 'var(--text-secondary)',
                              border: `1px solid ${acqPreset === p.key ? 'rgba(245,158,11,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5 pl-14">
                        <input type="number" placeholder="min" value={acqMinCoins || ''} min={0}
                          onChange={e => { setAcqMinCoins(parseInt(e.target.value) || 0); setAcqPreset('custom'); }}
                          className="input-glass text-[10px] w-16 py-1 px-2 text-center tabular-nums" />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>tk ～</span>
                        <input type="number" placeholder="max" value={acqMaxCoins >= 999999 ? '' : acqMaxCoins} min={0}
                          onChange={e => { setAcqMaxCoins(parseInt(e.target.value) || 999999); setAcqPreset('custom'); }}
                          className="input-glass text-[10px] w-16 py-1 px-2 text-center tabular-nums" />
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>tk</span>
                      </div>
                      {/* View filter */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-semibold w-12" style={{ color: 'var(--text-muted)' }}>表示:</span>
                        {([
                          { key: 'all', label: '全員' },
                          { key: 'new', label: '新規のみ' },
                          { key: 'dm_sent', label: 'DM送信済のみ' },
                          { key: 'dm_converted', label: 'DM→応援のみ' },
                        ] as const).map(f => (
                          <button key={f.key} onClick={() => setAcqFilter(f.key)}
                            className="text-[10px] px-2.5 py-1 rounded-lg transition-all"
                            style={{
                              background: acqFilter === f.key ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.03)',
                              color: acqFilter === f.key ? 'var(--accent-green)' : 'var(--text-secondary)',
                              border: `1px solid ${acqFilter === f.key ? 'rgba(34,197,94,0.3)' : 'var(--border-glass)'}`,
                            }}>
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Summary cards */}
                    {acqLoading ? (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                        {[0,1,2,3].map(i => (
                          <div key={i} className="glass-panel p-4 rounded-xl animate-pulse">
                            <div className="h-6 rounded" style={{ background: 'rgba(255,255,255,0.05)' }} />
                            <div className="h-3 rounded mt-2 w-2/3" style={{ background: 'rgba(255,255,255,0.03)' }} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(56,189,248,0.3), rgba(56,189,248,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: 'var(--accent-primary)' }}>{acqSummary.total}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>対象ユーザー</p>
                          </div>
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(34,197,94,0.3), rgba(34,197,94,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: 'var(--accent-green)' }}>{acqSummary.newUsers}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>完全新規</p>
                          </div>
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(168,85,247,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: '#a855f7' }}>{acqSummary.dmSent}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>DM送信済</p>
                          </div>
                          <div className="glass-panel p-4 rounded-xl text-center" style={{ borderImage: 'linear-gradient(135deg, rgba(245,158,11,0.3), rgba(245,158,11,0.05)) 1' }}>
                            <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>{acqSummary.dmConverted}</p>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                              DM→応援 {acqSummary.dmSent > 0 && <span className="font-bold">CVR {acqSummary.cvr}%</span>}
                            </p>
                          </div>
                        </div>

                        {/* Ticket chat candidates (accordion) */}
                        {acqSummary.ticketCandidates.length > 0 && (
                          <div className="glass-panel rounded-xl p-3 mb-4" style={{ borderLeft: '3px solid var(--accent-amber)' }}>
                            <button
                              onClick={() => setShowTicketUsers(!showTicketUsers)}
                              className="flex items-center gap-2 w-full text-left hover:opacity-80 transition-opacity"
                            >
                              <span className="text-sm">{showTicketUsers ? '▼' : '▶'}</span>
                              <span className="text-[11px] font-bold" style={{ color: 'var(--accent-amber)' }}>
                                🎫 チケットチャット初回の可能性: {acqSummary.ticketCandidates.length}名
                              </span>
                            </button>
                            {showTicketUsers && (
                              <div className="max-h-40 overflow-y-auto mt-2 space-y-0.5">
                                {acqSummary.ticketCandidates.map(u => (
                                  <div key={u.user_name} className="flex items-center justify-between text-[10px] px-2 py-1 rounded hover:bg-white/[0.03]">
                                    <span className="truncate font-medium" style={{ color: getUserColorFromCoins(u.total_coins) }}>
                                      {u.user_name}
                                    </span>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      <span className="tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                        {formatTokens(u.total_coins)}
                                      </span>
                                      <span style={{ color: 'var(--text-muted)' }}>{u.tx_count}回</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* User table */}
                        <div className="overflow-auto">
                          <table className="w-full text-[11px]">
                            <thead>
                              <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-glass)' }}>
                                <th className="text-left px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('user_name')}>
                                  ユーザー名 {acqSortKey === 'user_name' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('total_coins')}>
                                  累計tk {acqSortKey === 'total_coins' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('tx_count')}>
                                  回数 {acqSortKey === 'tx_count' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-white transition-colors"
                                  onClick={() => toggleAcqSort('last_payment_date')}>
                                  最終応援 {acqSortKey === 'last_payment_date' && (acqSortAsc ? '↑' : '↓')}
                                </th>
                                <th className="text-center px-3 py-2 font-semibold">セグメント</th>
                                <th className="text-left px-3 py-2 font-semibold">DM施策</th>
                                <th className="text-center px-3 py-2 font-semibold">ステータス</th>
                              </tr>
                            </thead>
                            <tbody>
                              {acqFiltered.length === 0 ? (
                                <tr>
                                  <td colSpan={7} className="text-center py-6" style={{ color: 'var(--text-muted)' }}>
                                    条件に合致するユーザーなし
                                  </td>
                                </tr>
                              ) : (acqShowAll ? acqFiltered : acqFiltered.slice(0, 30)).map(u => {
                                const isTicketCandidate = u.total_coins >= 150 && u.total_coins <= 300 && u.tx_count <= 3;
                                const rowBg = u.converted_after_dm
                                  ? 'rgba(245,158,11,0.06)'
                                  : u.is_new_user
                                  ? 'rgba(34,197,94,0.06)'
                                  : 'transparent';
                                return (
                                  <tr key={u.user_name}
                                    className="hover:bg-white/[0.03] transition-colors"
                                    style={{ borderBottom: '1px solid var(--border-glass)', background: rowBg }}>
                                    <td className="px-3 py-2 font-semibold">
                                      <span style={{ color: getUserColorFromCoins(u.total_coins) }}>
                                        {u.is_new_user && <span title="新規ユーザー" className="mr-1">🆕</span>}
                                        {isTicketCandidate && <span title="チケットチャット初回候補" className="mr-1">🎫</span>}
                                        {u.user_name}
                                      </span>
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums font-bold" style={{ color: 'var(--accent-amber)' }}>
                                      {u.total_coins.toLocaleString()}
                                    </td>
                                    <td className="text-right px-3 py-2 tabular-nums">{u.tx_count.toLocaleString()}回</td>
                                    <td className="text-right px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                                      {u.last_payment_date ? new Date(u.last_payment_date).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'}
                                    </td>
                                    <td className="text-center px-3 py-2">
                                      <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                                        background: u.segment.includes('Whale') ? 'rgba(239,68,68,0.15)' :
                                          u.segment.includes('VIP') ? 'rgba(245,158,11,0.15)' :
                                          u.segment.includes('常連') ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.05)',
                                        color: u.segment.includes('Whale') ? '#ef4444' :
                                          u.segment.includes('VIP') ? '#f59e0b' :
                                          u.segment.includes('常連') ? '#22c55e' : 'var(--text-muted)',
                                      }}>
                                        {u.segment}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                                      {u.dm_campaign || '-'}
                                    </td>
                                    <td className="text-center px-3 py-2 text-[10px]">
                                      {u.converted_after_dm ? (
                                        <span style={{ color: 'var(--accent-amber)' }}>✅ DM→応援</span>
                                      ) : u.dm_sent ? (
                                        <span style={{ color: 'var(--text-muted)' }}>💌 DM済・未応援</span>
                                      ) : (
                                        <span style={{ color: 'var(--accent-green)' }}>🆕 自然流入</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {acqFiltered.length > 0 && (
                          <div className="flex items-center justify-between mt-1">
                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {acqShowAll ? acqFiltered.length : Math.min(acqFiltered.length, 30)}件表示（全{acqUsers.length}件中）
                            </p>
                            {!acqShowAll && acqFiltered.length > 30 && (
                              <button
                                onClick={() => setAcqShowAll(true)}
                                className="text-[10px] px-3 py-1 rounded-lg hover:bg-white/[0.03] transition-all"
                                style={{ color: 'var(--accent-primary)' }}
                              >
                                + 残り{acqFiltered.length - 30}名を表示
                              </button>
                            )}
                            {acqShowAll && acqFiltered.length > 30 && (
                              <button
                                onClick={() => setAcqShowAll(false)}
                                className="text-[10px] px-3 py-1 rounded-lg hover:bg-white/[0.03] transition-all"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                折りたたむ
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  {/* Overlap/Competitor (from Block 3) */}
                  {overlapLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="h-24 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
                      ))}
                    </div>
                  ) : (
                    <>
                      {/* Section 1: データ更新 */}
                      <div className="glass-card p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h3 className="text-sm font-bold flex items-center gap-2">
                              🔄 プロフィール集計
                            </h3>
                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                              spy_messages からユーザー×キャスト別にトークン・出現回数を集計
                            </p>
                            {lastProfileUpdate && (
                              <p className="text-[9px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                最終更新: {formatJST(lastProfileUpdate)}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={handleRefreshProfiles}
                            disabled={overlapRefreshing}
                            className="btn-primary text-xs px-4 py-2"
                            style={{ opacity: overlapRefreshing ? 0.5 : 1 }}
                          >
                            {overlapRefreshing ? '集計中...' : '集計を更新'}
                          </button>
                        </div>
                      </div>

                      {/* Section 2: サマリーカード */}
                      {(() => {
                        const totalSpyUsers = new Set(spyTopUsers.map(u => u.user_name)).size;
                        const overlapUserSet = new Set(
                          spyTopUsers.filter(u => u.own_total_coins > 0).map(u => u.user_name)
                        );
                        const overlapRate = totalSpyUsers > 0
                          ? Math.round((overlapUserSet.size / totalSpyUsers) * 100)
                          : 0;
                        const avgSpyTokens = spyTopUsers.length > 0
                          ? Math.round(spyTopUsers.reduce((s, u) => s + u.spy_total_tokens, 0) / spyTopUsers.length)
                          : 0;
                        const prospectCount = spyTopUsers.filter(
                          u => u.own_total_coins === 0 && u.spy_total_tokens >= 100
                        ).length;
                        return (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            {[
                              { label: '他社ユーザー数', value: totalSpyUsers.toLocaleString(), icon: '👥' },
                              { label: '自社との重複率', value: `${overlapRate}%`, icon: '🔗' },
                              { label: '平均他社tk', value: formatTokens(avgSpyTokens), icon: '💰' },
                              { label: '獲得候補数', value: prospectCount.toLocaleString(), icon: '🎯' },
                            ].map((card, i) => (
                              <div key={i} className="glass-card p-3 text-center">
                                <p className="text-lg mb-1">{card.icon}</p>
                                <p className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>{card.value}</p>
                                <p className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{card.label}</p>
                              </div>
                            ))}
                          </div>
                        );
                      })()}

                      {/* Section 3: 重複マトリクス */}
                      <div className="glass-card p-4">
                        <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                          📊 ユーザー重複マトリクス
                        </h3>
                        {overlapMatrix.length === 0 ? (
                          <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>
                            データなし — 「集計を更新」を実行してください
                          </p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                  <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>他社キャスト</th>
                                  <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>重複ユーザー</th>
                                  <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>重複tk</th>
                                  <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>重複率</th>
                                </tr>
                              </thead>
                              <tbody>
                                {overlapMatrix.map((row, i) => {
                                  const rate = row.own_total_users > 0
                                    ? Math.round((row.overlap_users / row.own_total_users) * 100)
                                    : 0;
                                  const heatBg = `rgba(56,189,248,${Math.min(rate / 100, 0.4).toFixed(2)})`;
                                  return (
                                    <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)', background: heatBg }}>
                                      <td className="py-2 px-2 font-medium">{row.spy_cast}</td>
                                      <td className="py-2 px-2 text-right">{row.overlap_users}</td>
                                      <td className="py-2 px-2 text-right" style={{ color: 'var(--accent-amber)' }}>
                                        {formatTokens(row.overlap_tokens)}
                                      </td>
                                      <td className="py-2 px-2 text-right font-bold">{rate}%</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>

                      {/* Section 4: ユーザーランキング */}
                      <div className="glass-card p-4">
                        <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
                          🏆 他社高額応援ユーザーランキング
                        </h3>
                        {spyTopUsers.length === 0 ? (
                          <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>
                            データなし — 「集計を更新」を実行してください
                          </p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                  <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>#</th>
                                  <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>ユーザー</th>
                                  <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>他社tk</th>
                                  <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>キャスト数</th>
                                  <th className="text-right py-2 px-2" style={{ color: 'var(--text-muted)' }}>自社tk</th>
                                  <th className="text-left py-2 px-2" style={{ color: 'var(--text-muted)' }}>セグメント</th>
                                </tr>
                              </thead>
                              <tbody>
                                {spyTopUsers.map((u, i) => {
                                  const segBadge: Record<string, { icon: string; color: string }> = {
                                    whale: { icon: '🐋', color: 'var(--accent-purple)' },
                                    vip: { icon: '👑', color: 'var(--accent-amber)' },
                                    regular: { icon: '⭐', color: 'var(--accent-green)' },
                                    light: { icon: '💡', color: 'var(--text-secondary)' },
                                    new: { icon: '🆕', color: 'var(--accent-primary)' },
                                    churned: { icon: '💤', color: 'var(--text-muted)' },
                                  };
                                  const seg = u.own_segment ? segBadge[u.own_segment] : null;
                                  return (
                                    <tr key={i} style={{ borderBottom: '1px solid var(--border-glass)' }}>
                                      <td className="py-2 px-2" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                                      <td className="py-2 px-2">
                                        <a href={`/users/${encodeURIComponent(u.user_name)}`}
                                          className="hover:underline truncate block max-w-[180px]" style={{ color: 'var(--accent-primary)' }}>
                                          {u.user_name}
                                        </a>
                                        <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                          {(u.spy_casts || []).slice(0, 3).join(', ')}{(u.spy_casts || []).length > 3 ? ` +${u.spy_casts.length - 3}` : ''}
                                        </p>
                                      </td>
                                      <td className="py-2 px-2 text-right font-medium" style={{ color: 'var(--accent-amber)' }}>
                                        {formatTokens(u.spy_total_tokens)}
                                      </td>
                                      <td className="py-2 px-2 text-right">{u.cast_count}</td>
                                      <td className="py-2 px-2 text-right">
                                        {u.own_total_coins > 0 ? formatTokens(u.own_total_coins) : (
                                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                                        )}
                                      </td>
                                      <td className="py-2 px-2">
                                        {seg ? (
                                          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
                                            style={{ background: `${seg.color}20`, color: seg.color }}>
                                            {seg.icon} {u.own_segment}
                                          </span>
                                        ) : (
                                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>未応援</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </>
                  )}
  </>);
}
