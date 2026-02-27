'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { useState, useEffect, Suspense } from 'react';
import { createClient } from '@/lib/supabase/client';

interface NavItem {
  href: string;
  icon: string;
  label: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: '',
    items: [
      { href: '/casts',   icon: '👤', label: 'キャスト' },
      { href: '/spy',     icon: '🔍', label: 'SPY' },
      { href: '/alerts',  icon: '🔔', label: 'アラート' },
    ],
  },
];

const castTabs = [
  { tab: 'overview',  icon: '📊', label: '概要' },
  { tab: 'sessions',  icon: '📺', label: '配信' },
  { tab: 'broadcast', icon: '📡', label: '配信分析' },
  { tab: 'dm',        icon: '💬', label: 'DM' },
  { tab: 'analytics', icon: '📈', label: '分析' },
  { tab: 'sales',     icon: '💰', label: '売上' },
  { tab: 'realtime',  icon: '👁', label: 'リアルタイム' },
  { tab: 'persona',   icon: '🎭', label: 'ペルソナ' },
  { tab: 'overlap',   icon: '🔄', label: '競合分析' },
];

const spyTabs = [
  { tab: 'overview',  icon: '📊', label: '概要' },
  { tab: 'sessions',  icon: '📺', label: '配信ログ' },
  { tab: 'users',     icon: '👥', label: 'ユーザー分析' },
  { tab: 'format',    icon: '📋', label: 'フォーマット' },
];

function SidebarInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, signOut } = useAuth();

  // キャスト個別ページかどうかを判定
  const castMatch = pathname.match(/^\/casts\/([^/]+)$/);
  const activeCastName = castMatch ? decodeURIComponent(castMatch[1]) : null;
  const activeTab = searchParams.get('tab') || 'overview';

  // スパイキャスト個別ページかどうかを判定
  const spyMatch = pathname.match(/^\/spy\/([^/]+)$/);
  const activeSpyCastName = spyMatch && spyMatch[1] !== 'users' ? decodeURIComponent(spyMatch[1]) : null;
  const activeSpyTab = searchParams.get('tab') || 'overview';

  // キャストの表示名を取得
  const [castDisplayName, setCastDisplayName] = useState<string | null>(null);
  const [spyCastDisplayName, setSpyCastDisplayName] = useState<string | null>(null);

  useEffect(() => {
    if (!activeCastName) { setCastDisplayName(null); return; }
    const supabase = createClient();
    supabase
      .from('registered_casts')
      .select('display_name')
      .eq('cast_name', activeCastName)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        setCastDisplayName(data?.display_name || null);
      });
  }, [activeCastName]);

  useEffect(() => {
    if (!activeSpyCastName) { setSpyCastDisplayName(null); return; }
    const supabase = createClient();
    supabase
      .from('spy_casts')
      .select('display_name')
      .eq('cast_name', activeSpyCastName)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        setSpyCastDisplayName(data?.display_name || null);
      });
  }, [activeSpyCastName]);

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-[220px] flex flex-col border-r z-50"
      style={{
        background: 'linear-gradient(180deg, rgba(10,15,30,0.97) 0%, rgba(5,10,20,0.99) 100%)',
        borderColor: 'var(--border-glass)',
      }}
    >
      {/* Logo */}
      <div className="px-5 py-5">
        <Link href="/casts" className="flex items-center gap-2.5 group">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}>
            🌐
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight group-hover:opacity-80 transition-opacity" style={{ color: 'var(--accent-primary)' }}>
              Strip Live Spot
            </h1>
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: 'var(--accent-green)' }}>
              PREMIUM AGENCY
            </p>
          </div>
        </Link>
      </div>

      {/* Nav Sections */}
      <nav className="flex-1 px-3 space-y-4 overflow-auto">
        {navSections.map((section, idx) => (
          <div key={section.title || `section-${idx}`}>
            {idx > 0 && <div className="border-t my-2 mx-3" style={{ borderColor: 'var(--border-glass)' }} />}
            {section.title && (
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] px-3 mb-1.5"
                style={{ color: 'var(--text-muted)' }}>
                {section.title}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map(item => {
                const isActive = item.href === '/'
                  ? pathname === '/'
                  : pathname === item.href || pathname.startsWith(item.href + '/');
                return (
                  <Link key={item.href} href={item.href}
                    className={`flex items-center gap-3 px-3 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 ${
                      isActive
                        ? 'text-white'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
                    }`}
                    style={isActive ? {
                      background: 'linear-gradient(135deg, rgba(56,189,248,0.15), rgba(56,189,248,0.05))',
                      borderLeft: '2px solid var(--accent-primary)',
                      boxShadow: 'var(--glow-blue)',
                    } : {}}
                  >
                    <span className="text-sm w-5 text-center">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>

            {/* Spy submenu: SPYキャスト個別ページで表示 */}
            {section.title === '' && activeSpyCastName && (
              <div className="mt-2 ml-2 pl-3 border-l" style={{ borderColor: 'rgba(56,189,248,0.15)' }}>
                <Link href="/spy"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03] transition-all mb-1"
                >
                  <span className="text-[10px]">←</span>
                  <span>戻る</span>
                </Link>
                <div className="px-2 py-1.5 mb-1">
                  <p className="text-[12px] font-bold text-white truncate">
                    🔍 {activeSpyCastName}
                  </p>
                  {spyCastDisplayName && (
                    <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {spyCastDisplayName}
                    </p>
                  )}
                </div>
                <div className="space-y-0.5">
                  {spyTabs.map(t => {
                    const isTabActive = activeSpyTab === t.tab;
                    const href = `/spy/${encodeURIComponent(activeSpyCastName)}?tab=${t.tab}`;
                    return (
                      <Link key={t.tab} href={href}
                        className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-200 ${
                          isTabActive ? 'text-white' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
                        }`}
                        style={isTabActive ? { background: 'rgba(56,189,248,0.1)', color: 'var(--accent-primary)' } : {}}
                      >
                        <span className="text-[10px] w-4 text-center">{t.icon}</span>
                        <span>{t.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Cast submenu: キャスト一覧セクションの直後に表示 */}
            {section.title === '' && activeCastName && (
              <div className="mt-2 ml-2 pl-3 border-l" style={{ borderColor: 'rgba(56,189,248,0.15)' }}>
                {/* Back link */}
                <Link href="/casts"
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[11px] text-slate-400 hover:text-slate-200 hover:bg-white/[0.03] transition-all mb-1"
                >
                  <span className="text-[10px]">←</span>
                  <span>戻る</span>
                </Link>

                {/* Cast name header */}
                <div className="px-2 py-1.5 mb-1">
                  <p className="text-[12px] font-bold text-white truncate">
                    🎭 {activeCastName}
                  </p>
                  {castDisplayName && (
                    <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                      {castDisplayName}
                    </p>
                  )}
                </div>

                {/* Tab links */}
                <div className="space-y-0.5">
                  {castTabs.map(t => {
                    const isTabActive = activeTab === t.tab;
                    const href = `/casts/${encodeURIComponent(activeCastName)}?tab=${t.tab}`;
                    return (
                      <Link key={t.tab} href={href}
                        className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-200 ${
                          isTabActive
                            ? 'text-white'
                            : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]'
                        }`}
                        style={isTabActive ? {
                          background: 'rgba(56,189,248,0.1)',
                          color: 'var(--accent-primary)',
                        } : {}}
                      >
                        <span className="text-[10px] w-4 text-center">{t.icon}</span>
                        <span>{t.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* User & Go Live */}
      <div className="p-4 space-y-3">
        <div className="glass-panel px-3 py-2.5 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}>
            {user?.email?.charAt(0).toUpperCase() ?? 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">{user?.email ?? ''}</p>
            <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>ログイン中</p>
          </div>
          <button
            onClick={signOut}
            title="ログアウト"
            className="text-slate-500 hover:text-rose-400 transition-colors text-sm"
          >
            ↩
          </button>
        </div>
      </div>
    </aside>
  );
}

export function Sidebar() {
  return (
    <Suspense fallback={null}>
      <SidebarInner />
    </Suspense>
  );
}
