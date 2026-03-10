'use client';

import { useState, useCallback } from 'react';
import { formatTokens, timeAgo } from '@/lib/utils';
import type { DMLogItem, FanItem, SB } from '@/types/dm';

interface DmUserListProps {
  dmLogs: DMLogItem[];
  fans: FanItem[];
  accountId: string;
  castName: string;
  sb: SB;
}

export default function DmUserList({ dmLogs, fans, accountId, castName, sb }: DmUserListProps) {
  const [dmUserSearch, setDmUserSearch] = useState('');
  const [dmExpandedUser, setDmExpandedUser] = useState<string | null>(null);
  const [dmUserHistory, setDmUserHistory] = useState<DMLogItem[]>([]);
  const [dmUserHistoryLoading, setDmUserHistoryLoading] = useState(false);

  const loadDmUserHistory = useCallback(async (userName: string) => {
    if (dmExpandedUser === userName) { setDmExpandedUser(null); return; }
    setDmExpandedUser(userName);
    setDmUserHistoryLoading(true);
    const { data } = await sb.from('dm_send_log')
      .select('id, user_name, message, status, error, campaign, queued_at, sent_at')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('user_name', userName)
      .order('created_at', { ascending: false })
      .limit(20);
    setDmUserHistory((data || []) as DMLogItem[]);
    setDmUserHistoryLoading(false);
  }, [dmExpandedUser, accountId, castName, sb]);

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold">👥 ユーザー別DM履歴</h3>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {(() => {
            const userSet = new Set(dmLogs.map(l => l.user_name));
            return `${userSet.size}名にDM送信済み`;
          })()}
        </span>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input
          type="text"
          value={dmUserSearch}
          onChange={e => setDmUserSearch(e.target.value)}
          className="input-glass text-xs w-full"
          placeholder="ユーザー名で検索..."
        />
      </div>

      {dmLogs.length === 0 ? (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>DM送信履歴なし</p>
      ) : (
        <div className="space-y-1 max-h-[500px] overflow-auto">
          {(() => {
            // Group dmLogs by user_name
            const userMap = new Map<string, { lastLog: DMLogItem; count: number; successCount: number }>();
            for (const log of dmLogs) {
              if (!userMap.has(log.user_name)) {
                userMap.set(log.user_name, { lastLog: log, count: 1, successCount: log.status === 'success' ? 1 : 0 });
              } else {
                const entry = userMap.get(log.user_name)!;
                entry.count++;
                if (log.status === 'success') entry.successCount++;
              }
            }
            const filtered = dmUserSearch.trim()
              ? Array.from(userMap.entries()).filter(([name]) => name.toLowerCase().includes(dmUserSearch.toLowerCase()))
              : Array.from(userMap.entries());

            return filtered.map(([userName, info]) => {
              const isExpanded = dmExpandedUser === userName;
              const fan = fans.find(f => f.user_name === userName);
              return (
                <div key={userName}>
                  <button
                    onClick={() => loadDmUserHistory(userName)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-[11px] transition-all ${
                      isExpanded ? 'border' : 'hover:bg-white/[0.03]'
                    }`}
                    style={isExpanded ? { background: 'rgba(56,189,248,0.05)', borderColor: 'rgba(56,189,248,0.15)' } : {}}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold truncate">{userName}</span>
                        {fan && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-bold tabular-nums"
                            style={{ background: 'rgba(245,158,11,0.1)', color: 'var(--accent-amber)' }}>
                            {formatTokens(fan.total_tokens)}
                          </span>
                        )}
                        <span className="text-[9px] px-1.5 py-0.5 rounded"
                          style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                          {info.count}件
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`text-[10px] font-bold ${
                          info.lastLog.status === 'success' ? 'text-emerald-400' :
                          info.lastLog.status === 'error' ? 'text-rose-400' :
                          info.lastLog.status === 'sending' ? 'text-amber-400' : 'text-slate-400'
                        }`}>
                          {info.lastLog.status}
                        </span>
                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                          {info.lastLog.sent_at
                            ? new Date(info.lastLog.sent_at).toLocaleDateString('ja-JP')
                            : timeAgo(info.lastLog.queued_at)}
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      </div>
                    </div>
                  </button>

                  {/* Expanded: DM timeline */}
                  {isExpanded && (
                    <div className="ml-4 mt-1 mb-2 pl-3 border-l-2 space-y-1.5" style={{ borderColor: 'rgba(56,189,248,0.15)' }}>
                      {dmUserHistoryLoading ? (
                        <div className="py-3 text-center">
                          <div className="inline-block w-4 h-4 border-2 rounded-full animate-spin"
                            style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }} />
                        </div>
                      ) : dmUserHistory.length === 0 ? (
                        <p className="text-[10px] py-2" style={{ color: 'var(--text-muted)' }}>履歴なし</p>
                      ) : (
                        dmUserHistory.map(log => (
                          <div key={log.id} className="px-3 py-2 rounded-lg" style={{ background: 'rgba(0,0,0,0.15)' }}>
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
                                  {log.sent_at
                                    ? new Date(log.sent_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                    : new Date(log.queued_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                                {log.campaign && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded"
                                    style={{ background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' }}>
                                    {log.campaign}
                                  </span>
                                )}
                              </div>
                              <span className={`text-[9px] font-bold ${
                                log.status === 'success' ? 'text-emerald-400' :
                                log.status === 'error' ? 'text-rose-400' :
                                log.status === 'sending' ? 'text-amber-400' : 'text-slate-400'
                              }`}>
                                {log.status}
                              </span>
                            </div>
                            {log.message && (
                              <p className="text-[10px] whitespace-pre-wrap break-words" style={{ color: 'var(--text-secondary)' }}>
                                {log.message}
                              </p>
                            )}
                            {log.error && (
                              <p className="text-[9px] mt-1" style={{ color: 'var(--accent-pink)' }}>{log.error}</p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
}
