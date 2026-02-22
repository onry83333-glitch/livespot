'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { tokensToJPY, formatCoinDual } from '@/lib/utils';

interface Account {
  id: string;
  account_name: string;
  is_active: boolean;
  cast_usernames?: string[];
}

interface WhaleUser {
  user_name: string;
  total_coins: number;
}

interface DMSummaryItem {
  campaign: string;
  status: string;
  count: number;
}

interface Stats {
  totalRevenue30d: number;
  txCount30d: number;
  spyMessages1h: number;
  dmSent7d: number;
  whales: WhaleUser[];
  recentDM: { user_name: string; status: string; campaign: string; queued_at: string }[];
}

interface ChurnRiskUser {
  user_name: string;
  segment: string;
  consecutive_absences: number;
  total_tokens: number;
}

function getSegmentBadgeClasses(segment: string): string {
  if (segment === 'S1') return 'bg-amber-500/15 text-amber-400 border border-amber-500/20';
  if (segment === 'S2' || segment === 'S3') return 'bg-purple-500/15 text-purple-400 border border-purple-500/20';
  if (segment === 'S4' || segment === 'S5') return 'bg-sky-500/15 text-sky-400 border border-sky-500/20';
  return 'bg-slate-500/15 text-slate-400 border border-slate-500/20';
}

export default function DashboardPage() {
  const { user } = useAuth();
  const supabaseRef = useRef(createClient());

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataEmpty, setDataEmpty] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // アカウント追加フォーム
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);

  // Churn risk alert
  const [churnRiskUsers, setChurnRiskUsers] = useState<ChurnRiskUser[]>([]);
  const churnFetchedRef = useRef<string | null>(null); // Tracks which account we've fetched churn for

  const sb = supabaseRef.current;

  // アカウント一覧取得
  const loadAccounts = useCallback(async () => {
    const { data } = await sb.from('accounts').select('id, account_name, is_active, cast_usernames').order('created_at');
    const list = (data || []) as Account[];
    setAccounts(list);
    if (list.length > 0 && !selectedAccount) {
      setSelectedAccount(list[0].id);
    }
    return list;
  }, [sb, selectedAccount]);

  // ダッシュボードデータ取得
  const loadStats = useCallback(async (accountId: string) => {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const since1h = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // 並列クエリ
    const [whalesRes, txRes, spyRes, dmCountRes, dmRecentRes] = await Promise.all([
      // ホエールランキング: paid_users top 15
      sb.from('paid_users')
        .select('user_name, total_coins')
        .eq('account_id', accountId)
        .order('total_coins', { ascending: false })
        .limit(15),
      // 30日売上: coin_transactions (tip/giftのみ)
      sb.from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
        .in('type', ['tip', 'gift'])
        .gte('date', since30d),
      // 1時間メッセージ数: spy_messages
      sb.from('spy_messages')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gte('message_time', since1h),
      // 7日DM送信数
      sb.from('dm_send_log')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .gte('queued_at', since7d),
      // 直近DM履歴
      sb.from('dm_send_log')
        .select('user_name, status, campaign, queued_at')
        .eq('account_id', accountId)
        .order('queued_at', { ascending: false })
        .limit(10),
    ]);

    const whales = whalesRes.data || [];
    const txList = txRes.data || [];
    const totalRevenue = txList.reduce((sum, t) => sum + (t.tokens || 0), 0);
    const hasData = whales.length > 0 || txList.length > 0;

    setDataEmpty(!hasData);
    setStats({
      totalRevenue30d: totalRevenue,
      txCount30d: txList.length,
      spyMessages1h: spyRes.count ?? 0,
      dmSent7d: dmCountRes.count ?? 0,
      whales,
      recentDM: dmRecentRes.data || [],
    });
    setLastFetchedAt(new Date());
  }, [sb]);

  // Churn risk data loading
  const loadChurnRisk = useCallback(async (accountId: string, _accts: Account[]) => {
    // FastAPIバックエンド未デプロイのため無効化
    if (churnFetchedRef.current === accountId) return;
    churnFetchedRef.current = accountId;
    setChurnRiskUsers([]);
  }, []);

  // 初回ロード
  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const list = await loadAccounts();
      if (list.length > 0) {
        await loadStats(list[0].id);
        loadChurnRisk(list[0].id, list);
      }
      setLoading(false);
    })();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // アカウント切り替え
  useEffect(() => {
    if (selectedAccount) {
      loadStats(selectedAccount);
      churnFetchedRef.current = null; // Reset to allow re-fetch for new account
      loadChurnRisk(selectedAccount, accounts);
    }
  }, [selectedAccount, loadStats]); // eslint-disable-line react-hooks/exhaustive-deps

  // アカウント追加
  const handleAddAccount = async () => {
    if (!newAccountName.trim()) return;
    setAddingAccount(true);
    const { error } = await sb.from('accounts').insert({ user_id: user!.id, account_name: newAccountName.trim() });
    if (!error) {
      setNewAccountName('');
      setShowAddForm(false);
      const list = await loadAccounts();
      if (list.length > 0) {
        setSelectedAccount(list[list.length - 1].id);
        await loadStats(list[list.length - 1].id);
      }
    }
    setAddingAccount(false);
  };

  // デモデータ挿入
  const handleInsertDemo = async () => {
    if (!selectedAccount) return;
    setDemoLoading(true);
    setDemoError(null);

    try {
      const now = new Date();

      // paid_users 10件
      const paidUsers = [
        { account_id: selectedAccount, user_name: 'Tanaka_San', total_coins: 185000, user_level: 85, last_payment_date: new Date(now.getTime() - 1 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'King_Cobra99', total_coins: 146000, user_level: 78, last_payment_date: new Date(now.getTime() - 2 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'Satoshi_Vibe', total_coins: 120000, user_level: 72, last_payment_date: new Date(now.getTime() - 1 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'Executive_VIP', total_coins: 79000, user_level: 65, last_payment_date: new Date(now.getTime() - 3 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'NightOwl_Tokyo', total_coins: 54000, user_level: 55, last_payment_date: new Date(now.getTime() - 5 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'BigBoss_Osaka', total_coins: 42000, user_level: 48, last_payment_date: new Date(now.getTime() - 4 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'SilverFox_JP', total_coins: 38000, user_level: 42, last_payment_date: new Date(now.getTime() - 7 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'CasualFan_22', total_coins: 15000, user_level: 25, last_payment_date: new Date(now.getTime() - 10 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'NewUser_ABC', total_coins: 5000, user_level: 10, last_payment_date: new Date(now.getTime() - 2 * 86400000).toISOString() },
        { account_id: selectedAccount, user_name: 'Lurker_999', total_coins: 2000, user_level: 5, last_payment_date: new Date(now.getTime() - 14 * 86400000).toISOString() },
      ];

      // coin_transactions 10件（直近30日内）
      const txTypes = ['tip', 'gift', 'private', 'spy', 'group'];
      const transactions = paidUsers.slice(0, 10).map((u, i) => ({
        account_id: selectedAccount,
        user_name: u.user_name,
        tokens: Math.floor(u.total_coins * 0.3),
        type: txTypes[i % txTypes.length],
        date: new Date(now.getTime() - (i + 1) * 2 * 86400000).toISOString(),
      }));

      const [r1, r2] = await Promise.all([
        sb.from('paid_users').upsert(paidUsers, { onConflict: 'account_id,user_name' }),
        sb.from('coin_transactions').insert(transactions),
      ]);

      if (r1.error) throw new Error(`paid_users: ${r1.error.message}`);
      if (r2.error) throw new Error(`coin_transactions: ${r2.error.message}`);

      await loadStats(selectedAccount);
    } catch (e: unknown) {
      setDemoError(e instanceof Error ? e.message : String(e));
    }

    setDemoLoading(false);
  };

  if (!user) return null;

  // スケルトンローディング
  if (loading) {
    return (
      <div className="space-y-6 max-w-[1400px]">
        <div className="h-12 rounded-xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        <div className="grid grid-cols-3 gap-5">
          <div className="col-span-2 h-64 rounded-2xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          <div className="h-64 rounded-2xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        </div>
        <div className="grid grid-cols-5 gap-5">
          <div className="col-span-2 h-56 rounded-2xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
          <div className="col-span-3 h-56 rounded-2xl animate-pulse" style={{ background: 'var(--bg-card)' }} />
        </div>
      </div>
    );
  }

  // アカウント未登録
  if (accounts.length === 0) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="glass-card p-8 max-w-md w-full text-center anim-fade-up">
          <div className="text-4xl mb-4">{'\uD83C\uDF10'}</div>
          <h2 className="text-xl font-bold mb-2">{'\u30A2\u30AB\u30A6\u30F3\u30C8\u3092\u8FFD\u52A0'}</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            {`Stripchat\u30A2\u30AB\u30A6\u30F3\u30C8\u3092\u767B\u9332\u3057\u3066\u3001\u30C0\u30C3\u30B7\u30E5\u30DC\u30FC\u30C9\u3092\u6709\u52B9\u5316\u3057\u307E\u3057\u3087\u3046\u3002`}
          </p>
          <div className="flex gap-2">
            <input
              className="input-glass flex-1"
              placeholder={'\u30A2\u30AB\u30A6\u30F3\u30C8\u540D\uFF08\u4F8B: \u30B5\u30AF\u30E9\u4E8B\u52D9\u6240\uFF09'}
              value={newAccountName}
              onChange={e => setNewAccountName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddAccount()}
            />
            <button onClick={handleAddAccount} disabled={addingAccount} className="btn-primary text-sm disabled:opacity-50">
              {addingAccount ? '\u4F5C\u6210\u4E2D...' : '\u8FFD\u52A0'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Build churn DM URL
  const churnDmUrl = churnRiskUsers.length > 0
    ? `/dm?preset=churn&users=${churnRiskUsers.map(u => u.user_name).join(',')}`
    : '/dm';

  const displayedChurnUsers = churnRiskUsers.slice(0, 5);
  const remainingChurnCount = churnRiskUsers.length - 5;

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* アカウント切り替え */}
          <select
            className="input-glass text-sm py-2 w-64"
            value={selectedAccount || ''}
            onChange={e => setSelectedAccount(e.target.value)}
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
          <button onClick={() => setShowAddForm(!showAddForm)} className="btn-ghost text-xs py-2">+ {'\u8FFD\u52A0'}</button>
        </div>
        <div className="flex items-center gap-3">
          {lastFetchedAt && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {'\u6700\u7D42\u66F4\u65B0: '}{lastFetchedAt.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {stats && stats.spyMessages1h > 0 && (
            <div className="anim-pulse-glow px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2"
              style={{ background: 'rgba(244,63,94,0.15)', color: 'var(--accent-pink)', border: '1px solid rgba(244,63,94,0.2)' }}>
              {'\u26A1'} {'\u76F4\u8FD11\u6642\u9593'}: {stats.spyMessages1h}{'\u4EF6\u306E\u30C1\u30E3\u30C3\u30C8'}
            </div>
          )}
          <div className="badge-live flex items-center gap-1.5">
            {lastFetchedAt ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
                {'\u7A3C\u50CD\u4E2D \u2014 '}{lastFetchedAt.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                {'\u30C7\u30FC\u30BF\u53D6\u5F97\u524D'}
              </>
            )}
          </div>
        </div>
      </div>

      {/* アカウント追加フォーム（インライン） */}
      {showAddForm && (
        <div className="glass-card p-4 flex gap-3 items-center anim-fade">
          <input
            className="input-glass flex-1 text-sm"
            placeholder={'\u65B0\u3057\u3044\u30A2\u30AB\u30A6\u30F3\u30C8\u540D'}
            value={newAccountName}
            onChange={e => setNewAccountName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddAccount()}
          />
          <button onClick={handleAddAccount} disabled={addingAccount} className="btn-primary text-xs disabled:opacity-50">
            {addingAccount ? '\u4F5C\u6210\u4E2D...' : '\u4F5C\u6210'}
          </button>
          <button onClick={() => setShowAddForm(false)} className="btn-ghost text-xs">{'\u30AD\u30E3\u30F3\u30BB\u30EB'}</button>
        </div>
      )}

      {/* データなし → デモデータ挿入（開発環境のみ） */}
      {process.env.NODE_ENV === 'development' && dataEmpty && stats && (
        <div className="glass-card p-6 text-center anim-fade-up">
          <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
            {'\u3053\u306E\u30A2\u30AB\u30A6\u30F3\u30C8\u306B\u306F\u307E\u3060\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u30C7\u30E2\u30C7\u30FC\u30BF\u3092\u633F\u5165\u3057\u3066\u753B\u9762\u3092\u78BA\u8A8D\u3067\u304D\u307E\u3059\u3002'}
          </p>
          <button onClick={handleInsertDemo} disabled={demoLoading} className="btn-primary text-sm disabled:opacity-50">
            {demoLoading ? '\u633F\u5165\u4E2D...' : '\uD83E\uDDEA \u30C7\u30E2\u30C7\u30FC\u30BF\u3092\u633F\u5165\uFF08paid_users + coin_transactions\uFF09'}
          </button>
          {demoError && (
            <p className="mt-3 text-xs" style={{ color: 'var(--accent-pink)' }}>{demoError}</p>
          )}
        </div>
      )}

      {/* Top row: Stats + Whale ranking */}
      <div className="grid grid-cols-3 gap-5 anim-fade-up">
        {/* Stats Cards */}
        <div className="col-span-2 glass-card p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-xl font-bold">{'\u30A2\u30AF\u30C6\u30A3\u30D6\u30FB\u30A2\u30AB\u30A6\u30F3\u30C8'}</h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {accounts.find(a => a.id === selectedAccount)?.account_name} {'\u306E\u30EA\u30A2\u30EB\u30BF\u30A4\u30E0\u30C7\u30FC\u30BF'}
              </p>
            </div>
            <Link href="/spy" className="badge-live flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
              {'SPY\u30ED\u30B0\u3092\u898B\u308B \u2192'}
            </Link>
          </div>

          <div className="grid grid-cols-4 gap-4 mb-5">
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? tokensToJPY(stats.totalRevenue30d) : '\u2014'}
              </p>
              {stats && stats.totalRevenue30d > 0 && (
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {stats.totalRevenue30d.toLocaleString()} tk
                </p>
              )}
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'30\u65E5\u58F2\u4E0A'}</p>
            </div>
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? stats.txCount30d.toLocaleString() : '\u2014'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'\u53D6\u5F15\u6570 (30\u65E5)'}</p>
            </div>
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? stats.spyMessages1h.toLocaleString() : '\u2014'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'\u30C1\u30E3\u30C3\u30C8 (1h)'}</p>
            </div>
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? stats.dmSent7d.toLocaleString() : '\u2014'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'DM\u9001\u4FE1 (7\u65E5)'}</p>
            </div>
          </div>

        </div>

        {/* Whale Ranking */}
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold">{'\uD83D\uDC0B \u30DB\u30A8\u30FC\u30EB\u30E9\u30F3\u30AD\u30F3\u30B0'}</h3>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              {'\u7D2F\u8A08\u30B3\u30A4\u30F3'}
            </p>
          </div>
          <div className="space-y-0 overflow-auto max-h-[280px]">
            {stats && stats.whales.length > 0 ? (
              stats.whales.map((w, i) => (
                <div key={w.user_name} className="flex items-center justify-between py-2.5 border-b"
                  style={{ borderColor: 'var(--border-glass)' }}>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-bold w-6 text-right ${
                      i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-orange-400' : 'text-slate-500'
                    }`}>
                      #{i + 1}
                    </span>
                    <Link href={'/users/' + encodeURIComponent(w.user_name)}
                      className="text-sm truncate max-w-[120px] hover:text-sky-400 transition-colors">
                      {w.user_name}
                    </Link>
                    <Link href={'/dm?user=' + encodeURIComponent(w.user_name)}
                      className="text-xs opacity-40 hover:opacity-100 transition-opacity" title={'DM\u9001\u4FE1'}>
                      {'\uD83D\uDCE7'}
                    </Link>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-emerald-400">{tokensToJPY(w.total_coins)}</span>
                    <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{w.total_coins.toLocaleString()} tk</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>{'\u30C7\u30FC\u30BF\u306A\u3057'}</p>
            )}
          </div>
        </div>
      </div>

      {/* Churn Risk Alert - shown BETWEEN KPI cards and quick actions */}
      {churnRiskUsers.length > 0 && (
        <div className="glass-card p-5 anim-fade-up"
          style={{
            background: 'rgba(239,68,68,0.06)',
            borderTop: '1px solid rgba(239,68,68,0.15)',
            borderRight: '1px solid rgba(239,68,68,0.15)',
            borderBottom: '1px solid rgba(239,68,68,0.15)',
            borderLeft: '3px solid rgb(239,68,68)',
          }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold flex items-center gap-2">
              {'\u26A0\uFE0F \u96E2\u8131\u30EA\u30B9\u30AF: '}{churnRiskUsers.length}{'\u540D'}
            </h3>
            <Link href={churnDmUrl}
              className="text-xs font-medium px-3 py-1.5 rounded-lg transition-all hover:bg-rose-500/15"
              style={{ color: 'var(--accent-pink)' }}>
              {'DM\u9001\u4FE1 \u2192'}
            </Link>
          </div>
          <div className="space-y-2">
            {displayedChurnUsers.map(u => (
              <div key={u.user_name} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
                style={{ background: 'rgba(15,23,42,0.3)' }}>
                <span className="font-medium flex-1 truncate">{u.user_name}</span>
                <span className={`px-2 py-0.5 rounded-full font-medium ${getSegmentBadgeClasses(u.segment)}`}>
                  {u.segment}
                </span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {u.consecutive_absences}{'\u65E5\u9023\u7D9A\u4E0D\u5728'}
                </span>
                <span className="text-emerald-400 font-semibold">
                  {tokensToJPY(u.total_tokens)}
                </span>
              </div>
            ))}
            {remainingChurnCount > 0 && (
              <p className="text-[10px] text-center pt-1" style={{ color: 'var(--text-muted)' }}>
                {'\u4ED6'}{remainingChurnCount}{'\u540D'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Bottom row: Quick Links + DM History */}
      <div className="grid grid-cols-5 gap-5 anim-fade-up delay-2">
        {/* Quick Links */}
        <div className="col-span-2 glass-card p-6">
          <h3 className="text-base font-bold flex items-center gap-2 mb-4">
            {'\uD83D\uDD2E \u30AF\u30A4\u30C3\u30AF\u30A2\u30AF\u30B7\u30E7\u30F3'}
          </h3>
          <div className="space-y-3">
            <Link href="/spy" className="glass-panel p-4 rounded-xl border-l-2 block hover:bg-white/[0.03] transition-colors"
              style={{ borderLeftColor: 'var(--accent-primary)' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-primary)' }}>{'\uD83D\uDD0D \u30EA\u30A2\u30EB\u30BF\u30A4\u30E0\u904B\u55B6'}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'SPY\u30ED\u30B0\u3067\u30C1\u30E3\u30C3\u30C8\u3092\u30EA\u30A2\u30EB\u30BF\u30A4\u30E0\u76E3\u8996'}</p>
            </Link>
            <Link href="/dm" className="glass-panel p-4 rounded-xl border-l-2 block hover:bg-white/[0.03] transition-colors"
              style={{ borderLeftColor: 'var(--accent-pink)' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-pink)' }}>{'\uD83D\uDCAC DM\u4E00\u6589\u9001\u4FE1'}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'\u30BF\u30FC\u30B2\u30C3\u30C8\u306BDM\u3092\u4E00\u62EC\u9001\u4FE1'}</p>
            </Link>
            <Link href="/analytics" className="glass-panel p-4 rounded-xl border-l-2 block hover:bg-white/[0.03] transition-colors"
              style={{ borderLeftColor: 'var(--accent-green)' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-green)' }}>{'\uD83D\uDCCA \u5206\u6790&\u30B9\u30B3\u30A2\u30EA\u30F3\u30B0'}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{'\u58F2\u4E0A\u30C8\u30EC\u30F3\u30C9\u30FBARPU\u30FALTV\u3092\u5206\u6790'}</p>
            </Link>
          </div>
        </div>

        {/* DM送信サマリー */}
        <div className="col-span-3 glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold flex items-center gap-2">
              {'\uD83D\uDCCB \u76F4\u8FD1DM\u9001\u4FE1\u5C65\u6B74'}
            </h3>
            <Link href="/dm" className="btn-ghost text-xs">
              {'DM\u753B\u9762\u3078 \u2192'}
            </Link>
          </div>

          {stats && stats.recentDM.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                      <th className="pb-3 font-medium text-xs">{'\u30E6\u30FC\u30B6\u30FC'}</th>
                      <th className="pb-3 font-medium text-xs">{'\u30AD\u30E3\u30F3\u30DA\u30FC\u30F3'}</th>
                      <th className="pb-3 font-medium text-xs">{'\u30B9\u30C6\u30FC\u30BF\u30B9'}</th>
                      <th className="pb-3 font-medium text-xs">{'\u65E5\u6642'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentDM.map((dm, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="py-2.5 font-medium truncate max-w-[160px]">{dm.user_name}</td>
                        <td className="py-2.5 text-xs truncate max-w-[180px]" style={{ color: 'var(--text-secondary)' }}>
                          {dm.campaign || '\u2014'}
                        </td>
                        <td className="py-2.5">
                          <span className={`text-xs px-2 py-1 rounded-full ${
                            dm.status === 'success' ? 'bg-emerald-500/10 text-emerald-400' :
                            dm.status === 'error' ? 'bg-rose-500/10 text-rose-400' :
                            dm.status === 'sending' ? 'bg-sky-500/10 text-sky-400' :
                            'bg-amber-500/10 text-amber-400'
                          }`}>{dm.status}</span>
                        </td>
                        <td className="py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}
                          title={new Date(dm.queued_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}>
                          {new Date(dm.queued_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-glass)' }}>
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{'30\u65E5\u58F2\u4E0A\u5408\u8A08'}</p>
                  <p className="text-xl font-bold">{stats ? tokensToJPY(stats.totalRevenue30d) : '\u2014'}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{'7\u65E5DM\u9001\u4FE1\u6570'}</p>
                  <p className="text-xl font-bold text-emerald-400">{stats ? stats.dmSent7d : 0}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {'\u30DB\u30A8\u30FC\u30EB\u6570: '}{stats?.whales.length || 0}{'\u540D'}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="text-xs text-center py-12" style={{ color: 'var(--text-muted)' }}>
              {'DM\u9001\u4FE1\u5C65\u6B74\u304C\u3042\u308A\u307E\u305B\u3093\u3002DM\u753B\u9762\u304B\u3089\u9001\u4FE1\u3057\u3066\u307F\u307E\u3057\u3087\u3046\u3002'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
