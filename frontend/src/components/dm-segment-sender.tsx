'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

interface PaidUser {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
}

interface SegmentDef {
  id: string;
  label: string;
  description: string;
  color: string;
  bgColor: string;
  icon: string;
  filter: (u: PaidUser) => boolean;
}

interface SegmentGroup {
  def: SegmentDef;
  users: PaidUser[];
  totalTokens: number;
}

interface Props {
  supabase: SupabaseClient;
  accountId: string;
  castName: string;
  onSendComplete?: () => void;
}

// ============================================================
// Segment definitions
// ============================================================

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function isChurned(u: PaidUser): boolean {
  if (!u.last_payment_date) return true;
  return Date.now() - new Date(u.last_payment_date).getTime() > THIRTY_DAYS_MS;
}

const SEGMENT_DEFS: SegmentDef[] = [
  {
    id: 'whale',
    label: 'Whale',
    description: '3,000tk以上（最重要顧客）',
    color: '#f59e0b',
    bgColor: 'rgba(245,158,11,0.12)',
    icon: '🐋',
    filter: (u) => !isChurned(u) && u.total_coins >= 3000,
  },
  {
    id: 'vip',
    label: 'VIP',
    description: '500〜2,999tk（常連上位）',
    color: '#a78bfa',
    bgColor: 'rgba(167,139,250,0.12)',
    icon: '⭐',
    filter: (u) => !isChurned(u) && u.total_coins >= 500 && u.total_coins < 3000,
  },
  {
    id: 'regular',
    label: 'Regular',
    description: '150〜499tk（常連）',
    color: '#38bdf8',
    bgColor: 'rgba(56,189,248,0.12)',
    icon: '👤',
    filter: (u) => !isChurned(u) && u.total_coins >= 150 && u.total_coins < 500,
  },
  {
    id: 'light',
    label: 'Light',
    description: '1〜149tk（ライトユーザー）',
    color: '#94a3b8',
    bgColor: 'rgba(148,163,184,0.08)',
    icon: '🌱',
    filter: (u) => !isChurned(u) && u.total_coins >= 1 && u.total_coins < 150,
  },
  {
    id: 'churned',
    label: 'Churned',
    description: '30日以上未応援（離脱ユーザー）',
    color: '#f43f5e',
    bgColor: 'rgba(244,63,94,0.10)',
    icon: '💤',
    filter: (u) => isChurned(u) && u.total_coins >= 1,
  },
];

const DEFAULT_TEMPLATES: Record<string, string> = {
  whale: '{username}さん、いつも本当にありがとうございます！{username}さんのおかげで毎日頑張れています。また遊びに来てくれたら嬉しいな！',
  vip: '{username}さん、応援ありがとうございます！{username}さんが来てくれるだけで嬉しいです。またお話しましょう！',
  regular: '{username}さん、こんにちは！最近配信に来てくれてありがとう。また気が向いたら遊びに来てね！',
  light: '{username}さん、はじめまして（かな？）！来てくれてありがとう。また会えたら嬉しいな！',
  churned: '{username}さん、最近見かけなくて寂しいです…！また遊びに来てくれたら嬉しいな。待ってるね！',
};

// ============================================================
// Component
// ============================================================

export default function DmSegmentSender({ supabase, accountId, castName, onSendComplete }: Props) {
  const [allUsers, setAllUsers] = useState<PaidUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSegments, setSelectedSegments] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Record<string, string>>(DEFAULT_TEMPLATES);
  const [useSharedMessage, setUseSharedMessage] = useState(false);
  const [sharedMessage, setSharedMessage] = useState('');
  const [campaign, setCampaign] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ queued: number; errors: string[] } | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Fetch paid users
  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    supabase
      .rpc('get_cast_paid_users', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_limit: 10000,
        p_since: null,
      })
      .then(({ data, error }) => {
        if (error) {
          console.error('[SegmentSender] Failed to load paid users:', error.message);
        }
        setAllUsers((data || []) as PaidUser[]);
        setLoading(false);
      });
  }, [supabase, accountId, castName]);

  // Classify users into segments
  const segmentGroups: SegmentGroup[] = useMemo(() => {
    return SEGMENT_DEFS.map((def) => {
      const users = allUsers.filter(def.filter);
      const totalTokens = users.reduce((sum, u) => sum + u.total_coins, 0);
      return { def, users, totalTokens };
    });
  }, [allUsers]);

  // Selected targets
  const selectedTargets = useMemo(() => {
    const targets: Array<{ user: PaidUser; segment: string; message: string }> = [];
    for (const group of segmentGroups) {
      if (!selectedSegments.has(group.def.id)) continue;
      const msg = useSharedMessage ? sharedMessage : (messages[group.def.id] || '');
      for (const user of group.users) {
        targets.push({ user, segment: group.def.id, message: msg });
      }
    }
    return targets;
  }, [segmentGroups, selectedSegments, messages, useSharedMessage, sharedMessage]);

  // Toggle segment selection
  const toggleSegment = useCallback((segId: string) => {
    setSelectedSegments((prev) => {
      const next = new Set(prev);
      if (next.has(segId)) next.delete(segId);
      else next.add(segId);
      return next;
    });
    setSendResult(null);
  }, []);

  // Send DMs
  const handleSend = useCallback(async () => {
    if (selectedTargets.length === 0) return;
    setSending(true);
    setSendResult(null);

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const errors: string[] = [];
    let totalQueued = 0;

    // Group by segment for batch insert
    const bySegment = new Map<string, typeof selectedTargets>();
    for (const t of selectedTargets) {
      const arr = bySegment.get(t.segment) || [];
      arr.push(t);
      bySegment.set(t.segment, arr);
    }

    for (const [segId, targets] of Array.from(bySegment.entries())) {
      const campaignTag = campaign.trim() || 'segment_dm';
      const bid = `seg_${segId}_${campaignTag}_${timestamp}`;

      const rows = targets.map((t) => ({
        account_id: accountId,
        cast_name: castName,
        user_name: t.user.user_name,
        message: t.message.replace(/\{username\}/g, t.user.user_name),
        status: 'queued',
        campaign: bid,
        template_name: `segment_${segId}`,
        queued_at: now.toISOString(),
      }));

      const { error: insertErr } = await supabase.from('dm_send_log').insert(rows);
      if (insertErr) {
        errors.push(`${segId}: ${insertErr.message}`);
      } else {
        totalQueued += rows.length;
      }
    }

    setSendResult({ queued: totalQueued, errors });
    setSending(false);
    setShowPreview(false);
    setSelectedSegments(new Set());
    if (totalQueued > 0 && onSendComplete) onSendComplete();
  }, [selectedTargets, accountId, castName, campaign, supabase, onSendComplete]);

  // ============================================================
  // Render
  // ============================================================

  if (loading) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-3">
          <div className="animate-spin w-5 h-5 border-2 border-sky-400 border-t-transparent rounded-full" />
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>ユーザーデータを読み込み中...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold">🎯 セグメント別DM送信</h3>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            対象ユーザー: {allUsers.length}名
          </span>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          セグメントを選択 → メッセージ設定 → プレビュー確認 → 一括送信
        </p>
      </div>

      {/* Segment cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {segmentGroups.map((group) => {
          const selected = selectedSegments.has(group.def.id);
          return (
            <button
              key={group.def.id}
              onClick={() => toggleSegment(group.def.id)}
              className="glass-card p-3 text-left transition-all"
              style={{
                borderColor: selected ? group.def.color : 'rgba(56,189,248,0.08)',
                borderWidth: selected ? '2px' : '1px',
                background: selected ? group.def.bgColor : undefined,
              }}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-lg">{group.def.icon}</span>
                <div
                  className="w-4 h-4 rounded border-2 flex items-center justify-center"
                  style={{ borderColor: group.def.color }}
                >
                  {selected && (
                    <div className="w-2 h-2 rounded-sm" style={{ background: group.def.color }} />
                  )}
                </div>
              </div>
              <div className="text-xs font-bold mb-0.5" style={{ color: group.def.color }}>
                {group.def.label}
              </div>
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {group.def.description}
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                  {group.users.length}
                </span>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>名</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {group.totalTokens.toLocaleString()}tk
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Message settings — only show when segments selected */}
      {selectedSegments.size > 0 && (
        <div className="glass-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold">📝 メッセージ設定</h4>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={useSharedMessage}
                onChange={(e) => setUseSharedMessage(e.target.checked)}
                className="accent-sky-400"
              />
              <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                全セグメント共通メッセージ
              </span>
            </label>
          </div>

          {useSharedMessage ? (
            <div>
              <label className="text-[10px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
                共通メッセージ（{'{username}'}で名前置換）
              </label>
              <textarea
                value={sharedMessage}
                onChange={(e) => setSharedMessage(e.target.value)}
                className="input-glass w-full text-xs"
                rows={3}
                placeholder="{username}さん、こんにちは！"
              />
            </div>
          ) : (
            <div className="space-y-3">
              {segmentGroups
                .filter((g) => selectedSegments.has(g.def.id))
                .map((group) => (
                  <div key={group.def.id}>
                    <label className="text-[10px] mb-1 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                      <span>{group.def.icon}</span>
                      <span style={{ color: group.def.color }}>{group.def.label}</span>
                      <span>({group.users.length}名)</span>
                      <span className="ml-1">— {'{username}'}で名前置換</span>
                    </label>
                    <textarea
                      value={messages[group.def.id] || ''}
                      onChange={(e) =>
                        setMessages((prev) => ({ ...prev, [group.def.id]: e.target.value }))
                      }
                      className="input-glass w-full text-xs"
                      rows={2}
                      placeholder={DEFAULT_TEMPLATES[group.def.id]}
                    />
                  </div>
                ))}
            </div>
          )}

          {/* Campaign name */}
          <div>
            <label className="text-[10px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
              キャンペーン名（任意）
            </label>
            <input
              type="text"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              className="input-glass w-full text-xs"
              placeholder="例: 3月復帰DM"
            />
          </div>

          {/* Summary & Preview button */}
          <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid rgba(56,189,248,0.08)' }}>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>
                {selectedTargets.length}名
              </span>
              {' '}に送信予定
              {selectedSegments.size > 0 && (
                <span className="ml-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  ({Array.from(selectedSegments).map(s => {
                    const g = segmentGroups.find(g => g.def.id === s);
                    return g ? `${g.def.icon}${g.users.length}` : '';
                  }).join(' + ')})
                </span>
              )}
            </div>
            <button
              onClick={() => setShowPreview(true)}
              disabled={selectedTargets.length === 0 || selectedTargets.some(t => !t.message.trim())}
              className="btn-primary text-xs px-6 py-2 disabled:opacity-40"
            >
              プレビュー確認 →
            </button>
          </div>
        </div>
      )}

      {/* Send result */}
      {sendResult && (
        <div className="glass-card p-4">
          {sendResult.errors.length === 0 ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--accent-green)' }}>
              ✅ {sendResult.queued}件のDMをキューに登録しました
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-sm" style={{ color: 'var(--accent-green)' }}>
                ✅ {sendResult.queued}件キュー登録
              </div>
              {sendResult.errors.map((err, i) => (
                <div key={i} className="text-xs" style={{ color: 'var(--accent-pink)' }}>
                  ❌ {err}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Preview / Confirmation Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            className="glass-card p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
            style={{ border: '1px solid rgba(56,189,248,0.2)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold">📋 送信プレビュー</h3>
              <button
                onClick={() => setShowPreview(false)}
                className="text-slate-400 hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            {/* Summary */}
            <div className="glass-panel p-3 mb-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-primary)' }}>
                    {selectedTargets.length}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>送信対象</div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-purple)' }}>
                    {selectedSegments.size}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>セグメント</div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                    {castName}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>キャスト</div>
                </div>
              </div>
            </div>

            {/* Per-segment preview */}
            {segmentGroups
              .filter((g) => selectedSegments.has(g.def.id))
              .map((group) => {
                const msg = useSharedMessage ? sharedMessage : (messages[group.def.id] || '');
                const sampleUser = group.users[0]?.user_name || 'sample_user';
                return (
                  <div key={group.def.id} className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span>{group.def.icon}</span>
                      <span className="text-xs font-bold" style={{ color: group.def.color }}>
                        {group.def.label}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {group.users.length}名
                      </span>
                    </div>

                    {/* Message preview */}
                    <div
                      className="glass-panel p-3 text-xs mb-2"
                      style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
                    >
                      <div className="text-[9px] mb-1" style={{ color: 'var(--text-muted)' }}>
                        メッセージ例（{sampleUser}宛）:
                      </div>
                      {msg.replace(/\{username\}/g, sampleUser) || <span style={{ color: 'var(--accent-pink)' }}>メッセージ未設定</span>}
                    </div>

                    {/* User list (collapsed by default, show first 10) */}
                    <details>
                      <summary className="text-[10px] cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                        対象ユーザー一覧を表示 ({group.users.length}名)
                      </summary>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {group.users.slice(0, 50).map((u) => (
                          <span
                            key={u.user_name}
                            className="text-[9px] px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}
                          >
                            {u.user_name} ({u.total_coins}tk)
                          </span>
                        ))}
                        {group.users.length > 50 && (
                          <span className="text-[9px] px-1.5 py-0.5" style={{ color: 'var(--text-muted)' }}>
                            ...他{group.users.length - 50}名
                          </span>
                        )}
                      </div>
                    </details>
                  </div>
                );
              })}

            {/* Confirmation buttons */}
            <div
              className="flex items-center justify-between pt-4 mt-4"
              style={{ borderTop: '1px solid rgba(56,189,248,0.1)' }}
            >
              <button
                onClick={() => setShowPreview(false)}
                className="btn-ghost text-xs px-4 py-2"
              >
                戻る
              </button>
              <button
                onClick={handleSend}
                disabled={sending}
                className="text-xs px-6 py-2 rounded-lg font-bold text-white transition-all"
                style={{
                  background: sending
                    ? 'rgba(100,100,100,0.3)'
                    : 'linear-gradient(135deg, #22c55e, #16a34a)',
                  opacity: sending ? 0.6 : 1,
                }}
              >
                {sending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                    送信中...
                  </span>
                ) : (
                  `✅ ${selectedTargets.length}名にDM送信を実行`
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
