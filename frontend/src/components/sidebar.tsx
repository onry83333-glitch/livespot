'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';

const navItems = [
  { href: '/',          icon: '⚡', label: 'コントロールセンター' },
  { href: '/spy',       icon: '👁', label: 'リアルタイム運営' },
  { href: '/alerts',    icon: '🔔', label: '入室アラート' },
  { href: '/dm',        icon: '💬', label: 'DM一斉送信' },
  { href: '/sessions',  icon: '📺', label: '配信セッション' },
  { href: '/users',     icon: '👥', label: 'ユーザー管理' },
  { href: '/analytics', icon: '📊', label: '分析&スコアリング' },
  { href: '/reports',   icon: '🤖', label: 'AIレポート' },
  { href: '/feed',      icon: '📝', label: 'フィード管理' },
  { href: '/settings',  icon: '⚙️', label: '管理&セキュリティ' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-[220px] flex flex-col border-r z-50"
      style={{
        background: 'linear-gradient(180deg, rgba(10,15,30,0.97) 0%, rgba(5,10,20,0.99) 100%)',
        borderColor: 'var(--border-glass)',
      }}
    >
      {/* Logo */}
      <div className="px-5 py-6">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-purple))' }}>
            🌐
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight" style={{ color: 'var(--accent-primary)' }}>
              LiveSpot
            </h1>
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: 'var(--accent-green)' }}>
              PREMIUM AGENCY
            </p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-1">
        {navItems.map(item => {
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link key={item.href} href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
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
              <span className="text-base w-5 text-center">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
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
        <button className="btn-go-live flex items-center justify-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white anim-live"></span>
          GO LIVE
        </button>
      </div>
    </aside>
  );
}
