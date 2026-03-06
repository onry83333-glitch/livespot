'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY, COIN_RATE } from '@/lib/utils';
import type { Account } from '@/types';

/** JST今日0時をUTCで返す */
function getTodayStartUTC(): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  return new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 3600000
  );
}

/** 週境界: 月曜03:00 JST をUTCで返す */
function getWeekStartJST(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay();
  const hour = jst.getUTCHours();
  let diff = day === 0 ? 6 : day - 1;
  if (day === 1 && hour < 3) diff = 7;
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() - diff - offset * 7);
  monday.setUTCHours(3, 0, 0, 0);
  return new Date(monday.getTime() - 9 * 60 * 60 * 1000);
}

/** JST今月1日0時をUTCで返す */
function getMonthStartUTC(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() - offset;
  return new Date(Date.UTC(y, m, 1) - 9 * 3600000);
}

interface CastSales {
  cast_name: string;
  display_name: string | null;
  today: number;
  thisWeek: number;
  thisMonth: number;
  isLive: boolean;
}

interface SystemAlert {
  level: 'info' | 'warning' | 'error';
  message: string;
  time: string;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [castSales, setCastSales] = useState<CastSales[]>([]);
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  // 期間境界
  const todayStart = useMemo(() => getTodayStartUTC(), []);
  const thisWeekStart = useMemo(() => getWeekStartJST(0), []);
  const lastWeekStart = useMemo(() => getWeekStartJST(1), []);
  const thisMonthStart = useMemo(() => getMonthStartUTC(0), []);
  const lastMonthStart = useMemo(() => getMonthStartUTC(1), []);

  // アカウント取得
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('*').limit(100).then(({ data }) => {
      if (data && data.length > 0) {
        setAccounts(data);
        setSelectedAccount(data[0].id);
      }
    });
  }, [user]);

  // メインデータ取得
  useEffect(() => {
    if (!selectedAccount) return;
    setLoading(true);

    const load = async () => {
      const supabase = createClient();
      try {
        // 登録キャスト取得
        const { data: casts } = await supabase
          .from('registered_casts')
          .select('cast_name, display_name')
          .eq('account_id', selectedAccount)
          .eq('is_active', true)
          .order('created_at', { ascending: true })
          .limit(50);

        if (!casts || casts.length === 0) {
          setCastSales([]);
          setLoading(false);
          return;
        }

        const castNames = casts.map(c => c.cast_name);

        // coin_transactions: 先月1日以降を全件取得（ページネーション）
        const PAGE_SIZE = 500;
        const MAX_PAGES = 40;
        let allRows: { cast_name: string; tokens: number; date: string }[] = [];
        let lastId = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          const { data, error } = await supabase
            .from('coin_transactions')
            .select('id, cast_name, tokens, date')
            .eq('account_id', selectedAccount)
            .in('cast_name', castNames)
            .gte('date', lastMonthStart.toISOString())
            .gt('id', lastId)
            .gt('tokens', 0)
            .order('id', { ascending: true })
            .limit(PAGE_SIZE);
          if (error || !data || data.length === 0) break;
          allRows = allRows.concat(data);
          lastId = data[data.length - 1].id;
          if (data.length < PAGE_SIZE) break;
        }

        // キャスト別に集計
        const salesMap = new Map<string, { today: number; thisWeek: number; lastWeek: number; thisMonth: number; lastMonth: number }>();
        for (const cast of casts) {
          salesMap.set(cast.cast_name, { today: 0, thisWeek: 0, lastWeek: 0, thisMonth: 0, lastMonth: 0 });
        }

        for (const row of allRows) {
          const entry = salesMap.get(row.cast_name);
          if (!entry) continue;
          const d = new Date(row.date);
          const tk = row.tokens || 0;

          if (d >= todayStart) entry.today += tk;
          if (d >= thisWeekStart) entry.thisWeek += tk;
          else if (d >= lastWeekStart) entry.lastWeek += tk;
          if (d >= thisMonthStart) entry.thisMonth += tk;
          else if (d >= lastMonthStart) entry.lastMonth += tk;
        }

        // LIVE状態: chat_logs直近10分
        const { data: recentChats } = await supabase
          .from('chat_logs')
          .select('cast_name, created_at')
          .eq('account_id', selectedAccount)
          .order('created_at', { ascending: false })
          .limit(200);

        const liveSet = new Set<string>();
        for (const m of recentChats || []) {
          if (m.cast_name && (Date.now() - new Date(m.created_at).getTime()) / 60000 < 10) {
            liveSet.add(m.cast_name);
          }
        }

        const castSalesData: CastSales[] = casts.map(c => {
          const s = salesMap.get(c.cast_name)!;
          return {
            cast_name: c.cast_name,
            display_name: c.display_name,
            today: s.today,
            thisWeek: s.thisWeek,
            thisMonth: s.thisMonth,
            isLive: liveSet.has(c.cast_name),
          };
        });
        setCastSales(castSalesData);

        // システムアラート: pipeline_status + 最新同期時刻
        const alertsList: SystemAlert[] = [];
        const { data: pipelines } = await supabase
          .from('pipeline_status')
          .select('name, status, updated_at, error_message')
          .order('updated_at', { ascending: false })
          .limit(20);

        if (pipelines) {
          for (const p of pipelines) {
            if (p.status === 'error') {
              alertsList.push({
                level: 'error',
                message: `${p.name}: ${p.error_message || 'エラー発生'}`,
                time: p.updated_at,
              });
            } else if (p.status === 'warning') {
              alertsList.push({
                level: 'warning',
                message: `${p.name}: ${p.error_message || '警告'}`,
                time: p.updated_at,
              });
            }
          }
        }

        // コイン同期の最終時刻
        const { data: latestTx } = await supabase
          .from('coin_transactions')
          .select('date')
          .eq('account_id', selectedAccount)
          .order('date', { ascending: false })
          .limit(1);
        if (latestTx && latestTx[0]) {
          setLastSyncAt(latestTx[0].date);
          const hoursAgo = (Date.now() - new Date(latestTx[0].date).getTime()) / 3600000;
          if (hoursAgo > 12) {
            alertsList.push({
              level: 'warning',
              message: `コイン同期が${Math.floor(hoursAgo)}時間前で止まっています`,
              time: latestTx[0].date,
            });
          }
        }

        if (alertsList.length === 0) {
          alertsList.push({ level: 'info', message: '異常なし', time: new Date().toISOString() });
        }
        setAlerts(alertsList);
      } catch (err) {
        console.error('[dashboard] データ取得失敗:', err);
      } finally {
        setLoading(false);
      }
    };
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount]);

  // 集計
  const totals = useMemo(() => {
    let today = 0, thisWeek = 0, thisMonth = 0;
    for (const c of castSales) {
      today += c.today;
      thisWeek += c.thisWeek;
      thisMonth += c.thisMonth;
    }
    return { today, thisWeek, thisMonth };
  }, [castSales]);

  const coinRate = accounts.find(a => a.id === selectedAccount)?.coin_rate || COIN_RATE;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-sky-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>読み込み中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-[1200px] mx-auto anim-fade-up">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">ダッシュボード</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })}
            {lastSyncAt && (
              <span className="ml-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                最終同期: {new Date(lastSyncAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        {accounts.length > 1 && (
          <select
            value={selectedAccount}
            onChange={e => setSelectedAccount(e.target.value)}
            className="input-glass text-sm px-3 py-1.5"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* 売上サマリー 3カード */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          label="今日"
          tokens={totals.today}
          coinRate={coinRate}
          accent="var(--accent-primary)"
        />
        <SummaryCard
          label="今週"
          tokens={totals.thisWeek}
          coinRate={coinRate}
          accent="var(--accent-green)"
        />
        <SummaryCard
          label="今月"
          tokens={totals.thisMonth}
          coinRate={coinRate}
          accent="var(--accent-purple)"
        />
      </div>

      {/* キャスト別サマリー */}
      <div className="glass-card p-5">
        <h2 className="text-sm font-bold mb-4" style={{ color: 'var(--text-secondary)' }}>キャスト別</h2>
        {castSales.length === 0 ? (
          <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
            登録キャストがありません
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: 'var(--border-glass)' }}>
                  <th className="text-left py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>キャスト</th>
                  <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>今日</th>
                  <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>今週</th>
                  <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}>今月</th>
                  <th className="text-right py-2 px-3 font-medium" style={{ color: 'var(--text-muted)' }}></th>
                </tr>
              </thead>
              <tbody>
                {castSales.map(c => (
                  <tr key={c.cast_name} className="border-b hover:bg-white/[0.02] transition-colors" style={{ borderColor: 'var(--border-glass)' }}>
                    <td className="py-3 px-3">
                      <Link href={`/casts/${encodeURIComponent(c.cast_name)}`} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                        {c.isLive && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
                        <span className="font-medium text-white">{c.display_name || c.cast_name}</span>
                        {c.isLive && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 font-semibold">LIVE</span>}
                      </Link>
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-xs">
                      <span style={{ color: c.today > 0 ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                        {c.today > 0 ? formatTokens(c.today) : '—'}
                      </span>
                      {c.today > 0 && (
                        <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {tokensToJPY(c.today, coinRate)}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-xs">
                      <span style={{ color: c.thisWeek > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                        {c.thisWeek > 0 ? formatTokens(c.thisWeek) : '—'}
                      </span>
                      {c.thisWeek > 0 && (
                        <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {tokensToJPY(c.thisWeek, coinRate)}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right font-mono text-xs">
                      <span style={{ color: c.thisMonth > 0 ? 'var(--accent-purple)' : 'var(--text-muted)' }}>
                        {c.thisMonth > 0 ? formatTokens(c.thisMonth) : '—'}
                      </span>
                      {c.thisMonth > 0 && (
                        <span className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {tokensToJPY(c.thisMonth, coinRate)}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right">
                      <Link
                        href={`/casts/${encodeURIComponent(c.cast_name)}?tab=analytics`}
                        className="text-[11px] px-2 py-1 rounded-lg hover:bg-white/[0.05] transition-colors"
                        style={{ color: 'var(--accent-primary)' }}
                      >
                        詳細 →
                      </Link>
                    </td>
                  </tr>
                ))}
                {/* 合計行 */}
                <tr className="font-semibold">
                  <td className="py-3 px-3" style={{ color: 'var(--text-secondary)' }}>合計</td>
                  <td className="py-3 px-3 text-right font-mono text-xs" style={{ color: 'var(--accent-primary)' }}>
                    {totals.today > 0 ? formatTokens(totals.today) : '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs" style={{ color: 'var(--accent-green)' }}>
                    {totals.thisWeek > 0 ? formatTokens(totals.thisWeek) : '—'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs" style={{ color: 'var(--accent-purple)' }}>
                    {totals.thisMonth > 0 ? formatTokens(totals.thisMonth) : '—'}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* システムアラート */}
      <div className="glass-card p-5">
        <h2 className="text-sm font-bold mb-3" style={{ color: 'var(--text-secondary)' }}>システム状況</h2>
        <div className="space-y-2">
          {alerts.map((a, i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2 rounded-lg" style={{
              background: a.level === 'error' ? 'rgba(244,63,94,0.08)' :
                          a.level === 'warning' ? 'rgba(245,158,11,0.08)' :
                          'rgba(34,197,94,0.08)',
            }}>
              <span className="text-sm mt-0.5">
                {a.level === 'error' ? '🔴' : a.level === 'warning' ? '🟡' : '🟢'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs" style={{
                  color: a.level === 'error' ? 'var(--accent-pink)' :
                         a.level === 'warning' ? 'var(--accent-amber)' :
                         'var(--accent-green)',
                }}>
                  {a.message}
                </p>
              </div>
              <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                {new Date(a.time).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 売上サマリーカード */
function SummaryCard({ label, tokens, coinRate, accent }: {
  label: string;
  tokens: number;
  coinRate: number;
  accent: string;
}) {
  return (
    <div className="glass-card p-5 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-0.5" style={{ background: accent }} />
      <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-2xl font-bold font-mono" style={{ color: accent }}>
        {tokens > 0 ? tokens.toLocaleString() : '0'}
        <span className="text-sm font-normal ml-1" style={{ color: 'var(--text-muted)' }}>tk</span>
      </p>
      <p className="text-sm font-mono mt-1" style={{ color: 'var(--text-secondary)' }}>
        {tokensToJPY(tokens, coinRate)}
      </p>
    </div>
  );
}
