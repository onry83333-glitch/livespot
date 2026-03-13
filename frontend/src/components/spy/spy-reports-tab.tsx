'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

export default function SpyReportsTab() {
  const { user } = useAuth();
  const [reports, setReports] = useState<{
    id: string; account_id: string; session_id: string | null; cast_name: string | null;
    report_type: string; output_text: string; model: string; tokens_used: number; cost_usd: number; created_at: string;
  }[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    supabase.from('accounts').select('id').limit(1).single().then(async ({ data }) => {
      if (!data) { setLoading(false); return; }

      const { data: reportData } = await supabase.from('ai_reports')
        .select('*')
        .eq('account_id', data.id)
        .eq('report_type', 'session_analysis')
        .order('created_at', { ascending: false })
        .limit(100);

      if (reportData) setReports(reportData);
      setLoading(false);
    });
  }, [user]);

  if (loading) return <div className="glass-card p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>読み込み中...</div>;

  const fmtDate = (d: string) =>
    new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex-1 overflow-auto space-y-3">
      <div className="glass-card p-4">
        <h3 className="text-xs font-bold mb-1" style={{ color: '#f59e0b' }}>🤖 FBレポート</h3>
        <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>自社キャストの配信セッションAI分析レポート</p>
      </div>

      {reports.length === 0 ? (
        <div className="glass-card p-10 text-center">
          <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>AIレポートがありません</p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            配信セッションページで「AIレポート生成」ボタンを押すと、AI分析レポートが作成されます。
          </p>
          <Link href="/reports" className="inline-block mt-4 text-[11px] px-4 py-2 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' }}>
            レポートページへ →
          </Link>
        </div>
      ) : (
        reports.map(report => {
          const isExpanded = expandedId === report.id;
          const preview = report.output_text.slice(0, 200).replace(/\n/g, ' ');

          return (
            <div key={report.id} className="glass-card overflow-hidden">
              <button
                onClick={() => setExpandedId(isExpanded ? null : report.id)}
                className="w-full text-left p-5 transition-all duration-200 hover:bg-white/[0.02]"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-base">🤖</span>
                    <h3 className="text-sm font-bold">
                      {report.cast_name || report.session_id?.slice(0, 8) || 'レポート'}
                    </h3>
                  </div>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {isExpanded ? '▲ 閉じる' : '▼ 展開'}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                  <span>生成: {fmtDate(report.created_at)}</span>
                  <span>Tokens: {(report.tokens_used ?? 0).toLocaleString()}</span>
                  <span>Cost: ${report.cost_usd.toFixed(4)}</span>
                </div>
                {!isExpanded && (
                  <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{preview}...</p>
                )}
              </button>
              {isExpanded && (
                <div className="px-5 pb-5 border-t" style={{ borderColor: 'var(--border-glass)' }}>
                  <div className="pt-4 text-xs leading-relaxed space-y-3" style={{ color: 'var(--text-secondary)' }}>
                    {report.output_text.split('\n').map((line, li) => {
                      if (line.startsWith('## ')) return <h5 key={li} className="text-sm font-bold mt-4 mb-1" style={{ color: 'var(--text-primary)' }}>{line.replace('## ', '')}</h5>;
                      if (line.startsWith('### ')) return <h6 key={li} className="text-xs font-bold mt-3 mb-1" style={{ color: '#f59e0b' }}>{line.replace('### ', '')}</h6>;
                      if (line.startsWith('- ')) return <p key={li} className="pl-3" style={{ borderLeft: '2px solid rgba(245,158,11,0.3)' }}>{line.replace('- ', '')}</p>;
                      if (line.startsWith('**') && line.endsWith('**')) return <p key={li} className="font-semibold" style={{ color: 'var(--text-primary)' }}>{line.replace(/\*\*/g, '')}</p>;
                      if (line.trim() === '') return <div key={li} className="h-1" />;
                      return <p key={li}>{line}</p>;
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
