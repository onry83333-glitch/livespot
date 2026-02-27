'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { COIN_RATE } from '@/lib/utils';

interface Account {
  id: string;
  account_name: string;
}

interface AccountSettings {
  id: string;
  account_name: string;
  cast_usernames: string[];
  coin_rate: number;
}

export default function SettingsPage() {
  const { user } = useAuth();
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [tab, setTab] = useState<'account' | 'security' | 'cost' | 'triggers'>('account');

  // === Account settings ===
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [castInput, setCastInput] = useState('');
  const [coinRate, setCoinRate] = useState(COIN_RATE);
  const [loading, setLoading] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // === Cost settings ===
  interface CostSetting {
    id?: string;
    cast_name: string;
    hourly_rate: number;
    monthly_fixed_cost: number;
    platform_fee_rate: number;
    token_to_jpy: number;
    token_to_usd: number;
    revenue_share_rate: number;
    bonus_rate: number;
    effective_from: string;
  }
  const [costSettings, setCostSettings] = useState<CostSetting[]>([]);
  const [costLoading, setCostLoading] = useState(false);
  const [costSaveMsg, setCostSaveMsg] = useState<string | null>(null);
  const [costSaveError, setCostSaveError] = useState<string | null>(null);
  const [registeredCasts, setRegisteredCasts] = useState<string[]>([]);

  // === DM Triggers ===
  interface TriggerRow {
    id: string;
    trigger_name: string;
    trigger_type: string;
    is_active: boolean;
    conditions: Record<string, unknown>;
    dm_template_id: string | null;
    dm_content_template: string | null;
    cooldown_hours: number;
    daily_limit: number;
    target_segment: string | null;
    updated_at: string;
  }
  interface TriggerLogRow {
    id: number;
    trigger_id: string;
    cast_name: string;
    username: string;
    status: string;
    triggered_at: string;
    reason: string | null;
  }
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [triggerLogs, setTriggerLogs] = useState<TriggerLogRow[]>([]);
  const [triggersLoading, setTriggersLoading] = useState(false);
  const [triggerSubTab, setTriggerSubTab] = useState<'list' | 'logs'>('list');
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);
  const [triggerSaveMsg, setTriggerSaveMsg] = useState<string | null>(null);

  // === Chrome Extension Status ===
  const [extensionStatus, setExtensionStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');

  // === Stripchat Session Status ===
  const [scSession, setScSession] = useState<{
    is_valid: boolean;
    exported_at: string;
    stripchat_user_id: string | null;
    last_validated_at: string;
    csrf_token: string | null;
  } | null>(null);
  const [scSessionLoading, setScSessionLoading] = useState(true);

  useEffect(() => {
    const check = async () => {
      const { data } = await sb.from('spy_messages')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        const lastTime = new Date(data[0].created_at);
        const minutesAgo = (Date.now() - lastTime.getTime()) / 60000;
        setExtensionStatus(minutesAgo < 30 ? 'connected' : 'disconnected');
      } else {
        setExtensionStatus('disconnected');
      }
    };
    check();
  }, [sb]);

  // === Stripchat Session fetch ===
  useEffect(() => {
    if (!selectedAccount) return;
    setScSessionLoading(true);
    sb.from('stripchat_sessions')
      .select('is_valid, exported_at, stripchat_user_id, last_validated_at, csrf_token')
      .eq('account_id', selectedAccount)
      .maybeSingle()
      .then(({ data }) => {
        setScSession(data);
        setScSessionLoading(false);
      });
  }, [selectedAccount, sb]);

  // === Security (existing mock) ===
  const [banProtection, setBanProtection] = useState(true);
  const [burstMode, setBurstMode] = useState(false);
  const [sensitivity, setSensitivity] = useState(3);
  const [rateLimit, setRateLimit] = useState(45);
  const [sessionLimit, setSessionLimit] = useState(5);

  const securityLogs = [
    { time: '10:45:22', event: '異常なログイン試行', ip: '192.168.1.195', status: 'BLOCKED' },
    { time: '10:32:15', event: 'レート制限超過', ip: '10.0.0.42', status: 'WARNING' },
    { time: '10:15:03', event: '正常アクセス', ip: '172.16.0.1', status: 'OK' },
  ];

  // Load accounts
  useEffect(() => {
    if (!user) return;
    sb.from('accounts').select('id, account_name').order('created_at').then(({ data }) => {
      const list = data || [];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0].id);
    });
  }, [user, sb]);

  // Load account settings
  const loadSettings = useCallback(async () => {
    if (!selectedAccount) return;
    setLoading(true);
    try {
      const { data, error } = await sb
        .from('accounts')
        .select('id, account_name, cast_usernames, coin_rate')
        .eq('id', selectedAccount)
        .single();
      if (error) throw error;
      setSettings(data as AccountSettings);
      setCastInput(((data as AccountSettings).cast_usernames || []).join('\n'));
      setCoinRate((data as AccountSettings).coin_rate || 7.7);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [selectedAccount]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  // Load registered casts for cost tab
  useEffect(() => {
    if (!selectedAccount) return;
    sb.from('registered_casts')
      .select('cast_name')
      .eq('account_id', selectedAccount)
      .eq('is_active', true)
      .order('cast_name')
      .then(({ data }) => {
        setRegisteredCasts((data || []).map((d: { cast_name: string }) => d.cast_name));
      });
  }, [selectedAccount, sb]);

  // Load cost settings
  const loadCostSettings = useCallback(async () => {
    if (!selectedAccount) return;
    setCostLoading(true);
    try {
      const { data, error } = await sb
        .from('cast_cost_settings')
        .select('id, cast_name, hourly_rate, monthly_fixed_cost, platform_fee_rate, token_to_jpy, token_to_usd, revenue_share_rate, bonus_rate, effective_from')
        .eq('account_id', selectedAccount)
        .is('effective_to', null)
        .order('cast_name')
        .limit(100);
      if (error) throw error;
      setCostSettings((data || []) as CostSetting[]);
    } catch {
      // ignore
    }
    setCostLoading(false);
  }, [selectedAccount, sb]);

  useEffect(() => {
    if (tab === 'cost') loadCostSettings();
  }, [tab, loadCostSettings]);

  // Load triggers
  const loadTriggers = useCallback(async () => {
    if (!selectedAccount) return;
    setTriggersLoading(true);
    try {
      const { data } = await sb
        .from('dm_triggers')
        .select('id, trigger_name, trigger_type, is_active, conditions, dm_template_id, dm_content_template, cooldown_hours, daily_limit, target_segment, updated_at')
        .eq('account_id', selectedAccount)
        .order('priority')
        .limit(100);
      setTriggers((data || []) as TriggerRow[]);
    } catch { /* ignore */ }
    setTriggersLoading(false);
  }, [selectedAccount, sb]);

  const loadTriggerLogs = useCallback(async () => {
    if (!selectedAccount) return;
    const { data } = await sb
      .from('dm_trigger_logs')
      .select('id, trigger_id, cast_name, username, status, triggered_at, reason')
      .eq('account_id', selectedAccount)
      .order('triggered_at', { ascending: false })
      .limit(100);
    setTriggerLogs((data || []) as TriggerLogRow[]);
  }, [selectedAccount, sb]);

  useEffect(() => {
    if (tab === 'triggers') {
      loadTriggers();
      loadTriggerLogs();
    }
  }, [tab, loadTriggers, loadTriggerLogs]);

  // Save cost settings
  const handleSaveCost = async (setting: CostSetting) => {
    setCostSaveMsg(null);
    setCostSaveError(null);
    try {
      const payload = {
        account_id: selectedAccount,
        cast_name: setting.cast_name,
        hourly_rate: setting.hourly_rate,
        monthly_fixed_cost: setting.monthly_fixed_cost,
        platform_fee_rate: setting.platform_fee_rate,
        token_to_jpy: setting.token_to_jpy,
        token_to_usd: setting.token_to_usd,
        revenue_share_rate: setting.revenue_share_rate,
        bonus_rate: setting.bonus_rate,
        effective_from: setting.effective_from || new Date().toISOString().slice(0, 10),
      };
      if (setting.id) {
        const { error } = await sb.from('cast_cost_settings').update(payload).eq('id', setting.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from('cast_cost_settings').insert(payload);
        if (error) throw error;
      }
      setCostSaveMsg('保存しました');
      setTimeout(() => setCostSaveMsg(null), 3000);
      await loadCostSettings();
    } catch (e: unknown) {
      setCostSaveError(e instanceof Error ? e.message : '保存に失敗しました');
    }
  };

  // Add new cost setting for a cast
  const addCostSetting = (castName: string) => {
    setCostSettings(prev => [
      ...prev,
      {
        cast_name: castName,
        hourly_rate: 0,
        monthly_fixed_cost: 0,
        platform_fee_rate: 40.0,
        token_to_jpy: 5.5,
        token_to_usd: 0.05,
        revenue_share_rate: 50.0,
        bonus_rate: 0,
        effective_from: new Date().toISOString().slice(0, 10),
      },
    ]);
  };

  // Save settings
  const handleSave = async () => {
    setSaveMsg(null);
    setSaveError(null);
    try {
      const castUsernames = castInput
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const { error } = await sb
        .from('accounts')
        .update({ cast_usernames: castUsernames, coin_rate: coinRate })
        .eq('id', selectedAccount);
      if (error) throw error;
      setSaveMsg('設定を保存しました');
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : '保存に失敗しました');
    }
  };

  if (!user) return null;

  return (
    <div className="max-w-[1200px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            アカウント設定・セキュリティ管理
          </p>
        </div>
      </div>

      {/* Chrome Extension Status */}
      <div className="glass-card p-3 flex items-center gap-3">
        <span className={`w-2.5 h-2.5 rounded-full ${
          extensionStatus === 'connected' ? 'bg-emerald-500 anim-live' :
          extensionStatus === 'disconnected' ? 'bg-rose-500' :
          'bg-slate-500 animate-pulse'
        }`} />
        <div>
          <p className="text-xs font-medium">
            Chrome拡張: {extensionStatus === 'connected' ? '接続中' : extensionStatus === 'disconnected' ? '未接続' : '確認中...'}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {extensionStatus === 'connected'
              ? 'SPYデータを受信中'
              : extensionStatus === 'disconnected'
                ? 'データ受信なし — Chrome拡張が稼働中か確認してください'
                : '接続状態を確認しています...'}
          </p>
        </div>
      </div>

      {/* Stripchat DM API セッション */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
          Stripchat セッション
          {!scSessionLoading && (
            <span className={`w-2 h-2 rounded-full ${
              scSession?.is_valid ? 'bg-emerald-500 anim-live' : 'bg-rose-500'
            }`} />
          )}
        </h3>
        {scSessionLoading ? (
          <div className="h-8 rounded animate-pulse" style={{ background: 'var(--bg-card)' }} />
        ) : scSession ? (
          <div className="space-y-2 text-[11px]">
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>ステータス</span>
              <span style={{ color: scSession.is_valid ? 'var(--accent-green)' : 'var(--accent-pink)' }}>
                {scSession.is_valid ? 'API送信可能' : 'セッション無効'}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>Stripchat ID</span>
              <span>{scSession.stripchat_user_id || '未設定'}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>CSRF</span>
              <span style={{ color: scSession.csrf_token ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                {scSession.csrf_token ? '取得済み' : '未取得'}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>最終同期</span>
              <span>
                {new Date(scSession.exported_at).toLocaleString('ja-JP', {
                  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })}
              </span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: 'var(--text-muted)' }}>最終検証</span>
              <span>
                {new Date(scSession.last_validated_at).toLocaleString('ja-JP', {
                  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                })}
              </span>
            </div>
            <p className="text-[10px] mt-2 pt-2" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-glass)' }}>
              Chrome拡張が1時間ごとにセッションを自動同期します
            </p>
          </div>
        ) : (
          <div className="text-[11px] space-y-2">
            <p style={{ color: 'var(--text-muted)' }}>
              セッション未登録。Chrome拡張を開いてStripchatにログインしてください。
            </p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              ログイン後、拡張が自動でセッションを同期します。
            </p>
          </div>
        )}
      </div>

      {/* Tab Switch */}
      <div className="flex gap-1">
        {([
          { key: 'account' as const, label: 'アカウント設定' },
          { key: 'cost' as const, label: 'コスト設定' },
          { key: 'triggers' as const, label: 'DMトリガー' },
          { key: 'security' as const, label: 'セキュリティ' },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-all ${
              tab === t.key ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
            }`}>
            {t.label}
          </button>
        ))}
        <Link href="/settings/casts"
          className="px-5 py-2.5 rounded-lg text-xs font-medium transition-all text-slate-400 hover:text-slate-200">
          SPYキャスト管理
        </Link>
      </div>

      {/* ============ Account Settings Tab ============ */}
      {tab === 'account' && (
        <div className="space-y-6 anim-fade-up">
          {/* Account Selector */}
          {accounts.length > 0 && (
            <div className="glass-card p-5">
              <label className="text-xs block mb-2" style={{ color: 'var(--text-muted)' }}>アカウント選択</label>
              <select className="input-glass text-sm w-full max-w-sm"
                value={selectedAccount}
                onChange={e => setSelectedAccount(e.target.value)}>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
              </select>
            </div>
          )}

          {loading && <div className="glass-card p-10 animate-pulse h-40" />}

          {!loading && settings && (
            <>
              {/* Cast Exclusion */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-1">キャスト除外設定</h3>
                <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>
                  ここに登録したユーザー名はSPYログの統計・ランキングから除外されます（キャスト本人のチャットを集計に含めない）。
                </p>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>
                  キャストユーザー名（1行1名）
                </label>
                <textarea
                  className="input-glass font-mono text-xs h-28 resize-none"
                  value={castInput}
                  onChange={e => setCastInput(e.target.value)}
                  placeholder="sakura_official&#10;miki_live&#10;cast_name_123"
                />
                <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                  現在 {castInput.split('\n').filter(s => s.trim()).length} 名登録
                </p>
              </div>

              {/* Coin Rate */}
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-1">コイン換算レート</h3>
                <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>
                  1トークンあたりの日本円換算レート。ダッシュボード・分析の円表示に使用されます。
                </p>
                <div className="flex items-center gap-4">
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>1 tk = ¥</label>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      className="input-glass text-sm w-32"
                      value={coinRate}
                      onChange={e => setCoinRate(parseFloat(e.target.value) || 7.7)}
                    />
                  </div>
                  <div className="glass-panel p-3 rounded-xl flex-1">
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>換算例</p>
                    <div className="flex items-center gap-6 mt-1">
                      <span className="text-xs">100 tk = <strong className="text-emerald-400">{'\u00A5'}{Math.round(100 * coinRate).toLocaleString()}</strong></span>
                      <span className="text-xs">1,000 tk = <strong className="text-emerald-400">{'\u00A5'}{Math.round(1000 * coinRate).toLocaleString()}</strong></span>
                      <span className="text-xs">10,000 tk = <strong className="text-emerald-400">{'\u00A5'}{Math.round(10000 * coinRate).toLocaleString()}</strong></span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Save */}
              <div className="flex items-center gap-4">
                <button onClick={handleSave} className="btn-primary text-xs px-8 py-3">設定を保存</button>
                {saveMsg && <span className="text-xs text-emerald-400">{saveMsg}</span>}
                {saveError && <span className="text-xs text-rose-400">{saveError}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {/* ============ Cost Settings Tab ============ */}
      {tab === 'cost' && (
        <div className="space-y-6 anim-fade-up">
          {/* Account Selector */}
          {accounts.length > 0 && (
            <div className="glass-card p-5">
              <label className="text-xs block mb-2" style={{ color: 'var(--text-muted)' }}>アカウント選択</label>
              <select className="input-glass text-sm w-full max-w-sm"
                value={selectedAccount}
                onChange={e => setSelectedAccount(e.target.value)}>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
              </select>
            </div>
          )}

          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-bold">キャスト別コスト設定</h3>
              {costSaveMsg && <span className="text-xs text-emerald-400">{costSaveMsg}</span>}
              {costSaveError && <span className="text-xs text-rose-400">{costSaveError}</span>}
            </div>
            <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>
              セッションP/L・月次P/L計算に使用されます。キャストごとに時給・手数料率・トークン換算レートを設定してください。
            </p>

            {costLoading && <div className="h-40 animate-pulse rounded" style={{ background: 'var(--bg-card)' }} />}

            {!costLoading && costSettings.length === 0 && (
              <div className="text-center py-8 rounded-xl" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)' }}>
                <p className="text-sm mb-1" style={{ color: 'var(--accent-amber)' }}>コスト未設定</p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  下のボタンからキャストを追加してください
                </p>
              </div>
            )}

            {!costLoading && costSettings.map((cs, idx) => (
              <div key={cs.id || `new-${idx}`} className="glass-panel p-4 rounded-xl mb-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-bold" style={{ color: 'var(--accent-primary)' }}>{cs.cast_name}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    適用開始: {cs.effective_from}
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-3">
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>時給（円）</label>
                    <input type="number" min="0" step="100" className="input-glass text-sm w-full"
                      value={cs.hourly_rate}
                      onChange={e => {
                        const v = parseInt(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, hourly_rate: v } : c));
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>月額固定費（円）</label>
                    <input type="number" min="0" step="1000" className="input-glass text-sm w-full"
                      value={cs.monthly_fixed_cost}
                      onChange={e => {
                        const v = parseInt(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, monthly_fixed_cost: v } : c));
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>手数料率（%）</label>
                    <input type="number" min="0" max="100" step="0.1" className="input-glass text-sm w-full"
                      value={cs.platform_fee_rate}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, platform_fee_rate: v } : c));
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>1tk = 円</label>
                    <input type="number" min="0" step="0.1" className="input-glass text-sm w-full"
                      value={cs.token_to_jpy}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, token_to_jpy: v } : c));
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--accent-primary)' }}>分配率（%）</label>
                    <input type="number" min="0" max="100" step="0.1" className="input-glass text-sm w-full"
                      value={cs.revenue_share_rate}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, revenue_share_rate: v } : c));
                      }}
                    />
                    <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>ネット売上のうちキャストへ支払う割合</p>
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--accent-primary)' }}>1tk = USD</label>
                    <input type="number" min="0" step="0.001" className="input-glass text-sm w-full"
                      value={cs.token_to_usd}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, token_to_usd: v } : c));
                      }}
                    />
                    <p className="text-[9px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Stripchat標準: $0.05</p>
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>ボーナス率（%）</label>
                    <input type="number" min="0" max="100" step="0.1" className="input-glass text-sm w-full"
                      value={cs.bonus_rate}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, bonus_rate: v } : c));
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>適用開始日</label>
                    <input type="date" className="input-glass text-sm w-full"
                      value={cs.effective_from}
                      onChange={e => {
                        setCostSettings(prev => prev.map((c, i) => i === idx ? { ...c, effective_from: e.target.value } : c));
                      }}
                    />
                  </div>
                </div>
                <button onClick={() => handleSaveCost(cs)} className="btn-primary text-xs px-6 py-2">保存</button>
              </div>
            ))}

            {/* Add cast dropdown */}
            {!costLoading && (() => {
              const existingCasts = new Set(costSettings.map(c => c.cast_name));
              const available = registeredCasts.filter(c => !existingCasts.has(c));
              if (available.length === 0 && registeredCasts.length === 0) {
                return (
                  <p className="text-[10px] mt-3" style={{ color: 'var(--text-muted)' }}>
                    登録キャストがありません。先にキャスト一覧で登録してください。
                  </p>
                );
              }
              if (available.length === 0) return null;
              return (
                <div className="mt-4 flex items-center gap-3">
                  <select id="add-cost-cast" className="input-glass text-xs px-3 py-2 w-48">
                    {available.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button
                    onClick={() => {
                      const el = document.getElementById('add-cost-cast') as HTMLSelectElement;
                      if (el?.value) addCostSetting(el.value);
                    }}
                    className="btn-ghost text-xs px-4 py-2"
                  >
                    + キャスト追加
                  </button>
                </div>
              );
            })()}
          </div>

          {/* Summary / Explanation */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-2">計算式</h3>
            <div className="space-y-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>セッション/月次 P/L（円ベース）</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>粗売上</strong> = トークン数 × トークン円換算レート</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>手数料</strong> = 粗売上 × 手数料率</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>ネット売上</strong> = 粗売上 − 手数料</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>キャスト費用</strong> = 配信時間(h) × 時給</p>
              <p><strong style={{ color: 'var(--accent-green)' }}>粗利</strong> = ネット売上 − キャスト費用</p>
              <p className="text-[10px] font-semibold mt-3 mb-1" style={{ color: 'var(--accent-primary)' }}>レベニューシェア（USDベース）</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>グロス</strong> = トークン数 × 1tk=USD</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>PF手数料</strong> = グロス × 手数料率</p>
              <p><strong style={{ color: 'var(--text-primary)' }}>ネット</strong> = グロス − PF手数料</p>
              <p><strong style={{ color: 'var(--accent-primary)' }}>キャスト支払い</strong> = ネット × 分配率</p>
            </div>
          </div>
        </div>
      )}

      {/* ============ DM Triggers Tab ============ */}
      {tab === 'triggers' && (
        <div className="space-y-6 anim-fade-up">
          {/* Sub-tabs */}
          <div className="flex gap-2">
            <button onClick={() => setTriggerSubTab('list')}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                triggerSubTab === 'list' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
              }`}>
              トリガー一覧
            </button>
            <button onClick={() => { setTriggerSubTab('logs'); loadTriggerLogs(); }}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                triggerSubTab === 'logs' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
              }`}>
              発火ログ
            </button>
          </div>

          {triggerSaveMsg && (
            <div className="text-xs text-emerald-400 glass-card p-2">{triggerSaveMsg}</div>
          )}

          {/* Trigger List */}
          {triggerSubTab === 'list' && (
            <div className="space-y-3">
              {triggersLoading && <div className="glass-card p-10 animate-pulse h-40" />}

              {!triggersLoading && triggers.length === 0 && (
                <div className="glass-card p-8 text-center">
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>トリガーが設定されていません</p>
                  <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    Migration 064 を適用してデフォルトトリガーを作成してください
                  </p>
                </div>
              )}

              {!triggersLoading && triggers.map((tr) => {
                const isEditing = editingTriggerId === tr.id;
                const typeLabels: Record<string, string> = {
                  first_visit: '初来訪',
                  vip_no_tip: 'VIPフォロー',
                  churn_risk: '離脱リスク',
                  segment_upgrade: 'セグメント昇格',
                  competitor_outflow: '他社流入',
                  post_session: '配信後サンキュー',
                  cross_promotion: 'クロスプロモ',
                };
                const typeColors: Record<string, string> = {
                  first_visit: 'var(--accent-green)',
                  vip_no_tip: 'var(--accent-amber)',
                  churn_risk: 'var(--accent-pink)',
                  segment_upgrade: 'var(--accent-purple)',
                  competitor_outflow: 'var(--accent-primary)',
                  post_session: 'var(--accent-green)',
                  cross_promotion: 'var(--accent-amber)',
                };

                return (
                  <div key={tr.id} className="glass-card p-4">
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={async () => {
                            const { error } = await sb.from('dm_triggers').update({ is_active: !tr.is_active }).eq('id', tr.id);
                            if (!error) {
                              setTriggers(prev => prev.map(t => t.id === tr.id ? { ...t, is_active: !t.is_active } : t));
                            }
                          }}
                          className={`w-10 h-5 rounded-full relative transition-colors ${tr.is_active ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${tr.is_active ? 'right-0.5' : 'left-0.5'}`} />
                        </button>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{tr.trigger_name}</span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{
                              background: `${typeColors[tr.trigger_type] || 'var(--accent-primary)'}15`,
                              color: typeColors[tr.trigger_type] || 'var(--accent-primary)',
                            }}>
                              {typeLabels[tr.trigger_type] || tr.trigger_type}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                              background: !tr.dm_template_id ? 'rgba(56,189,248,0.1)' : 'rgba(167,139,250,0.1)',
                              color: !tr.dm_template_id ? 'var(--accent-primary)' : 'var(--accent-purple)',
                            }}>
                              {!tr.dm_template_id ? 'DM' : 'シナリオ'}
                            </span>
                          </div>
                          <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            CD: {tr.cooldown_hours}h / 上限: {tr.daily_limit}件/日
                            {(() => { try { const segs = JSON.parse(tr.target_segment || '[]'); return segs.length > 0 ? ` / 対象: ${segs.join(', ')}` : ''; } catch { return ''; } })()}
                            {tr.conditions?.cast_name ? ` / ${String(tr.conditions.cast_name)}` : null}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setEditingTriggerId(isEditing ? null : tr.id)}
                        className="text-[10px] px-3 py-1.5 rounded-lg transition-all hover:bg-white/5"
                        style={{ color: 'var(--accent-primary)' }}>
                        {isEditing ? '閉じる' : '編集'}
                      </button>
                    </div>

                    {/* Editing panel */}
                    {isEditing && (
                      <div className="mt-4 pt-4 space-y-4" style={{ borderTop: '1px solid var(--border-glass)' }}>
                        {/* Trigger name */}
                        <div>
                          <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>トリガー名</label>
                          <input type="text" className="input-glass text-sm w-full max-w-sm"
                            value={tr.trigger_name}
                            onChange={e => setTriggers(prev => prev.map(t => t.id === tr.id ? { ...t, trigger_name: e.target.value } : t))}
                          />
                        </div>

                        {/* Cooldown + Daily limit */}
                        <div className="grid grid-cols-2 gap-4 max-w-sm">
                          <div>
                            <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>クールダウン（時間）</label>
                            <input type="number" min="1" className="input-glass text-sm w-full"
                              value={tr.cooldown_hours}
                              onChange={e => setTriggers(prev => prev.map(t => t.id === tr.id ? { ...t, cooldown_hours: parseInt(e.target.value) || 24 } : t))}
                            />
                          </div>
                          <div>
                            <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>日次上限</label>
                            <input type="number" min="1" className="input-glass text-sm w-full"
                              value={tr.daily_limit}
                              onChange={e => setTriggers(prev => prev.map(t => t.id === tr.id ? { ...t, daily_limit: parseInt(e.target.value) || 10 } : t))}
                            />
                          </div>
                        </div>

                        {/* Target segments */}
                        <div>
                          <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>対象セグメント（空 = 全セグメント）</label>
                          <div className="flex flex-wrap gap-1.5">
                            {['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10'].map(seg => {
                              let currentSegs: string[] = [];
                              try { currentSegs = JSON.parse(tr.target_segment || '[]'); } catch { /* ignore */ }
                              const isActive = currentSegs.includes(seg);
                              return (
                                <button key={seg}
                                  onClick={() => {
                                    setTriggers(prev => prev.map(t => {
                                      if (t.id !== tr.id) return t;
                                      let segs: string[] = [];
                                      try { segs = JSON.parse(t.target_segment || '[]'); } catch { /* ignore */ }
                                      const newSegs = isActive
                                        ? segs.filter(s => s !== seg)
                                        : [...segs, seg];
                                      return { ...t, target_segment: JSON.stringify(newSegs) };
                                    }));
                                  }}
                                  className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                                    isActive ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-slate-800 text-slate-500 border border-slate-700'
                                  }`}>
                                  {seg}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Message template */}
                        {!tr.dm_template_id && (
                          <div>
                            <label className="text-[10px] block mb-1" style={{ color: 'var(--text-secondary)' }}>
                              メッセージテンプレート
                              <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                                変数: {'{username}'} {'{cast_name}'} {'{total_tokens}'} {'{session_tokens}'} {'{segment}'}
                              </span>
                            </label>
                            <textarea
                              className="input-glass text-xs h-24 resize-none font-mono"
                              value={tr.dm_content_template || ''}
                              onChange={e => setTriggers(prev => prev.map(t => t.id === tr.id ? { ...t, dm_content_template: e.target.value } : t))}
                            />
                            {tr.dm_content_template && (
                              <div className="mt-2 glass-panel p-3 rounded-lg">
                                <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>プレビュー:</p>
                                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                  {tr.dm_content_template
                                    .replace(/\{username\}/g, 'user123')
                                    .replace(/\{cast_name\}/g, 'Risa_06')
                                    .replace(/\{total_tokens\}/g, '5000')
                                    .replace(/\{session_tokens\}/g, '200')
                                    .replace(/\{segment\}/g, 'S4')
                                  }
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Save button */}
                        <div className="flex items-center gap-3">
                          <button
                            onClick={async () => {
                              const { error } = await sb.from('dm_triggers').update({
                                trigger_name: tr.trigger_name,
                                cooldown_hours: tr.cooldown_hours,
                                daily_limit: tr.daily_limit,
                                target_segment: tr.target_segment,
                                dm_content_template: tr.dm_content_template,
                              }).eq('id', tr.id);
                              if (!error) {
                                setTriggerSaveMsg('保存しました');
                                setTimeout(() => setTriggerSaveMsg(null), 3000);
                                setEditingTriggerId(null);
                              }
                            }}
                            className="btn-primary text-xs px-6 py-2">
                            保存
                          </button>
                          <button
                            onClick={() => setEditingTriggerId(null)}
                            className="btn-ghost text-xs px-4 py-2">
                            キャンセル
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Trigger Logs */}
          {triggerSubTab === 'logs' && (
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold">発火ログ（直近100件）</h3>
                <button onClick={loadTriggerLogs} className="text-[10px] px-3 py-1 rounded-lg hover:bg-white/5"
                  style={{ color: 'var(--accent-primary)' }}>
                  更新
                </button>
              </div>

              {triggerLogs.length === 0 ? (
                <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  まだ発火ログがありません
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ color: 'var(--text-muted)' }}>
                        <th className="text-left pb-2 font-medium">日時</th>
                        <th className="text-left pb-2 font-medium">ユーザー</th>
                        <th className="text-left pb-2 font-medium">キャスト</th>
                        <th className="text-left pb-2 font-medium">トリガー</th>
                        <th className="text-left pb-2 font-medium">結果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {triggerLogs.map(lg => {
                        const triggerDef = triggers.find(t => t.id === lg.trigger_id);
                        const actionColors: Record<string, string> = {
                          dm_queued: 'bg-emerald-500/10 text-emerald-400',
                          scenario_enrolled: 'bg-purple-500/10 text-purple-400',
                          skipped_cooldown: 'bg-slate-500/10 text-slate-400',
                          skipped_duplicate: 'bg-slate-500/10 text-slate-400',
                          skipped_segment: 'bg-slate-500/10 text-slate-400',
                          skipped_daily_limit: 'bg-amber-500/10 text-amber-400',
                          error: 'bg-rose-500/10 text-rose-400',
                        };
                        const actionLabels: Record<string, string> = {
                          dm_queued: 'DM予約',
                          scenario_enrolled: 'シナリオ登録',
                          skipped_cooldown: 'CDスキップ',
                          skipped_duplicate: '重複スキップ',
                          skipped_segment: 'セグメント外',
                          skipped_daily_limit: '上限到達',
                          error: 'エラー',
                        };
                        return (
                          <tr key={lg.id} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                            <td className="py-2 font-mono">
                              {lg.triggered_at ? new Date(lg.triggered_at).toLocaleString('ja-JP', {
                                month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                              }) : '-'}
                            </td>
                            <td className="py-2">{lg.username}</td>
                            <td className="py-2" style={{ color: 'var(--text-secondary)' }}>{lg.cast_name}</td>
                            <td className="py-2">{triggerDef?.trigger_name || lg.trigger_id.substring(0, 8)}</td>
                            <td className="py-2">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${actionColors[lg.status] || 'bg-slate-500/10 text-slate-400'}`}>
                                {actionLabels[lg.status] || lg.status}
                              </span>
                              {lg.reason && (
                                <span className="ml-1 text-[10px]" style={{ color: 'var(--accent-pink)' }} title={lg.reason}>
                                  {lg.reason.substring(0, 30)}
                                </span>
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
          )}
        </div>
      )}

      {/* ============ Security Tab (既存モック) ============ */}
      {tab === 'security' && (
        <div className="space-y-6 anim-fade-up">
          <div className="glass-card p-3 mb-4" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--accent-amber)' }}>
              このセクションは開発中です。表示されているデータはサンプルです。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="glass-card p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>有効な保護機能</p>
                <span className="text-emerald-400 text-lg">{'\u2713'}</span>
              </div>
              <p className="text-3xl font-bold mt-2">12 <span className="text-xs text-emerald-400 font-medium">+2 active</span></p>
            </div>
            <div className="glass-card p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>本日のブロック数</p>
                <span className="text-amber-400 text-lg">!</span>
              </div>
              <p className="text-3xl font-bold mt-2">483 <span className="text-xs text-emerald-400 font-medium">+5%</span></p>
            </div>
            <div className="glass-card p-5">
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>現在の接続数</p>
                <span className="text-sky-400 text-lg">~</span>
              </div>
              <p className="text-3xl font-bold mt-2">24 <span className="text-xs text-rose-400 font-medium">-2%</span></p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-5">
            <div className="col-span-2 space-y-5">
              <h2 className="text-base font-bold">リミッター設定</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="glass-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-sm font-bold">BAN保護機能</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>アルゴリズムによる自動BAN回避</p>
                    </div>
                    <button onClick={() => setBanProtection(!banProtection)}
                      className={`w-11 h-6 rounded-full relative transition-colors ${banProtection ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${banProtection ? 'right-1' : 'left-1'}`}></div>
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span>感度レベル</span><span>高</span>
                  </div>
                  <input type="range" min="1" max="5" value={sensitivity} onChange={e => setSensitivity(Number(e.target.value))} className="w-full accent-emerald-400" />
                </div>
                <div className="glass-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-sm font-bold">バーストモード</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>短時間の集中トラフィック制御</p>
                    </div>
                    <button onClick={() => setBurstMode(!burstMode)}
                      className={`w-11 h-6 rounded-full relative transition-colors ${burstMode ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                      <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${burstMode ? 'right-1' : 'left-1'}`}></div>
                    </button>
                  </div>
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span>送信制限/分</span><span className="font-mono font-semibold">{rateLimit} msgs</span>
                  </div>
                  <input type="range" min="10" max="100" value={rateLimit} onChange={e => setRateLimit(Number(e.target.value))} className="w-full accent-sky-400" />
                </div>
              </div>

              <div className="glass-card p-5">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-sm font-bold">接続制限</p>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>1アカウントあたりの同時接続セッション数</p>
                  </div>
                  <span className="text-2xl font-bold font-mono">{String(sessionLimit).padStart(2, '0')}</span>
                </div>
                <input type="range" min="1" max="10" value={sessionLimit} onChange={e => setSessionLimit(Number(e.target.value))} className="w-full accent-emerald-400" />
              </div>

              <div className="glass-card p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold">セキュリティログ</h3>
                  <button className="text-xs" style={{ color: 'var(--accent-primary)' }}>全てのログを見る</button>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ color: 'var(--text-muted)' }}>
                      <th className="text-left pb-3 font-medium">発生日時</th>
                      <th className="text-left pb-3 font-medium">イベント</th>
                      <th className="text-left pb-3 font-medium">IPアドレス</th>
                      <th className="text-left pb-3 font-medium">ステータス</th>
                    </tr>
                  </thead>
                  <tbody>
                    {securityLogs.map((l, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="py-3 font-mono">{l.time}</td>
                        <td className="py-3">{l.event}</td>
                        <td className="py-3 font-mono" style={{ color: 'var(--text-muted)' }}>{l.ip}</td>
                        <td className="py-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            l.status === 'BLOCKED' ? 'bg-rose-500/10 text-rose-400' :
                            l.status === 'WARNING' ? 'bg-amber-500/10 text-amber-400' :
                            'bg-emerald-500/10 text-emerald-400'
                          }`}>{l.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-5">
              <h2 className="text-base font-bold">システム稼働状況</h2>
              <div className="glass-card p-5">
                <div className="text-center">
                  <p className="text-5xl font-bold text-emerald-400">98%</p>
                  <p className="text-[10px] mt-2" style={{ color: 'var(--text-secondary)' }}>総合保護スコア</p>
                </div>
              </div>
              <div className="glass-card p-5">
                <h3 className="text-sm font-bold mb-3">クイックアクション</h3>
                <div className="space-y-2">
                  <button className="w-full glass-panel p-3 rounded-xl text-left flex items-center gap-3 hover:bg-white/[0.03] transition-all">
                    <span className="text-rose-400 text-lg">||</span>
                    <div>
                      <p className="text-xs font-medium">緊急停止</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>全接続を即時に切断</p>
                    </div>
                  </button>
                  <button className="w-full glass-panel p-3 rounded-xl text-left flex items-center gap-3 hover:bg-white/[0.03] transition-all">
                    <span className="text-sky-400 text-lg">~</span>
                    <div>
                      <p className="text-xs font-medium">自動最適化</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>リミッターを最適値に再構成</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
