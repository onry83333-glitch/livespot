'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { subscribeWithRetry } from '@/lib/realtime-helpers';
import { timeAgo } from '@/lib/utils';

// ---------- 型定義 ----------
interface EnterAlert {
  id: number;
  user_name: string;
  cast_name: string;
  message_time: string;
  // paid_usersからルックアップ
  total_coins: number;
  user_level: number;
  last_payment_date: string | null;
  // 分類
  vipLevel: 'critical' | 'warning' | 'normal';
}

interface UserDetail {
  user_name: string;
  total_coins: number;
  user_level: number;
  last_payment_date: string | null;
  created_at: string | null;
  lastDmAt: string | null;
}

interface TriggerSettings {
  criticalThreshold: number;
  warningThreshold: number;
  dormantDays: number;
}

const DEFAULT_TRIGGERS: TriggerSettings = { criticalThreshold: 1000, warningThreshold: 100, dormantDays: 30 };

function loadTriggers(): TriggerSettings {
  if (typeof window === 'undefined') return DEFAULT_TRIGGERS;
  try {
    const saved = localStorage.getItem('strip_live_spot_alert_triggers');
    return saved ? { ...DEFAULT_TRIGGERS, ...JSON.parse(saved) } : DEFAULT_TRIGGERS;
  } catch { return DEFAULT_TRIGGERS; }
}

function saveTriggers(t: TriggerSettings) {
  localStorage.setItem('strip_live_spot_alert_triggers', JSON.stringify(t));
}

function classifyVip(totalCoins: number, triggers: TriggerSettings): 'critical' | 'warning' | 'normal' {
  if (totalCoins > triggers.criticalThreshold) return 'critical';
  if (totalCoins > triggers.warningThreshold) return 'warning';
  return 'normal';
}

// ---------- コンポーネント ----------
export default function AlertsPage() {
  const { user } = useAuth();
  const sbRef = useRef(createClient());
  const sb = sbRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<EnterAlert[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserDetail | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [triggers, setTriggers] = useState<TriggerSettings>(DEFAULT_TRIGGERS);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);

  // 統計
  const vipCount = alerts.filter(a => a.vipLevel !== 'normal').length;
  const todayVipCoins = alerts.filter(a => a.vipLevel !== 'normal').reduce((sum, a) => sum + a.total_coins, 0);

  // 初期化: triggers + account取得
  useEffect(() => {
    setTriggers(loadTriggers());
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await sb.from('accounts').select('id').limit(1).single();
      if (data) setAccountId(data.id);
    })();
  }, [user, sb]);

  // paid_usersルックアップ
  const lookupUser = useCallback(async (userName: string): Promise<{ total_coins: number; user_level: number; last_payment_date: string | null }> => {
    if (!accountId) return { total_coins: 0, user_level: 0, last_payment_date: null };
    const { data } = await sb
      .from('paid_users')
      .select('total_coins, user_level, last_payment_date')
      .eq('account_id', accountId)
      .eq('user_name', userName)
      .maybeSingle();
    return data || { total_coins: 0, user_level: 0, last_payment_date: null };
  }, [sb, accountId]);

  // 初回ロード: 直近の enter イベント50件
  const loadInitial = useCallback(async () => {
    if (!accountId) return;
    const { data } = await sb
      .from('spy_messages')
      .select('id, user_name, cast_name, message_time')
      .eq('account_id', accountId)
      .eq('msg_type', 'enter')
      .order('message_time', { ascending: false })
      .limit(50);

    if (!data || data.length === 0) { setAlerts([]); return; }

    const currentTriggers = loadTriggers();
    const enriched = await Promise.all(
      data.map(async (row) => {
        const info = await lookupUser(row.user_name || '');
        return {
          id: row.id,
          user_name: row.user_name || '匿名',
          cast_name: row.cast_name,
          message_time: row.message_time,
          total_coins: info.total_coins,
          user_level: info.user_level,
          last_payment_date: info.last_payment_date,
          vipLevel: classifyVip(info.total_coins, currentTriggers),
        } as EnterAlert;
      })
    );
    setAlerts(enriched);
  }, [sb, accountId, lookupUser]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  // Realtime: spy_messages INSERT (msg_type=enter)
  const triggersRef = useRef(triggers);
  triggersRef.current = triggers;
  const lookupUserRef = useRef(lookupUser);
  lookupUserRef.current = lookupUser;
  const alertChannelRef = useRef<ReturnType<typeof sb.channel> | null>(null);

  useEffect(() => {
    if (!accountId) return;

    // 重複subscribe防止
    if (alertChannelRef.current) {
      sb.removeChannel(alertChannelRef.current);
      alertChannelRef.current = null;
    }

    const channel = sb
      .channel(`alerts-enter-${accountId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'spy_messages', filter: `account_id=eq.${accountId}` },
        async (payload) => {
          const row = payload.new as { id: number; account_id: string; msg_type: string; user_name: string; cast_name: string; message_time: string };
          if (row.msg_type !== 'enter') return;

          const info = await lookupUserRef.current(row.user_name || '');
          const alert: EnterAlert = {
            id: row.id,
            user_name: row.user_name || '匿名',
            cast_name: row.cast_name,
            message_time: row.message_time,
            total_coins: info.total_coins,
            user_level: info.user_level,
            last_payment_date: info.last_payment_date,
            vipLevel: classifyVip(info.total_coins, triggersRef.current),
          };
          setAlerts(prev => [alert, ...prev].slice(0, 100));
        }
      )
    subscribeWithRetry(channel);

    alertChannelRef.current = channel;

    return () => {
      if (alertChannelRef.current) {
        sb.removeChannel(alertChannelRef.current);
        alertChannelRef.current = null;
      }
    };
  }, [accountId]); // sb はシングルトン、lookupUser/triggersはRefで参照

  // ユーザー詳細を取得
  const handleSelectUser = useCallback(async (userName: string) => {
    setSelectedName(userName);
    if (!accountId) return;

    const [paidRes, dmRes] = await Promise.all([
      sb.from('paid_users')
        .select('user_name, total_coins, user_level, last_payment_date, created_at')
        .eq('account_id', accountId)
        .eq('user_name', userName)
        .maybeSingle(),
      sb.from('dm_send_log')
        .select('queued_at')
        .eq('account_id', accountId)
        .eq('user_name', userName)
        .order('queued_at', { ascending: false })
        .limit(1),
    ]);

    const paid = paidRes.data;
    setSelectedUser({
      user_name: userName,
      total_coins: paid?.total_coins ?? 0,
      user_level: paid?.user_level ?? 0,
      last_payment_date: paid?.last_payment_date ?? null,
      created_at: paid?.created_at ?? null,
      lastDmAt: dmRes.data?.[0]?.queued_at ?? null,
    });
  }, [sb, accountId]);

  // トリガー設定の保存
  const updateTrigger = (key: keyof TriggerSettings, value: number) => {
    const next = { ...triggers, [key]: value };
    setTriggers(next);
    saveTriggers(next);
    // 既存アラートの分類を再計算
    setAlerts(prev => prev.map(a => ({ ...a, vipLevel: classifyVip(a.total_coins, next) })));
  };

  // デモデータ挿入
  const handleInsertDemo = async () => {
    if (!accountId) return;
    setDemoLoading(true);
    setDemoError(null);
    try {
      const now = new Date();
      const names = ['Kenji_Diamond', 'Mister_X', 'S_Hiroshi', 'Take_San', 'Lucky_Star'];
      const rows = names.map((name, i) => ({
        account_id: accountId,
        cast_name: 'サクラ',
        message_time: new Date(now.getTime() - i * 30000).toISOString(),
        msg_type: 'enter',
        user_name: name,
        message: null,
        tokens: 0,
        is_vip: false,
        metadata: {},
      }));
      const { error } = await sb.from('spy_messages').insert(rows);
      if (error) throw new Error(error.message);
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : String(e));
    }
    setDemoLoading(false);
  };

  if (!user) return null;

  return (
    <div className="h-[calc(100vh-48px)] flex gap-5">
      {/* ========== Left: 統計 + トリガー設定 ========== */}
      <div className="w-56 flex-shrink-0 space-y-4">
        <div className="glass-card p-5">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>現在のオンラインVIP</p>
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-4xl font-bold text-sky-400">{vipCount}</p>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>/ {alerts.length}名</span>
          </div>
        </div>

        <div className="glass-card p-5">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>VIP累計コイン</p>
          <div className="flex items-baseline gap-1 mt-1">
            <p className="text-3xl font-bold text-emerald-400">{todayVipCoins.toLocaleString()}</p>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>c</span>
          </div>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-bold mb-4 flex items-center gap-2">🔧 アラートトリガー設定</h3>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium">CRITICAL閾値</p>
                <span className="text-xs text-rose-400">{triggers.criticalThreshold.toLocaleString()}c</span>
              </div>
              <input type="range" min="500" max="10000" step="100"
                value={triggers.criticalThreshold}
                onChange={e => updateTrigger('criticalThreshold', Number(e.target.value))}
                className="w-full accent-rose-500" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium">WARNING閾値</p>
                <span className="text-xs text-amber-400">{triggers.warningThreshold.toLocaleString()}c</span>
              </div>
              <input type="range" min="10" max="1000" step="10"
                value={triggers.warningThreshold}
                onChange={e => updateTrigger('warningThreshold', Number(e.target.value))}
                className="w-full accent-amber-500" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium">休眠判定(日)</p>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{triggers.dormantDays}日</span>
              </div>
              <input type="range" min="7" max="90" step="1"
                value={triggers.dormantDays}
                onChange={e => updateTrigger('dormantDays', Number(e.target.value))}
                className="w-full accent-sky-500" />
            </div>
          </div>
        </div>

        {/* デモ挿入 */}
        <button onClick={handleInsertDemo} disabled={demoLoading || !accountId}
          className="btn-ghost w-full text-[11px] py-2 disabled:opacity-50">
          {demoLoading ? '挿入中...' : '🧪 デモ入室データ挿入'}
        </button>
        {demoError && <p className="text-[10px] px-2" style={{ color: 'var(--accent-pink)' }}>{demoError}</p>}
      </div>

      {/* ========== Center: アラートリスト ========== */}
      <div className="flex-1 glass-card p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">🚨 入室アラート（リアルタイム）</h2>
          <span className="text-[10px] px-2 py-1 rounded-lg"
            style={{ background: 'rgba(56,189,248,0.08)', color: 'var(--accent-primary)' }}>
            {alerts.length} 件
          </span>
        </div>

        <div className="flex-1 overflow-auto space-y-3">
          {alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>入室イベントがありません</p>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>「デモ入室データ挿入」でテストできます</p>
            </div>
          ) : (
            alerts.map(a => {
              const isSelected = selectedName === a.user_name;
              return (
                <div key={a.id}
                  onClick={() => handleSelectUser(a.user_name)}
                  className={`p-4 rounded-xl transition-all duration-200 cursor-pointer ${
                    isSelected ? 'border-2' : 'glass-panel hover:bg-white/[0.03]'
                  }`}
                  style={isSelected ? {
                    background: 'rgba(244,63,94,0.06)',
                    borderColor: 'rgba(244,63,94,0.3)',
                    boxShadow: '0 0 20px rgba(244,63,94,0.1)',
                  } : {}}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                      style={{ background: 'rgba(15,23,42,0.8)' }}>
                      {a.vipLevel === 'critical' ? '💎' : a.vipLevel === 'warning' ? '⭐' : '👤'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{a.user_name}</span>
                        {a.user_level > 0 && (
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Lv.{a.user_level}</span>
                        )}
                        {a.vipLevel === 'critical' && <span className="badge-critical text-[9px]">CRITICAL</span>}
                        {a.vipLevel === 'warning' && <span className="badge-warning text-[9px]">WARNING</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-amber-400">💰 {a.total_coins.toLocaleString()}c</span>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>📍 {a.cast_name}</span>
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>⏱ {timeAgo(a.message_time)}</span>
                      </div>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button className="px-3 py-2 rounded-lg text-xs font-medium text-white"
                        style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)' }}>
                        レディを割り当てる
                      </button>
                      <Link href={`/dm?target=${encodeURIComponent(a.user_name)}`} className="btn-ghost text-xs py-2">
                        💬 DM
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ========== Right: ユーザー詳細 ========== */}
      <div className="w-72 flex-shrink-0 glass-card p-5 flex flex-col">
        {selectedUser ? (
          <>
            <div className="text-center mb-5">
              <div className="w-20 h-20 rounded-full mx-auto mb-3 flex items-center justify-center text-4xl"
                style={{
                  background: selectedUser.total_coins > triggers.criticalThreshold
                    ? 'linear-gradient(135deg, rgba(244,63,94,0.2), rgba(168,85,247,0.2))'
                    : 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(168,85,247,0.15))',
                  border: selectedUser.total_coins > triggers.criticalThreshold
                    ? '2px solid rgba(244,63,94,0.3)' : '2px solid rgba(56,189,248,0.2)',
                }}>
                {selectedUser.total_coins > triggers.criticalThreshold ? '💎' : selectedUser.total_coins > triggers.warningThreshold ? '⭐' : '👤'}
              </div>
              <h3 className="text-lg font-bold">{selectedUser.user_name}</h3>
              {selectedUser.total_coins > triggers.criticalThreshold && (
                <span className="badge-critical text-[10px]">WHALE</span>
              )}
              {selectedUser.total_coins > triggers.warningThreshold && selectedUser.total_coins <= triggers.criticalThreshold && (
                <span className="badge-warning text-[10px]">VIP</span>
              )}
            </div>

            <div className="space-y-3 flex-1">
              <div className="grid grid-cols-2 gap-3">
                <div className="glass-panel p-3 rounded-lg">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>累計コイン</p>
                  <p className="text-sm font-bold text-amber-400">{selectedUser.total_coins.toLocaleString()}c</p>
                </div>
                <div className="glass-panel p-3 rounded-lg">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ユーザーLv</p>
                  <p className="text-sm font-bold">{selectedUser.user_level}</p>
                </div>
              </div>

              <div className="glass-panel p-3 rounded-lg">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>最終課金日</p>
                <p className="text-sm font-bold" style={{ color: selectedUser.last_payment_date ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                  {selectedUser.last_payment_date
                    ? new Date(selectedUser.last_payment_date).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })
                    : '課金履歴なし'}
                </p>
              </div>

              <div className="glass-panel p-3 rounded-lg">
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>最終DM送信</p>
                <p className="text-sm font-bold" style={{ color: selectedUser.lastDmAt ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                  {selectedUser.lastDmAt ? timeAgo(selectedUser.lastDmAt) : 'DM未送信'}
                </p>
              </div>

              {selectedUser.created_at && (
                <div className="glass-panel p-3 rounded-lg">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>初回登録日</p>
                  <p className="text-sm font-bold">
                    {new Date(selectedUser.created_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                  </p>
                </div>
              )}
            </div>

            <Link href={`/dm?target=${encodeURIComponent(selectedUser.user_name)}`}
              className="mt-4 w-full py-3 rounded-xl font-semibold text-sm text-white text-center block"
              style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)', boxShadow: '0 4px 20px rgba(244,63,94,0.3)' }}>
              💬 ダイレクトメッセージ
            </Link>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="text-4xl opacity-30">👤</div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>ユーザーを選択</p>
            <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              アラートリストからユーザーを<br />クリックすると詳細を表示
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
