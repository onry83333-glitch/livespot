'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import { formatTokens, tokensToJPY } from '@/lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from 'recharts';

/* ============================================================
   Types
   ============================================================ */
interface CastStats {
  castName: string;
  color: string;
  totalMessages: number;
  totalTips: number;
  uniqueUsers: number;
  avgChatSpeed: number; // msg/min
  sessionCount: number;
  tipMessages: number;
}

type Period = 'today' | '7d' | '30d' | 'all';

const CAST_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];

/* ============================================================
   Page
   ============================================================ */
export default function CastComparePage() {
  const { user } = useAuth();
  const router = useRouter();
  const supabaseRef = useRef(createClient());
  const sb = supabaseRef.current;

  const [accountId, setAccountId] = useState<string | null>(null);
  const [allCasts, setAllCasts] = useState<string[]>([]);
  const [selectedCasts, setSelectedCasts] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>('7d');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [castStats, setCastStats] = useState<CastStats[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);

  // アカウントID取得
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { data } = await sb.from('accounts').select('id').limit(1).single();
        if (data) setAccountId(data.id);
      } catch { /* ignored */ }
    })();
  }, [user, sb]);

  // キャスト一覧取得
  useEffect(() => {
    if (!accountId) return;
    (async () => {
      try {
        const { data, error: fetchErr } = await sb
          .from('spy_messages')
          .select('cast_name')
          .eq('account_id', accountId)
          .filter('cast_name', 'not.is', null);

        if (fetchErr) throw new Error(fetchErr.message);
        if (data) {
          const unique = Array.from(new Set(data.map(r => r.cast_name as string))).sort();
          setAllCasts(unique);
          if (unique.length >= 2) {
            setSelectedCasts(unique.slice(0, 2));
          } else if (unique.length === 1) {
            setSelectedCasts([unique[0]]);
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'キャスト一覧の取得に失敗しました');
      } finally {
        setInitialLoading(false);
      }
    })();
  }, [accountId, sb]);

  // 期間のstartDate計算
  const startDate = useMemo(() => {
    const now = new Date();
    switch (period) {
      case 'today': {
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        return d.toISOString();
      }
      case '7d': return new Date(now.getTime() - 7 * 86400000).toISOString();
      case '30d': return new Date(now.getTime() - 30 * 86400000).toISOString();
      case 'all': return null;
    }
  }, [period]);

  // データ取得（Promise.allで並列化）
  const loadStats = useCallback(async () => {
    if (!accountId || selectedCasts.length === 0) {
      setCastStats([]);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const promises = selectedCasts.map(async (castName, i) => {
        let query = sb
          .from('spy_messages')
          .select('msg_type, user_name, tokens, message_time')
          .eq('account_id', accountId)
          .eq('cast_name', castName);

        if (startDate) {
          query = query.gte('message_time', startDate);
        }

        const { data, error: fetchErr } = await query.order('message_time', { ascending: true });
        if (fetchErr) throw new Error(fetchErr.message);
        const msgs = data || [];

        const totalMessages = msgs.length;
        const totalTips = msgs.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').reduce((s, m) => s + (m.tokens || 0), 0);
        const tipMessages = msgs.filter(m => m.msg_type === 'tip' || m.msg_type === 'gift').length;
        const uniqueUsers = new Set(msgs.filter(m => m.user_name).map(m => m.user_name)).size;

        // 平均チャット速度 (msg/min)
        let avgChatSpeed = 0;
        if (msgs.length > 1) {
          const firstTime = new Date(msgs[0].message_time).getTime();
          const lastTime = new Date(msgs[msgs.length - 1].message_time).getTime();
          const durationMin = (lastTime - firstTime) / 60000;
          avgChatSpeed = durationMin > 0 ? totalMessages / durationMin : 0;
        }

        // セッション数 (30分以上の間隔で分割)
        let sessionCount = msgs.length > 0 ? 1 : 0;
        for (let j = 1; j < msgs.length; j++) {
          const gap = new Date(msgs[j].message_time).getTime() - new Date(msgs[j - 1].message_time).getTime();
          if (gap > 30 * 60 * 1000) sessionCount++;
        }

        return {
          castName,
          color: CAST_COLORS[i % CAST_COLORS.length],
          totalMessages,
          totalTips,
          uniqueUsers,
          avgChatSpeed,
          sessionCount,
          tipMessages,
        } as CastStats;
      });

      const results = await Promise.all(promises);
      setCastStats(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'データ取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, [accountId, selectedCasts, startDate, sb]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // キャスト選択トグル
  const toggleCast = (name: string) => {
    setSelectedCasts(prev => {
      if (prev.includes(name)) {
        return prev.filter(c => c !== name);
      }
      if (prev.length >= 4) return prev;
      return [...prev, name];
    });
  };

  // ============================================================
  // Chart data
  // ============================================================
  const barData = useMemo(() => {
    if (castStats.length === 0) return [];
    return [
      {
        name: 'メッセージ数',
        ...Object.fromEntries(castStats.map(s => [s.castName, s.totalMessages])),
      },
      {
        name: 'チップ (tk)',
        ...Object.fromEntries(castStats.map(s => [s.castName, s.totalTips])),
      },
      {
        name: 'ユニークユーザー',
        ...Object.fromEntries(castStats.map(s => [s.castName, s.uniqueUsers])),
      },
      {
        name: 'セッション数',
        ...Object.fromEntries(castStats.map(s => [s.castName, s.sessionCount])),
      },
    ];
  }, [castStats]);

  const radarData = useMemo(() => {
    if (castStats.length === 0) return [];
    // 正規化: 各指標の最大値を100とする
    const maxMsg = Math.max(...castStats.map(s => s.totalMessages), 1);
    const maxTip = Math.max(...castStats.map(s => s.totalTips), 1);
    const maxUsers = Math.max(...castStats.map(s => s.uniqueUsers), 1);
    const maxSpeed = Math.max(...castStats.map(s => s.avgChatSpeed), 1);
    const maxSessions = Math.max(...castStats.map(s => s.sessionCount), 1);

    return [
      {
        metric: 'メッセージ',
        ...Object.fromEntries(castStats.map(s => [s.castName, Math.round((s.totalMessages / maxMsg) * 100)])),
      },
      {
        metric: 'チップ額',
        ...Object.fromEntries(castStats.map(s => [s.castName, Math.round((s.totalTips / maxTip) * 100)])),
      },
      {
        metric: 'ユーザー数',
        ...Object.fromEntries(castStats.map(s => [s.castName, Math.round((s.uniqueUsers / maxUsers) * 100)])),
      },
      {
        metric: 'チャット速度',
        ...Object.fromEntries(castStats.map(s => [s.castName, Math.round((s.avgChatSpeed / maxSpeed) * 100)])),
      },
      {
        metric: 'セッション',
        ...Object.fromEntries(castStats.map(s => [s.castName, Math.round((s.sessionCount / maxSessions) * 100)])),
      },
    ];
  }, [castStats]);

  if (!user) return null;

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* ヘッダー */}
      <div className="anim-fade-up">
        <button
          onClick={() => router.push('/analytics')}
          className="text-xs flex items-center gap-1 mb-3 transition-colors hover:text-sky-400"
          style={{ color: 'var(--text-muted)' }}
        >
          ← 分析&スコアリングに戻る
        </button>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <span>📊</span> キャスト比較ダッシュボード
        </h1>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          複数キャストのパフォーマンスを横並びで比較
        </p>
      </div>

      {/* コントロールパネル */}
      <div className="glass-card p-5 anim-fade-up delay-1">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* キャスト選択 */}
          <div className="flex-1">
            <label className="text-[10px] block mb-2 font-semibold" style={{ color: 'var(--text-muted)' }}>
              キャスト選択（2〜4名）
            </label>
            {initialLoading ? (
              <div className="flex gap-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-9 w-28 rounded-lg animate-pulse" style={{ background: 'var(--bg-card)' }} />
                ))}
              </div>
            ) : allCasts.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>キャストデータがありません</p>
            ) : (
              <>
                <div className="flex gap-2 flex-wrap">
                  {allCasts.map((name, i) => {
                    const isSelected = selectedCasts.includes(name);
                    const colorIdx = isSelected ? selectedCasts.indexOf(name) : i;
                    const color = CAST_COLORS[colorIdx % CAST_COLORS.length];
                    return (
                      <button
                        key={name}
                        onClick={() => toggleCast(name)}
                        className="text-xs px-3 py-2 rounded-lg transition-all font-medium"
                        style={{
                          background: isSelected ? `${color}20` : 'rgba(100,116,139,0.1)',
                          color: isSelected ? color : 'var(--text-muted)',
                          border: isSelected ? `1px solid ${color}40` : '1px solid transparent',
                        }}
                      >
                        {isSelected && <span className="mr-1.5">✓</span>}
                        {name}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                  最大4キャストまで選択できます
                </p>
              </>
            )}
          </div>

          {/* 期間選択 */}
          <div>
            <label className="text-[10px] block mb-2 font-semibold" style={{ color: 'var(--text-muted)' }}>
              期間
            </label>
            <div className="flex gap-1">
              {([
                { key: 'today', label: '今日' },
                { key: '7d', label: '7日' },
                { key: '30d', label: '30日' },
                { key: 'all', label: '全期間' },
              ] as { key: Period; label: string }[]).map(p => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className="text-[11px] px-3 py-2 rounded-lg transition-all"
                  style={{
                    background: period === p.key ? 'rgba(56,189,248,0.12)' : 'transparent',
                    color: period === p.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                    border: period === p.key ? '1px solid rgba(56,189,248,0.2)' : '1px solid transparent',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="glass-card p-4 anim-fade-up" style={{ borderLeft: '3px solid var(--accent-pink)' }}>
          <p className="text-xs" style={{ color: 'var(--accent-pink)' }}>{error}</p>
        </div>
      )}

      {/* ローディング */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* 選択不足メッセージ */}
      {!loading && selectedCasts.length < 2 && (
        <div className="glass-card p-10 text-center anim-fade-up">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            比較するキャストを2名以上選択してください
          </p>
        </div>
      )}

      {/* 比較結果 */}
      {!loading && castStats.length >= 2 && (
        <>
          {/* 横並びスタッツカード */}
          <div className={`grid gap-4 anim-fade-up delay-2`}
            style={{ gridTemplateColumns: `repeat(${castStats.length}, minmax(0, 1fr))` }}
          >
            {castStats.map(stat => (
              <div key={stat.castName} className="glass-card p-5" style={{ borderTop: `3px solid ${stat.color}` }}>
                <div className="flex items-center gap-2 mb-4">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                    style={{ background: `${stat.color}30`, color: stat.color }}
                  >
                    {stat.castName.charAt(0)}
                  </div>
                  <h3 className="text-sm font-bold truncate">{stat.castName}</h3>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>メッセージ数</span>
                    <span className="font-bold tabular-nums">{stat.totalMessages.toLocaleString()}件</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>チップ額</span>
                    <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                      {formatTokens(stat.totalTips)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>チップ (円)</span>
                    <span className="font-bold tabular-nums" style={{ color: 'var(--accent-green)' }}>
                      {tokensToJPY(stat.totalTips)}
                    </span>
                  </div>
                  <div className="h-px" style={{ background: 'var(--border-glass)' }} />
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>ユニークユーザー</span>
                    <span className="font-bold tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                      {stat.uniqueUsers}名
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>チャット速度</span>
                    <span className="font-bold tabular-nums">
                      {stat.avgChatSpeed.toFixed(1)} msg/min
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>セッション数</span>
                    <span className="font-bold tabular-nums" style={{ color: 'var(--accent-purple)' }}>
                      {stat.sessionCount}回
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span style={{ color: 'var(--text-muted)' }}>チップ/ギフト件数</span>
                    <span className="font-bold tabular-nums" style={{ color: 'var(--accent-amber)' }}>
                      {stat.tipMessages}件
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* チャート */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 anim-fade-up delay-3">
            {/* 棒グラフ */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-bold mb-4">指標別比較</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={barData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fill: '#94a3b8', fontSize: 11 }}
                    axisLine={{ stroke: 'rgba(56,189,248,0.08)' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#94a3b8', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid rgba(56,189,248,0.2)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                    itemStyle={{ color: '#f1f5f9' }}
                    labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: '11px', color: '#94a3b8' }}
                  />
                  {castStats.map(stat => (
                    <Bar
                      key={stat.castName}
                      dataKey={stat.castName}
                      fill={stat.color}
                      radius={[4, 4, 0, 0]}
                      fillOpacity={0.8}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* レーダーチャート */}
            <div className="glass-card p-5">
              <h3 className="text-sm font-bold mb-4">総合力レーダー</h3>
              <ResponsiveContainer width="100%" height={300}>
                <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="75%">
                  <PolarGrid stroke="rgba(56,189,248,0.1)" />
                  <PolarAngleAxis
                    dataKey="metric"
                    tick={{ fill: '#94a3b8', fontSize: 11 }}
                  />
                  <PolarRadiusAxis
                    tick={{ fill: '#475569', fontSize: 9 }}
                    domain={[0, 100]}
                    axisLine={false}
                  />
                  {castStats.map(stat => (
                    <Radar
                      key={stat.castName}
                      name={stat.castName}
                      dataKey={stat.castName}
                      stroke={stat.color}
                      fill={stat.color}
                      fillOpacity={0.15}
                      strokeWidth={2}
                    />
                  ))}
                  <Legend
                    wrapperStyle={{ fontSize: '11px', color: '#94a3b8' }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid rgba(56,189,248,0.2)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                </RadarChart>
              </ResponsiveContainer>
              <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                ※ 各指標の最大値を100として正規化しています
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
