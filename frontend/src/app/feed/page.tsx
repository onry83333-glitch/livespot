'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import type { Account } from '@/types';

/* ============================================================
   Types
   ============================================================ */
interface FeedPost {
  id: string;
  cast_name: string;
  post_type: string;
  content: string | null;
  media_url: string | null;
  likes_count: number;
  comments_count: number;
  posted_at: string;
}

interface WeeklyCount {
  week: string;
  count: number;
}

interface TypeCount {
  type: string;
  count: number;
}

interface FeedAnalytics {
  weekly: WeeklyCount[];
  by_type: TypeCount[];
  recent: FeedPost[];
  correlation: {
    post_id: string;
    post_date: string;
    post_type: string;
    next_session_viewers: number | null;
    next_session_coins: number | null;
    next_session_date: string | null;
  }[];
  total_posts: number;
}

const TYPE_ICON: Record<string, string> = {
  text: '\ud83d\udcdd',
  image: '\ud83d\uddbc\ufe0f',
  video: '\ud83c\udfac',
};

const TYPE_LABEL: Record<string, string> = {
  text: '\u30c6\u30ad\u30b9\u30c8',
  image: '\u753b\u50cf',
  video: '\u52d5\u753b',
};

/* ============================================================
   Page
   ============================================================ */
export default function FeedPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [tab, setTab] = useState<'posts' | 'analytics'>('posts');

  // Posts tab state
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);

  // Modal form state
  const [formType, setFormType] = useState<'text' | 'image' | 'video'>('text');
  const [formContent, setFormContent] = useState('');
  const [formMediaUrl, setFormMediaUrl] = useState('');
  const [formCastName, setFormCastName] = useState('');
  const [formPostedAt, setFormPostedAt] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  // Analytics tab state
  const [analytics, setAnalytics] = useState<FeedAnalytics | null>(null);
  const [analyticsDays, setAnalyticsDays] = useState(30);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  // ============================================================
  // Load accounts
  // ============================================================
  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts')
      .select('id, account_name, is_active, cast_usernames, coin_rate, created_at')
      .order('created_at')
      .then(({ data }) => {
        const accs = (data ?? []) as Account[];
        setAccounts(accs);
        if (accs.length > 0) {
          setSelectedAccount(accs[0].id);
          setFormCastName(accs[0].cast_usernames?.[0] ?? '');
        }
      });
  }, [user]);

  // ============================================================
  // Load posts
  // ============================================================
  const loadPosts = useCallback(async () => {
    if (!selectedAccount) return;
    setPostsLoading(true);
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from('feed_posts')
        .select('*')
        .eq('account_id', selectedAccount)
        .order('posted_at', { ascending: false })
        .limit(100);
      setPosts(data ?? []);
    } catch (e) {
      // error handled silently
    } finally {
      setPostsLoading(false);
    }
  }, [selectedAccount]);

  useEffect(() => {
    if (tab === 'posts') loadPosts();
  }, [selectedAccount, tab, loadPosts]);

  // ============================================================
  // Load analytics
  // ============================================================
  const loadAnalytics = useCallback(async () => {
    if (!selectedAccount) return;
    setAnalyticsLoading(true);
    try {
      const supabase = createClient();
      const since = new Date(Date.now() - analyticsDays * 86400000).toISOString();
      const { data } = await supabase
        .from('feed_posts')
        .select('*')
        .eq('account_id', selectedAccount)
        .gte('posted_at', since)
        .order('posted_at', { ascending: false });
      // Simple analytics from raw data
      const posts = data ?? [];
      const byType: Record<string, number> = {};
      posts.forEach(p => { byType[p.post_type] = (byType[p.post_type] || 0) + 1; });
      setAnalytics({
        weekly: [],
        by_type: Object.entries(byType).map(([type, count]) => ({ type, count })),
        recent: posts.slice(0, 10),
        correlation: [],
        total_posts: posts.length,
      });
    } catch (e) {
      // error handled silently
    } finally {
      setAnalyticsLoading(false);
    }
  }, [selectedAccount, analyticsDays]);

  useEffect(() => {
    if (tab === 'analytics') loadAnalytics();
  }, [selectedAccount, tab, analyticsDays, loadAnalytics]);

  // ============================================================
  // Create post
  // ============================================================
  const handleCreatePost = async () => {
    if (!selectedAccount) return;
    setFormSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from('feed_posts').insert({
        account_id: selectedAccount,
        cast_name: formCastName,
        post_type: formType,
        content: formContent || null,
        media_url: formMediaUrl || null,
        posted_at: new Date(formPostedAt).toISOString(),
      });
      if (error) throw error;
      setShowModal(false);
      resetForm();
      loadPosts();
    } catch (e) {
      // error handled silently
    } finally {
      setFormSaving(false);
    }
  };

  const resetForm = () => {
    setFormType('text');
    setFormContent('');
    setFormMediaUrl('');
    setFormPostedAt(toLocalDatetime(new Date()));
  };

  const openModal = () => {
    const acc = accounts.find(a => a.id === selectedAccount);
    setFormCastName(acc?.cast_usernames?.[0] ?? '');
    setFormPostedAt(toLocalDatetime(new Date()));
    setShowModal(true);
  };

  // ============================================================
  // Helpers
  // ============================================================
  const fmtJST = (d: string) =>
    new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (!user) return null;

  // Analytics computed values
  const thisWeekPosts = (() => {
    if (!analytics) return 0;
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay() + 1); // Monday
    weekStart.setHours(0, 0, 0, 0);
    const weekKey = weekStart.toISOString().slice(0, 10);
    return analytics.weekly.find(w => w.week === weekKey)?.count ?? 0;
  })();

  const avgLikes = (() => {
    if (!analytics || analytics.total_posts === 0) return 0;
    const totalLikes = analytics.recent.reduce((s, p) => s + (p.likes_count ?? 0), 0);
    return analytics.recent.length > 0 ? Math.round(totalLikes / analytics.recent.length) : 0;
  })();

  const maxWeekly = Math.max(...(analytics?.weekly.map(w => w.count) ?? [0]), 1);

  const typeCount = (t: string) => analytics?.by_type.find(b => b.type === t)?.count ?? 0;

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-4 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            {'\ud83d\udcdd'} \u30d5\u30a3\u30fc\u30c9\u7ba1\u7406
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            SNS\u30d5\u30a3\u30fc\u30c9\u6295\u7a3f\u306e\u8a18\u9332\u30fb\u5206\u6790
          </p>
        </div>
        <div className="flex items-center gap-3">
          {accounts.length > 1 && (
            <select
              value={selectedAccount}
              onChange={e => setSelectedAccount(e.target.value)}
              className="input-glass text-xs py-1.5 px-3 w-48"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.account_name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Tab Switch */}
      <div className="flex gap-1 flex-shrink-0">
        {([
          { key: 'posts' as const, label: '\u6295\u7a3f\u4e00\u89a7' },
          { key: 'analytics' as const, label: '\u5206\u6790' },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 rounded-lg text-xs font-medium transition-all ${
              tab === t.key
                ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ============ Posts Tab ============ */}
      {tab === 'posts' && (
        <div className="flex-1 overflow-auto space-y-3 pr-1">
          {/* Add button */}
          <div className="flex justify-end">
            <button
              onClick={openModal}
              className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg transition-all hover:brightness-125"
              style={{
                background: 'rgba(34,197,94,0.15)',
                color: '#22c55e',
                border: '1px solid rgba(34,197,94,0.25)',
              }}
            >
              + \u6295\u7a3f\u3092\u8a18\u9332
            </button>
          </div>

          {postsLoading && (
            <div className="flex items-center justify-center py-16">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>\u8aad\u307f\u8fbc\u307f\u4e2d...</p>
            </div>
          )}

          {!postsLoading && posts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <p className="text-2xl">{'\ud83d\udcdd'}</p>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                \u307e\u3060\u6295\u7a3f\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u300c+ \u6295\u7a3f\u3092\u8a18\u9332\u300d\u304b\u3089\u59cb\u3081\u307e\u3057\u3087\u3046
              </p>
            </div>
          )}

          {!postsLoading && posts.map(p => (
            <div key={p.id} className="glass-card p-4 flex items-start gap-4">
              {/* Type icon */}
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
                style={{ background: 'rgba(56,189,248,0.08)' }}
              >
                {TYPE_ICON[p.post_type] ?? '\ud83d\udcdd'}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-semibold">{p.cast_name}</span>
                  <span
                    className="text-[10px] px-2 py-0.5 rounded-md font-medium"
                    style={{
                      background: p.post_type === 'video' ? 'rgba(168,85,247,0.12)' :
                                  p.post_type === 'image' ? 'rgba(56,189,248,0.12)' :
                                  'rgba(100,116,139,0.12)',
                      color: p.post_type === 'video' ? '#a855f7' :
                             p.post_type === 'image' ? '#38bdf8' :
                             'var(--text-secondary)',
                    }}
                  >
                    {TYPE_LABEL[p.post_type] ?? p.post_type}
                  </span>
                </div>

                {p.content && (
                  <p className="text-xs leading-relaxed mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {p.content.length > 100 ? p.content.slice(0, 100) + '\u2026' : p.content}
                  </p>
                )}

                {p.media_url && (
                  <p className="text-[10px] mb-1.5 truncate" style={{ color: 'var(--accent-primary)' }}>
                    {'\ud83d\udd17'} {p.media_url}
                  </p>
                )}

                <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <span>{fmtJST(p.posted_at)}</span>
                  <span style={{ color: '#f43f5e' }}>{'\u2764\ufe0f'} {p.likes_count ?? 0}</span>
                  <span style={{ color: '#38bdf8' }}>{'\ud83d\udcac'} {p.comments_count ?? 0}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============ Analytics Tab ============ */}
      {tab === 'analytics' && (
        <div className="flex-1 overflow-auto space-y-4 pr-1">
          {/* Period selector */}
          <div className="flex gap-1">
            {[7, 14, 30].map(d => (
              <button
                key={d}
                onClick={() => setAnalyticsDays(d)}
                className={`text-[11px] px-3 py-1.5 rounded-lg transition-all ${
                  analyticsDays === d
                    ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {d}\u65e5
              </button>
            ))}
          </div>

          {analyticsLoading && (
            <div className="flex items-center justify-center py-16">
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>\u8aad\u307f\u8fbc\u307f\u4e2d...</p>
            </div>
          )}

          {!analyticsLoading && analytics && (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-3 gap-3">
                <StatCard label="\u5408\u8a08\u6295\u7a3f\u6570" value={analytics.total_posts} color="var(--accent-primary)" />
                <StatCard label="\u4eca\u9031\u306e\u6295\u7a3f" value={thisWeekPosts} color="var(--accent-green)" />
                <StatCard label="\u5e73\u5747\u3044\u3044\u306d\u6570" value={avgLikes} color="#f43f5e" />
              </div>

              {/* Weekly bar chart */}
              <div className="glass-card p-5">
                <h3 className="text-xs font-bold mb-4">\u9031\u5225\u6295\u7a3f\u6570</h3>
                {analytics.weekly.length === 0 ? (
                  <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>\u30c7\u30fc\u30bf\u306a\u3057</p>
                ) : (
                  <div className="flex items-end gap-2" style={{ height: 120 }}>
                    {analytics.weekly.map(w => (
                      <div key={w.week} className="flex-1 flex flex-col items-center gap-1">
                        <span className="text-[10px] tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                          {w.count}
                        </span>
                        <div
                          className="w-full rounded-t-md transition-all"
                          style={{
                            height: `${(w.count / maxWeekly) * 80}px`,
                            minHeight: w.count > 0 ? 4 : 0,
                            background: 'linear-gradient(180deg, rgba(56,189,248,0.6), rgba(56,189,248,0.2))',
                          }}
                        />
                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                          {w.week.slice(5)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Post type breakdown */}
              <div className="grid grid-cols-3 gap-3">
                {(['text', 'image', 'video'] as const).map(t => (
                  <div key={t} className="glass-card p-4 text-center">
                    <div className="text-2xl mb-2">{TYPE_ICON[t]}</div>
                    <div className="text-lg font-bold tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                      {typeCount(t)}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {TYPE_LABEL[t]}
                    </div>
                  </div>
                ))}
              </div>

              {/* Correlation: post vs next session */}
              {analytics.correlation.length > 0 && (
                <div className="glass-card p-5">
                  <h3 className="text-xs font-bold mb-3">\u6295\u7a3f\u2192\u6b21\u30bb\u30c3\u30b7\u30e7\u30f3 \u76f8\u95a2</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr style={{ color: 'var(--text-muted)' }}>
                          <th className="text-left py-2 font-medium">\u6295\u7a3f\u65e5</th>
                          <th className="text-left py-2 font-medium">\u30bf\u30a4\u30d7</th>
                          <th className="text-right py-2 font-medium">\u6b21\u30bb\u30c3\u30b7\u30e7\u30f3\u8996\u8074\u8005</th>
                          <th className="text-right py-2 font-medium">\u6b21\u30bb\u30c3\u30b7\u30e7\u30f3\u30b3\u30a4\u30f3</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analytics.correlation.slice(0, 20).map((c, i) => (
                          <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                            <td className="py-2">{c.post_date}</td>
                            <td className="py-2">{TYPE_ICON[c.post_type] ?? ''} {TYPE_LABEL[c.post_type] ?? c.post_type}</td>
                            <td className="py-2 text-right tabular-nums" style={{ color: 'var(--accent-primary)' }}>
                              {c.next_session_viewers != null ? c.next_session_viewers.toLocaleString() : '-'}
                            </td>
                            <td className="py-2 text-right tabular-nums" style={{ color: 'var(--accent-amber, #f59e0b)' }}>
                              {c.next_session_coins != null ? c.next_session_coins.toLocaleString() : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ============ Create Post Modal ============ */}
      {showModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowModal(false)}
        >
          <div
            className="glass-card p-6 w-full max-w-md space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold">\u6295\u7a3f\u3092\u8a18\u9332</h3>

            {/* post_type radio */}
            <div>
              <label className="text-[11px] mb-1.5 block" style={{ color: 'var(--text-muted)' }}>\u6295\u7a3f\u30bf\u30a4\u30d7</label>
              <div className="flex gap-2">
                {(['text', 'image', 'video'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFormType(t)}
                    className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg transition-all ${
                      formType === t
                        ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    {TYPE_ICON[t]} {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>

            {/* cast_name */}
            <div>
              <label className="text-[11px] mb-1.5 block" style={{ color: 'var(--text-muted)' }}>\u30ad\u30e3\u30b9\u30c8\u540d</label>
              <input
                type="text"
                value={formCastName}
                onChange={e => setFormCastName(e.target.value)}
                className="input-glass text-xs w-full py-2 px-3"
                placeholder="\u30ad\u30e3\u30b9\u30c8\u540d"
              />
            </div>

            {/* content */}
            <div>
              <label className="text-[11px] mb-1.5 block" style={{ color: 'var(--text-muted)' }}>\u5185\u5bb9</label>
              <textarea
                rows={3}
                value={formContent}
                onChange={e => setFormContent(e.target.value)}
                className="input-glass text-xs w-full py-2 px-3 resize-none"
                placeholder="\u6295\u7a3f\u5185\u5bb9\u3092\u5165\u529b..."
              />
            </div>

            {/* media_url */}
            <div>
              <label className="text-[11px] mb-1.5 block" style={{ color: 'var(--text-muted)' }}>\u30e1\u30c7\u30a3\u30a2URL\uff08\u4efb\u610f\uff09</label>
              <input
                type="text"
                value={formMediaUrl}
                onChange={e => setFormMediaUrl(e.target.value)}
                className="input-glass text-xs w-full py-2 px-3"
                placeholder="https://..."
              />
            </div>

            {/* posted_at */}
            <div>
              <label className="text-[11px] mb-1.5 block" style={{ color: 'var(--text-muted)' }}>\u6295\u7a3f\u65e5\u6642</label>
              <input
                type="datetime-local"
                value={formPostedAt}
                onChange={e => setFormPostedAt(e.target.value)}
                className="input-glass text-xs w-full py-2 px-3"
              />
            </div>

            {/* Buttons */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="text-xs px-4 py-2 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
              >
                \u30ad\u30e3\u30f3\u30bb\u30eb
              </button>
              <button
                type="button"
                onClick={handleCreatePost}
                disabled={formSaving || !formCastName}
                className="text-xs font-semibold px-4 py-2 rounded-lg transition-all hover:brightness-125 disabled:opacity-50"
                style={{
                  background: 'rgba(34,197,94,0.15)',
                  color: '#22c55e',
                  border: '1px solid rgba(34,197,94,0.25)',
                }}
              >
                {formSaving ? '\u4fdd\u5b58\u4e2d...' : '\u4fdd\u5b58'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Sub-components
   ============================================================ */
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="glass-card p-4">
      <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-xl font-bold tabular-nums" style={{ color }}>{value.toLocaleString()}</p>
    </div>
  );
}

/* ============================================================
   Utils
   ============================================================ */
function toLocalDatetime(d: Date): string {
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}
