'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { tokensToJPY } from '@/lib/utils';

interface Account {
  id: string;
  account_name: string;
  is_active: boolean;
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

  // アカウント追加フォーム
  const [showAddForm, setShowAddForm] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);

  const sb = supabaseRef.current;

  // アカウント一覧取得
  const loadAccounts = useCallback(async () => {
    const { data } = await sb.from('accounts').select('id, account_name, is_active').order('created_at');
    const list = data || [];
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
      // 30日売上: coin_transactions
      sb.from('coin_transactions')
        .select('tokens')
        .eq('account_id', accountId)
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
  }, [sb]);

  // 初回ロード
  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      const list = await loadAccounts();
      if (list.length > 0) {
        await loadStats(list[0].id);
      }
      setLoading(false);
    })();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // アカウント切り替え
  useEffect(() => {
    if (selectedAccount) {
      loadStats(selectedAccount);
    }
  }, [selectedAccount, loadStats]);

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
          <div className="text-4xl mb-4">🌐</div>
          <h2 className="text-xl font-bold mb-2">アカウントを追加</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            Stripchatアカウントを登録して、ダッシュボードを有効化しましょう。
          </p>
          <div className="flex gap-2">
            <input
              className="input-glass flex-1"
              placeholder="アカウント名（例: サクラ事務所）"
              value={newAccountName}
              onChange={e => setNewAccountName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddAccount()}
            />
            <button onClick={handleAddAccount} disabled={addingAccount} className="btn-primary text-sm disabled:opacity-50">
              {addingAccount ? '作成中...' : '追加'}
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          <button onClick={() => setShowAddForm(!showAddForm)} className="btn-ghost text-xs py-2">+ 追加</button>
        </div>
        <div className="flex items-center gap-3">
          {stats && stats.spyMessages1h > 0 && (
            <div className="anim-pulse-glow px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2"
              style={{ background: 'rgba(244,63,94,0.15)', color: 'var(--accent-pink)', border: '1px solid rgba(244,63,94,0.2)' }}>
              ⚡ 直近1時間: {stats.spyMessages1h}件のチャット
            </div>
          )}
          <div className="badge-live flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
            サーバー状態: 最適化済み
          </div>
        </div>
      </div>

      {/* アカウント追加フォーム（インライン） */}
      {showAddForm && (
        <div className="glass-card p-4 flex gap-3 items-center anim-fade">
          <input
            className="input-glass flex-1 text-sm"
            placeholder="新しいアカウント名"
            value={newAccountName}
            onChange={e => setNewAccountName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddAccount()}
          />
          <button onClick={handleAddAccount} disabled={addingAccount} className="btn-primary text-xs disabled:opacity-50">
            {addingAccount ? '作成中...' : '作成'}
          </button>
          <button onClick={() => setShowAddForm(false)} className="btn-ghost text-xs">キャンセル</button>
        </div>
      )}

      {/* データなし → デモデータ挿入 */}
      {dataEmpty && stats && (
        <div className="glass-card p-6 text-center anim-fade-up">
          <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
            このアカウントにはまだデータがありません。デモデータを挿入して画面を確認できます。
          </p>
          <button onClick={handleInsertDemo} disabled={demoLoading} className="btn-primary text-sm disabled:opacity-50">
            {demoLoading ? '挿入中...' : '🧪 デモデータを挿入（paid_users + coin_transactions）'}
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
              <h2 className="text-xl font-bold">アクティブ・アカウント</h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {accounts.find(a => a.id === selectedAccount)?.account_name} のリアルタイムデータ
              </p>
            </div>
            <Link href="/spy" className="badge-live flex items-center gap-1.5 text-sm hover:opacity-80 transition-opacity">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
              SPYログを見る →
            </Link>
          </div>

          <div className="grid grid-cols-4 gap-4 mb-5">
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? tokensToJPY(stats.totalRevenue30d) : '—'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>30日売上</p>
            </div>
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? stats.txCount30d.toLocaleString() : '—'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>取引数 (30日)</p>
            </div>
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? stats.spyMessages1h.toLocaleString() : '—'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>チャット (1h)</p>
            </div>
            <div className="glass-panel p-4 rounded-xl">
              <p className="text-2xl font-bold tracking-tight">
                {stats ? stats.dmSent7d.toLocaleString() : '—'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>DM送信 (7日)</p>
            </div>
          </div>

          <div className="glass-panel px-4 py-3 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg">🛡</span>
              <div>
                <p className="text-sm font-medium">BAN保護機能</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>高度なプロキシと動作監視が有効です</p>
              </div>
            </div>
            <div className="w-11 h-6 rounded-full bg-emerald-500 relative cursor-pointer">
              <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white"></div>
            </div>
          </div>
        </div>

        {/* Whale Ranking */}
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold">🐋 ホエールランキング</h3>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              累計コイン
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
                    <span className="text-sm truncate max-w-[140px]">{w.user_name}</span>
                  </div>
                  <span className="text-sm font-semibold text-emerald-400">{tokensToJPY(w.total_coins)}</span>
                </div>
              ))
            ) : (
              <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>データなし</p>
            )}
          </div>
        </div>
      </div>

      {/* Bottom row: Quick Links + DM History */}
      <div className="grid grid-cols-5 gap-5 anim-fade-up delay-2">
        {/* Quick Links */}
        <div className="col-span-2 glass-card p-6">
          <h3 className="text-base font-bold flex items-center gap-2 mb-4">
            🔮 クイックアクション
          </h3>
          <div className="space-y-3">
            <Link href="/spy" className="glass-panel p-4 rounded-xl border-l-2 block hover:bg-white/[0.03] transition-colors"
              style={{ borderLeftColor: 'var(--accent-primary)' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-primary)' }}>🔍 リアルタイム運営</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>SPYログでチャットをリアルタイム監視</p>
            </Link>
            <Link href="/dm" className="glass-panel p-4 rounded-xl border-l-2 block hover:bg-white/[0.03] transition-colors"
              style={{ borderLeftColor: 'var(--accent-pink)' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-pink)' }}>💬 DM一斉送信</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>ターゲットにDMを一括送信</p>
            </Link>
            <Link href="/analytics" className="glass-panel p-4 rounded-xl border-l-2 block hover:bg-white/[0.03] transition-colors"
              style={{ borderLeftColor: 'var(--accent-green)' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--accent-green)' }}>📊 分析&スコアリング</p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>売上トレンド・ARPU・LTVを分析</p>
            </Link>
          </div>
        </div>

        {/* DM送信サマリー */}
        <div className="col-span-3 glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold flex items-center gap-2">
              📋 直近DM送信履歴
            </h3>
            <Link href="/dm" className="btn-ghost text-xs">
              DM画面へ →
            </Link>
          </div>

          {stats && stats.recentDM.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                      <th className="pb-3 font-medium text-xs">ユーザー</th>
                      <th className="pb-3 font-medium text-xs">キャンペーン</th>
                      <th className="pb-3 font-medium text-xs">ステータス</th>
                      <th className="pb-3 font-medium text-xs">日時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentDM.map((dm, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                        <td className="py-2.5 font-medium truncate max-w-[160px]">{dm.user_name}</td>
                        <td className="py-2.5 text-xs truncate max-w-[180px]" style={{ color: 'var(--text-secondary)' }}>
                          {dm.campaign || '—'}
                        </td>
                        <td className="py-2.5">
                          <span className={`text-xs px-2 py-1 rounded-full ${
                            dm.status === 'success' ? 'bg-emerald-500/10 text-emerald-400' :
                            dm.status === 'error' ? 'bg-rose-500/10 text-rose-400' :
                            dm.status === 'sending' ? 'bg-sky-500/10 text-sky-400' :
                            'bg-amber-500/10 text-amber-400'
                          }`}>{dm.status}</span>
                        </td>
                        <td className="py-2.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                          {new Date(dm.queued_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-glass)' }}>
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>30日売上合計</p>
                  <p className="text-xl font-bold">{stats ? tokensToJPY(stats.totalRevenue30d) : '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>7日DM送信数</p>
                  <p className="text-xl font-bold text-emerald-400">{stats ? stats.dmSent7d : 0}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    ホエール数: {stats?.whales.length || 0}名
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="text-xs text-center py-12" style={{ color: 'var(--text-muted)' }}>
              DM送信履歴がありません。DM画面から送信してみましょう。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
