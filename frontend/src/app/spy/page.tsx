'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useSearchParams, useRouter } from 'next/navigation';
import SpyRealtimeTab from '@/components/spy/spy-realtime-tab';
import SpyCastListTab from '@/components/spy/spy-cast-list-tab';
import SpyReportsTab from '@/components/spy/spy-reports-tab';
import SpyCompetitorListTab from '@/components/spy/spy-competitor-list-tab';
import SpyMarketTab from '@/components/spy/spy-market-tab';
import SpyTypeCatalogTab from '@/components/spy/spy-type-catalog-tab';

/* ============================================================
   Types
   ============================================================ */
type MainView = 'own' | 'competitor';
type OwnSubTab = 'realtime' | 'cast-list' | 'reports';
type CompetitorSubTab = 'realtime' | 'cast-list' | 'type-catalog' | 'market';
/* ============================================================
   Main Page
   ============================================================ */
export default function SpyPage() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [openResult, setOpenResult] = useState<string | null>(null);

  const viewParam = searchParams.get('view') as MainView | null;
  const [mainView, setMainView] = useState<MainView>(viewParam === 'own' || viewParam === 'competitor' ? viewParam : 'own');
  const [ownSubTab, setOwnSubTab] = useState<OwnSubTab>('realtime');
  const [competitorSubTab, setCompetitorSubTab] = useState<CompetitorSubTab>('realtime');

  const handleMainViewChange = useCallback((view: MainView) => {
    setMainView(view);
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    router.replace(url.pathname + url.search, { scroll: false });
  }, [router]);

  // Sync from URL on mount
  useEffect(() => {
    if (viewParam === 'own' || viewParam === 'competitor') {
      setMainView(viewParam);
    }
  }, [viewParam]);

  const handleOpenAllTabs = useCallback(() => {
    setOpenResult('Chrome拡張のポップアップ → 「全タブオープン」ボタンを押してください');
    setTimeout(() => setOpenResult(null), 5000);
  }, []);

  if (!user) return null;

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col gap-2 overflow-hidden">
      {/* Main Tab Navigation */}
      <div className="glass-card px-5 py-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          {/* Own Casts Tab */}
          <button
            onClick={() => handleMainViewChange('own')}
            className="px-5 py-2.5 rounded-xl text-xs font-bold transition-all"
            style={{
              background: mainView === 'own'
                ? 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))'
                : 'transparent',
              color: mainView === 'own' ? '#f59e0b' : 'var(--text-muted)',
              border: mainView === 'own'
                ? '1px solid rgba(245,158,11,0.3)'
                : '1px solid transparent',
              boxShadow: mainView === 'own' ? '0 0 12px rgba(245,158,11,0.1)' : 'none',
            }}
          >
            🏠 自社キャスト
          </button>

          {/* Competitor Casts Tab */}
          <button
            onClick={() => handleMainViewChange('competitor')}
            className="px-5 py-2.5 rounded-xl text-xs font-bold transition-all"
            style={{
              background: mainView === 'competitor'
                ? 'linear-gradient(135deg, rgba(6,182,212,0.15), rgba(6,182,212,0.05))'
                : 'transparent',
              color: mainView === 'competitor' ? '#06b6d4' : 'var(--text-muted)',
              border: mainView === 'competitor'
                ? '1px solid rgba(6,182,212,0.3)'
                : '1px solid transparent',
              boxShadow: mainView === 'competitor' ? '0 0 12px rgba(6,182,212,0.1)' : 'none',
            }}
          >
            🔍 他社キャスト
          </button>

          {/* 全タブ一斉オープン */}
          <button
            onClick={handleOpenAllTabs}
            className="ml-auto px-3 py-2 rounded-xl text-[11px] font-bold transition-all flex items-center gap-1.5"
            style={{
              background: 'linear-gradient(135deg, rgba(34,197,94,0.12), rgba(34,197,94,0.04))',
              color: '#22c55e',
              border: '1px solid rgba(34,197,94,0.2)',
            }}
          >
            🖥️ 全タブオープン
          </button>
          {openResult && (
            <span className="text-[10px] font-semibold" style={{ color: 'var(--accent-amber)' }}>{openResult}</span>
          )}
        </div>

        {/* Sub-tab Navigation */}
        <div className="flex items-center gap-1 mt-2">
          {mainView === 'own' ? (
            <>
              {([
                { key: 'realtime' as OwnSubTab,  label: 'リアルタイム', icon: '📡' },
                { key: 'cast-list' as OwnSubTab,  label: 'キャスト一覧', icon: '📋' },
                { key: 'reports' as OwnSubTab,    label: 'FBレポート',  icon: '🤖' },
              ]).map(t => (
                <button
                  key={t.key}
                  onClick={() => setOwnSubTab(t.key)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
                  style={{
                    background: ownSubTab === t.key ? 'rgba(245,158,11,0.10)' : 'transparent',
                    color: ownSubTab === t.key ? '#f59e0b' : 'var(--text-muted)',
                    border: ownSubTab === t.key ? '1px solid rgba(245,158,11,0.2)' : '1px solid transparent',
                  }}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </>
          ) : (
            <>
              {([
                { key: 'realtime' as CompetitorSubTab,          label: 'リアルタイム', icon: '📡' },
                { key: 'cast-list' as CompetitorSubTab,         label: 'キャスト一覧', icon: '📋' },
                { key: 'market' as CompetitorSubTab,            label: 'マーケット分析', icon: '📊' },
                { key: 'type-catalog' as CompetitorSubTab,      label: '型カタログ', icon: '📦' },
              ]).map(t => (
                <button
                  key={t.key}
                  onClick={() => setCompetitorSubTab(t.key)}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all"
                  style={{
                    background: competitorSubTab === t.key ? 'rgba(6,182,212,0.10)' : 'transparent',
                    color: competitorSubTab === t.key ? '#06b6d4' : 'var(--text-muted)',
                    border: competitorSubTab === t.key ? '1px solid rgba(6,182,212,0.2)' : '1px solid transparent',
                  }}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Tab Content */}
      {mainView === 'own' && ownSubTab === 'realtime' && <SpyRealtimeTab castFilter="own" />}
      {mainView === 'own' && ownSubTab === 'cast-list' && <SpyCastListTab />}
      {mainView === 'own' && ownSubTab === 'reports' && <SpyReportsTab />}
      {mainView === 'competitor' && competitorSubTab === 'realtime' && <SpyRealtimeTab castFilter="competitor" />}
      {mainView === 'competitor' && competitorSubTab === 'cast-list' && <SpyCompetitorListTab />}
      {mainView === 'competitor' && competitorSubTab === 'market' && <SpyMarketTab />}
      {mainView === 'competitor' && competitorSubTab === 'type-catalog' && <SpyTypeCatalogTab />}
    </div>
  );
}
