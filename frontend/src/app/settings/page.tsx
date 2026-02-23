'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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

  const [tab, setTab] = useState<'account' | 'security'>('account');

  // === Account settings ===
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const [castInput, setCastInput] = useState('');
  const [coinRate, setCoinRate] = useState(COIN_RATE);
  const [loading, setLoading] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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
          { key: 'security' as const, label: 'セキュリティ' },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-all ${
              tab === t.key ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
            }`}>
            {t.label}
          </button>
        ))}
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
