'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

interface AggregatedUser {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
  tx_count: number;
}

interface PresetDef {
  id: string;
  label: string;
  icon: string;
  color: string;
  minCoins: number;
  maxCoins: number;
  description: string;
}

type PeriodKey = '7d' | '30d' | '90d' | 'all' | 'custom';

interface Props {
  supabase: SupabaseClient;
  accountId: string;
  castName: string;
  onSendComplete?: () => void;
}

// ============================================================
// Constants
// ============================================================

const PRESETS: PresetDef[] = [
  { id: 'whale', label: 'Whale', icon: '🐋', color: '#f59e0b', minCoins: 3000, maxCoins: 999999, description: '3,000tk+' },
  { id: 'vip', label: 'VIP', icon: '⭐', color: '#a78bfa', minCoins: 500, maxCoins: 2999, description: '500〜2,999tk' },
  { id: 'regular', label: 'Regular', icon: '👤', color: '#38bdf8', minCoins: 150, maxCoins: 499, description: '150〜499tk' },
  { id: 'light', label: 'Light', icon: '🌱', color: '#94a3b8', minCoins: 1, maxCoins: 149, description: '1〜149tk' },
  { id: 'churned', label: 'Churned', icon: '💤', color: '#f43f5e', minCoins: 1, maxCoins: 999999, description: '離脱(期間内0tk)' },
];

const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string; days: number | null }> = [
  { key: '7d', label: '過去7日', days: 7 },
  { key: '30d', label: '過去30日', days: 30 },
  { key: '90d', label: '過去90日', days: 90 },
  { key: 'all', label: '全期間', days: null },
  { key: 'custom', label: 'カスタム', days: null },
];

const DEFAULT_TEMPLATES: Record<string, string> = {
  whale: '{username}さん、いつも本当にありがとうございます！{username}さんのおかげで毎日頑張れています。また遊びに来てくれたら嬉しいな！',
  vip: '{username}さん、応援ありがとうございます！{username}さんが来てくれるだけで嬉しいです。またお話しましょう！',
  regular: '{username}さん、こんにちは！最近配信に来てくれてありがとう。また気が向いたら遊びに来てね！',
  light: '{username}さん、はじめまして（かな？）！来てくれてありがとう。また会えたら嬉しいな！',
  churned: '{username}さん、最近見かけなくて寂しいです…！また遊びに来てくれたら嬉しいな。待ってるね！',
};

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDate(d);
}

// ============================================================
// Component
// ============================================================

export default function DmSegmentSender({ supabase, accountId, castName, onSendComplete }: Props) {
  // --- Filter state ---
  const [period, setPeriod] = useState<PeriodKey>('all');
  const [customStart, setCustomStart] = useState(() => daysAgo(30));
  const [customEnd, setCustomEnd] = useState(() => formatDate(new Date()));
  const [minCoins, setMinCoins] = useState(1);
  const [maxCoins, setMaxCoins] = useState(999999);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // --- Data state ---
  const [periodUsers, setPeriodUsers] = useState<AggregatedUser[]>([]);
  const [allTimeUsers, setAllTimeUsers] = useState<AggregatedUser[]>([]);
  const [loading, setLoading] = useState(true);

  // --- Send state ---
  const [message, setMessage] = useState('');
  const [campaign, setCampaign] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ queued: number; errors: string[] } | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // ============================================================
  // Data fetching
  // ============================================================

  // Compute date range from period
  const dateRange = useMemo(() => {
    if (period === 'custom') return { start: customStart, end: customEnd };
    const opt = PERIOD_OPTIONS.find((p) => p.key === period);
    if (!opt || opt.days === null) return { start: '2025-02-15', end: formatDate(new Date()) };
    return { start: daysAgo(opt.days), end: formatDate(new Date()) };
  }, [period, customStart, customEnd]);

  // Fetch all-time users (once) for churned detection
  useEffect(() => {
    if (!accountId || !castName) return;
    supabase
      .rpc('get_cast_paid_users', { p_account_id: accountId, p_cast_name: castName, p_limit: 10000, p_since: null })
      .then(({ data }) => {
        setAllTimeUsers(
          ((data || []) as Array<{ user_name: string; total_coins: number; last_payment_date: string | null }>).map(
            (u) => ({ ...u, tx_count: 0 })
          )
        );
      });
  }, [supabase, accountId, castName]);

  // Fetch coin_transactions for the selected period
  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);

    const fetchPeriodData = async () => {
      const { data, error } = await supabase
        .from('coin_transactions')
        .select('user_name, tokens, date')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .gte('date', dateRange.start)
        .lte('date', dateRange.end);

      if (error) {
        console.error('[SegmentSender] coin_transactions query error:', error.message);
        setPeriodUsers([]);
        setLoading(false);
        return;
      }

      // Aggregate by user_name
      const map = new Map<string, { total: number; lastDate: string | null; count: number }>();
      for (const row of data || []) {
        const existing = map.get(row.user_name);
        if (existing) {
          existing.total += row.tokens;
          existing.count += 1;
          if (row.date && (!existing.lastDate || row.date > existing.lastDate)) {
            existing.lastDate = row.date;
          }
        } else {
          map.set(row.user_name, { total: row.tokens, lastDate: row.date, count: 1 });
        }
      }

      const users: AggregatedUser[] = Array.from(map.entries()).map(([user_name, agg]) => ({
        user_name,
        total_coins: agg.total,
        last_payment_date: agg.lastDate,
        tx_count: agg.count,
      }));

      users.sort((a, b) => b.total_coins - a.total_coins);
      setPeriodUsers(users);
      setLoading(false);
    };

    fetchPeriodData();
  }, [supabase, accountId, castName, dateRange.start, dateRange.end]);

  // ============================================================
  // Filtered users (real-time update on filter changes)
  // ============================================================

  const filteredUsers = useMemo(() => {
    // Special case: churned preset — users in allTimeUsers but NOT in periodUsers (or 0 coins in period)
    if (activePreset === 'churned' && period !== 'all') {
      const periodSet = new Set(periodUsers.map((u) => u.user_name));
      return allTimeUsers
        .filter((u) => u.total_coins >= 1 && !periodSet.has(u.user_name))
        .sort((a, b) => b.total_coins - a.total_coins);
    }

    return periodUsers.filter((u) => u.total_coins >= minCoins && u.total_coins <= maxCoins);
  }, [periodUsers, allTimeUsers, minCoins, maxCoins, activePreset, period]);

  // Stats
  const totalFilteredCoins = useMemo(() => filteredUsers.reduce((s, u) => s + u.total_coins, 0), [filteredUsers]);

  // ============================================================
  // Preset handling
  // ============================================================

  const applyPreset = useCallback(
    (preset: PresetDef) => {
      if (activePreset === preset.id) {
        // Deselect
        setActivePreset(null);
        setMinCoins(1);
        setMaxCoins(999999);
        return;
      }

      setActivePreset(preset.id);
      if (preset.id === 'churned') {
        // Churned: switch to 30d period to detect inactivity, show all-time users missing from period
        if (period === 'all') setPeriod('30d');
        setMinCoins(1);
        setMaxCoins(999999);
      } else {
        setMinCoins(preset.minCoins);
        setMaxCoins(preset.maxCoins);
      }
      setMessage(DEFAULT_TEMPLATES[preset.id] || '');
      setSendResult(null);
    },
    [activePreset, period]
  );

  // Clear preset when manually changing filters
  const handleMinChange = useCallback((v: number) => {
    setMinCoins(v);
    setActivePreset(null);
    setSendResult(null);
  }, []);
  const handleMaxChange = useCallback((v: number) => {
    setMaxCoins(v);
    setActivePreset(null);
    setSendResult(null);
  }, []);
  const handlePeriodChange = useCallback((p: PeriodKey) => {
    setPeriod(p);
    setActivePreset(null);
    setSendResult(null);
  }, []);

  // ============================================================
  // Send DMs
  // ============================================================

  const handleSend = useCallback(async () => {
    if (filteredUsers.length === 0 || !message.trim()) return;
    setSending(true);
    setSendResult(null);

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const segLabel = activePreset || `${minCoins}-${maxCoins}tk`;
    const campaignTag = campaign.trim() || 'segment_dm';
    const bid = `seg_${segLabel}_${campaignTag}_${timestamp}`;

    const rows = filteredUsers.map((u) => ({
      account_id: accountId,
      cast_name: castName,
      user_name: u.user_name,
      message: message.replace(/\{username\}/g, u.user_name),
      status: 'queued',
      campaign: bid,
      template_name: `segment_${segLabel}`,
      queued_at: now.toISOString(),
    }));

    const errors: string[] = [];
    let totalQueued = 0;

    // Batch insert in chunks of 500
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: insertErr } = await supabase.from('dm_send_log').insert(chunk);
      if (insertErr) {
        errors.push(`chunk ${Math.floor(i / 500) + 1}: ${insertErr.message}`);
      } else {
        totalQueued += chunk.length;
      }
    }

    setSendResult({ queued: totalQueued, errors });
    setSending(false);
    setShowPreview(false);
    if (totalQueued > 0 && onSendComplete) onSendComplete();
  }, [filteredUsers, message, accountId, castName, campaign, activePreset, minCoins, maxCoins, supabase, onSendComplete]);

  // ============================================================
  // Render
  // ============================================================

  return (
    <div className="space-y-4">
      {/* Period filter */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold">🎯 セグメント別DM送信</h3>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            全ユーザー: {allTimeUsers.length}名
          </span>
        </div>

        {/* Period buttons */}
        <div className="mb-3">
          <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>
            📅 集計期間
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => handlePeriodChange(opt.key)}
                className="text-[11px] px-3 py-1.5 rounded-md transition-all"
                style={{
                  background: period === opt.key ? 'rgba(56,189,248,0.2)' : 'rgba(255,255,255,0.04)',
                  color: period === opt.key ? 'var(--accent-primary)' : 'var(--text-secondary)',
                  border: `1px solid ${period === opt.key ? 'rgba(56,189,248,0.3)' : 'rgba(56,189,248,0.06)'}`,
                  fontWeight: period === opt.key ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom date range */}
        {period === 'custom' && (
          <div className="flex gap-2 mb-3">
            <div className="flex-1">
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                開始日
              </label>
              <input
                type="date"
                value={customStart}
                onChange={(e) => { setCustomStart(e.target.value); setActivePreset(null); setSendResult(null); }}
                className="input-glass w-full text-xs"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                終了日
              </label>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => { setCustomEnd(e.target.value); setActivePreset(null); setSendResult(null); }}
                className="input-glass w-full text-xs"
              />
            </div>
          </div>
        )}

        {/* Coin range filter */}
        <div className="mb-3">
          <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>
            🪙 コイン数レンジ（選択期間内の合計）
          </label>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <input
                type="number"
                value={minCoins}
                onChange={(e) => handleMinChange(Math.max(0, parseInt(e.target.value) || 0))}
                className="input-glass w-full text-xs text-center"
                placeholder="最小"
                min={0}
              />
            </div>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>〜</span>
            <div className="flex-1">
              <input
                type="number"
                value={maxCoins}
                onChange={(e) => handleMaxChange(Math.max(0, parseInt(e.target.value) || 0))}
                className="input-glass w-full text-xs text-center"
                placeholder="最大"
                min={0}
              />
            </div>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>tk</span>
          </div>
        </div>

        {/* Preset buttons */}
        <div>
          <label className="text-[10px] block mb-1.5" style={{ color: 'var(--text-muted)' }}>
            ⚡ プリセット
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset(p)}
                className="text-[11px] px-3 py-1.5 rounded-md transition-all flex items-center gap-1"
                style={{
                  background: activePreset === p.id ? `${p.color}22` : 'rgba(255,255,255,0.04)',
                  color: activePreset === p.id ? p.color : 'var(--text-secondary)',
                  border: `1px solid ${activePreset === p.id ? `${p.color}44` : 'rgba(56,189,248,0.06)'}`,
                  fontWeight: activePreset === p.id ? 600 : 400,
                }}
              >
                <span>{p.icon}</span>
                <span>{p.label}</span>
                <span className="text-[9px] opacity-70">({p.description})</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Real-time preview */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-bold">👥 該当ユーザー</h4>
          <div className="flex items-center gap-3">
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>
                {loading ? '...' : filteredUsers.length}
              </span>
              名
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {totalFilteredCoins.toLocaleString()}tk
            </span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-3 py-4">
            <div className="animate-spin w-4 h-4 border-2 border-sky-400 border-t-transparent rounded-full" />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>集計中...</span>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="text-center py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
            条件に一致するユーザーがいません
          </div>
        ) : (
          <>
            {/* Top users list */}
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {filteredUsers.slice(0, 30).map((u, i) => (
                <div
                  key={u.user_name}
                  className="flex items-center justify-between py-1 px-2 rounded text-xs"
                  style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>
                    <span className="text-[10px] mr-2" style={{ color: 'var(--text-muted)' }}>{i + 1}.</span>
                    {u.user_name}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {u.tx_count > 0 && `${u.tx_count}回`}
                    </span>
                    <span style={{ color: 'var(--accent-primary)' }}>
                      {u.total_coins.toLocaleString()}tk
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {filteredUsers.length > 30 && (
              <div className="text-[10px] mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                他 {filteredUsers.length - 30}名（スクロールで確認可）
              </div>
            )}
          </>
        )}
      </div>

      {/* Message & Send */}
      {filteredUsers.length > 0 && (
        <div className="glass-card p-4 space-y-3">
          <h4 className="text-xs font-bold">📝 メッセージ設定</h4>

          <div>
            <label className="text-[10px] mb-1 block" style={{ color: 'var(--text-muted)' }}>
              メッセージ本文（{'{username}'} で名前置換）
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="input-glass w-full text-xs"
              rows={3}
              placeholder={DEFAULT_TEMPLATES[activePreset || 'regular']}
            />
          </div>

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

          <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid rgba(56,189,248,0.08)' }}>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="font-bold" style={{ color: 'var(--accent-primary)' }}>{filteredUsers.length}名</span> に送信予定
            </div>
            <button
              onClick={() => setShowPreview(true)}
              disabled={!message.trim()}
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
              <button onClick={() => setShowPreview(false)} className="text-slate-400 hover:text-white text-lg">
                ✕
              </button>
            </div>

            {/* Summary */}
            <div className="glass-panel p-3 mb-4">
              <div className="grid grid-cols-4 gap-3 text-center">
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-primary)' }}>{filteredUsers.length}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>送信対象</div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-purple)' }}>
                    {activePreset ? PRESETS.find((p) => p.id === activePreset)?.icon : '🔧'}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {activePreset || 'カスタム'}
                  </div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--accent-amber)' }}>
                    {totalFilteredCoins.toLocaleString()}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>合計tk</div>
                </div>
                <div>
                  <div className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{castName}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>キャスト</div>
                </div>
              </div>
            </div>

            {/* Filter summary */}
            <div className="glass-panel p-2 mb-4 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              期間: {dateRange.start} 〜 {dateRange.end} ／ コイン: {minCoins.toLocaleString()}〜{maxCoins.toLocaleString()}tk
            </div>

            {/* Message preview */}
            <div className="mb-4">
              <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                メッセージ例（{filteredUsers[0]?.user_name || 'sample_user'}宛）:
              </div>
              <div
                className="glass-panel p-3 text-xs"
                style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}
              >
                {message.replace(/\{username\}/g, filteredUsers[0]?.user_name || 'sample_user')}
              </div>
            </div>

            {/* User list */}
            <details>
              <summary className="text-[10px] cursor-pointer mb-1" style={{ color: 'var(--text-muted)' }}>
                対象ユーザー一覧 ({filteredUsers.length}名)
              </summary>
              <div className="flex flex-wrap gap-1 mt-1">
                {filteredUsers.slice(0, 100).map((u) => (
                  <span
                    key={u.user_name}
                    className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}
                  >
                    {u.user_name} ({u.total_coins}tk)
                  </span>
                ))}
                {filteredUsers.length > 100 && (
                  <span className="text-[9px] px-1.5 py-0.5" style={{ color: 'var(--text-muted)' }}>
                    ...他{filteredUsers.length - 100}名
                  </span>
                )}
              </div>
            </details>

            {/* Confirmation buttons */}
            <div className="flex items-center justify-between pt-4 mt-4" style={{ borderTop: '1px solid rgba(56,189,248,0.1)' }}>
              <button onClick={() => setShowPreview(false)} className="btn-ghost text-xs px-4 py-2">
                戻る
              </button>
              <button
                onClick={handleSend}
                disabled={sending}
                className="text-xs px-6 py-2 rounded-lg font-bold text-white transition-all"
                style={{
                  background: sending ? 'rgba(100,100,100,0.3)' : 'linear-gradient(135deg, #22c55e, #16a34a)',
                  opacity: sending ? 0.6 : 1,
                }}
              >
                {sending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                    送信中...
                  </span>
                ) : (
                  `✅ ${filteredUsers.length}名にDM送信を実行`
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
