'use client';

import { useState, useEffect, useCallback } from 'react';
import type { SB } from '@/types/dm';

interface RfmUser {
  user_name: string;
  recency_days: number;
  frequency: number;
  monetary: number;
  r_score: number;
  f_score: number;
  m_score: number;
  rfm_total: number;
  segment: string;
}

interface SegmentDef {
  key: string;
  icon: string;
  label: string;
  color: string;
  bgColor: string;
  dmAction: string;
}

const SEGMENTS: SegmentDef[] = [
  { key: 'VIP', icon: '👑', label: 'VIP', color: '#f59e0b', bgColor: 'rgba(245,158,11,0.12)', dmAction: '感謝DM' },
  { key: 'ロイヤル', icon: '⭐', label: 'ロイヤル', color: '#a78bfa', bgColor: 'rgba(167,139,250,0.12)', dmAction: '配信告知' },
  { key: 'アクティブ', icon: '🟢', label: 'アクティブ', color: '#22c55e', bgColor: 'rgba(34,197,94,0.12)', dmAction: 'リマインダー' },
  { key: '休眠', icon: '🟡', label: '休眠', color: '#eab308', bgColor: 'rgba(234,179,8,0.12)', dmAction: 'リテンションDM' },
  { key: '離脱', icon: '🔴', label: '離脱', color: '#ef4444', bgColor: 'rgba(239,68,68,0.12)', dmAction: 'コスト対効果低' },
];

interface DmSegmentRfmProps {
  accountId: string;
  castName: string;
  sb: SB;
}

export default function DmSegmentRfm({ accountId, castName, sb }: DmSegmentRfmProps) {
  const [users, setUsers] = useState<RfmUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState<string | null>(null);

  const fetchRfm = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await sb.rpc('get_rfm_segments', {
        p_account_id: accountId,
        p_cast_name: castName,
      });
      if (error) {
        console.error('[RFM] RPC error:', error.message);
        setUsers([]);
      } else {
        setUsers((data || []) as RfmUser[]);
      }
    } catch (e) {
      console.error('[RFM] fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [sb, accountId, castName]);

  useEffect(() => {
    if (accountId && castName) fetchRfm();
  }, [accountId, castName, fetchRfm]);

  // Group users by segment
  const segmentGroups = SEGMENTS.map(seg => {
    const segUsers = users.filter(u => u.segment === seg.key);
    const totalTk = segUsers.reduce((s, u) => s + Number(u.monetary), 0);
    const avgR = segUsers.length > 0 ? Math.round(segUsers.reduce((s, u) => s + u.recency_days, 0) / segUsers.length) : 0;
    const avgF = segUsers.length > 0 ? Math.round(segUsers.reduce((s, u) => s + u.frequency, 0) / segUsers.length * 10) / 10 : 0;
    return { ...seg, users: segUsers, totalTk, avgR, avgF };
  });

  const totalUsers = users.length;

  const handleCopyUsers = async (segKey: string, segUsers: RfmUser[]) => {
    const names = segUsers.map(u => u.user_name).join('\n');
    await navigator.clipboard.writeText(names);
    setCopySuccess(segKey);
    setTimeout(() => setCopySuccess(null), 2000);
  };

  if (loading) {
    return (
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold mb-3">📐 RFM分析</h3>
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg animate-pulse" style={{ background: 'rgba(255,255,255,0.03)' }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold">📐 RFM分析</h3>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          全{totalUsers.toLocaleString()}名
        </span>
      </div>

      <div className="space-y-2">
        {segmentGroups.map(seg => {
          const isExpanded = expandedSegment === seg.key;
          const pct = totalUsers > 0 ? Math.round(seg.users.length / totalUsers * 1000) / 10 : 0;

          return (
            <div key={seg.key} className="rounded-xl overflow-hidden" style={{ background: seg.bgColor, border: `1px solid ${seg.color}22` }}>
              {/* Segment header */}
              <div
                className="px-4 py-3 cursor-pointer hover:brightness-110 transition-all"
                onClick={() => setExpandedSegment(isExpanded ? null : seg.key)}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px]">{seg.icon}</span>
                    <span className="text-[12px] font-bold" style={{ color: seg.color }}>{seg.label}</span>
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {seg.users.length.toLocaleString()}人
                    </span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>({pct}%)</span>
                  </div>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                </div>

                <div className="flex flex-wrap gap-4 text-[10px]">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    合計: {seg.totalTk.toLocaleString()} tk
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    平均R: {seg.avgR}日
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    平均F: {seg.avgF}回
                  </span>
                  <span className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--text-muted)' }}>
                    DM推奨: {seg.dmAction}
                  </span>
                </div>
              </div>

              {/* Expanded user list */}
              {isExpanded && (
                <div className="px-4 pb-3 space-y-2" style={{ borderTop: `1px solid ${seg.color}22` }}>
                  {/* Action buttons */}
                  <div className="flex items-center gap-2 pt-2">
                    <button
                      onClick={() => handleCopyUsers(seg.key, seg.users)}
                      className="text-[10px] px-2.5 py-1 rounded-lg transition-colors"
                      style={{
                        background: copySuccess === seg.key ? 'rgba(34,197,94,0.2)' : 'rgba(56,189,248,0.12)',
                        border: '1px solid rgba(56,189,248,0.3)',
                        color: copySuccess === seg.key ? '#22c55e' : 'var(--accent-primary)',
                      }}
                    >
                      {copySuccess === seg.key ? '✓ コピー完了' : `📋 ユーザー名コピー (${seg.users.length}名)`}
                    </button>
                  </div>

                  {/* User table */}
                  <div className="max-h-64 overflow-auto">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr style={{ color: 'var(--text-muted)' }}>
                          <th className="text-left py-1 pr-2">ユーザー</th>
                          <th className="text-right py-1 px-1">R(日)</th>
                          <th className="text-right py-1 px-1">F(回)</th>
                          <th className="text-right py-1 px-1">M(tk)</th>
                          <th className="text-right py-1 pl-1">スコア</th>
                        </tr>
                      </thead>
                      <tbody>
                        {seg.users.slice(0, 100).map(u => (
                          <tr key={u.user_name} className="hover:bg-white/[0.03]">
                            <td className="py-0.5 pr-2 truncate max-w-[120px]" style={{ color: 'var(--text-secondary)' }}>
                              {u.user_name}
                            </td>
                            <td className="text-right py-0.5 px-1" style={{ color: 'var(--text-muted)' }}>
                              {u.recency_days}
                            </td>
                            <td className="text-right py-0.5 px-1" style={{ color: 'var(--text-muted)' }}>
                              {u.frequency}
                            </td>
                            <td className="text-right py-0.5 px-1" style={{ color: 'var(--text-secondary)' }}>
                              {Number(u.monetary).toLocaleString()}
                            </td>
                            <td className="text-right py-0.5 pl-1 font-medium" style={{ color: seg.color }}>
                              {u.rfm_total}
                              <span className="text-[8px] ml-0.5" style={{ color: 'var(--text-muted)' }}>
                                ({u.r_score}/{u.f_score}/{u.m_score})
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {seg.users.length > 100 && (
                      <p className="text-[10px] text-center py-1" style={{ color: 'var(--text-muted)' }}>
                        ... 他 {seg.users.length - 100}名
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
