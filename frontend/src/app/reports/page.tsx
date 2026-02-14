'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { createClient } from '@/lib/supabase/client';

interface Account {
  id: string;
  account_name: string;
}

interface Report {
  id: string;
  account_id: string;
  session_id: string | null;
  cast_name: string | null;
  report_type: string;
  output_text: string;
  model: string;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
}

interface SessionInfo {
  session_id: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  total_coins: number;
  unique_users: number;
}

export default function ReportsPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [reports, setReports] = useState<Report[]>([]);
  const [sessionMap, setSessionMap] = useState<Record<string, SessionInfo>>({});
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Load accounts
  useEffect(() => {
    if (!user) return;
    const sb = createClient();
    sb.from('accounts').select('id, account_name').order('created_at').then(({ data }) => {
      const list = (data || []) as Account[];
      setAccounts(list);
      if (list.length > 0) setSelectedAccount(list[0].id);
    });
  }, [user]);

  // Load reports
  const loadReports = useCallback(async () => {
    if (!selectedAccount) return;
    setLoading(true);

    const sb = createClient();
    const { data } = await sb.from('ai_reports')
      .select('*')
      .eq('account_id', selectedAccount)
      .eq('report_type', 'session_analysis')
      .order('created_at', { ascending: false })
      .limit(30);

    const reps = (data || []) as Report[];
    setReports(reps);

    // Fetch session info for each report
    const sessionIds = Array.from(new Set(
      reps.map(r => r.session_id).filter((id): id is string => id != null)
    ));

    if (sessionIds.length > 0) {
      const { data: sessData } = await sb.from('sessions')
        .select('session_id, title, started_at, ended_at, total_coins, unique_users')
        .in('session_id', sessionIds);

      const map: Record<string, SessionInfo> = {};
      for (const s of (sessData || [])) {
        map[s.session_id] = s as SessionInfo;
      }
      setSessionMap(map);
    }

    setLoading(false);
  }, [selectedAccount]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  if (!user) return null;

  const fmtDate = (d: string) =>
    new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const fmtDateShort = (d: string) =>
    new Date(d).toLocaleString('ja-JP', { timeZone: 'UTC', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="max-w-[1000px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">AIレポート</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            配信セッションのAI分析レポート一覧
          </p>
        </div>
        {accounts.length > 1 && (
          <select
            className="input-glass text-xs px-3 py-2 w-48"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.account_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="glass-card p-6 h-32 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && reports.length === 0 && (
        <div className="glass-card p-10 text-center">
          <p className="text-lg mb-2" style={{ color: 'var(--text-secondary)' }}>
            AIレポートがありません
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            配信セッションページで「AIレポート生成」ボタンを押すと、AI分析レポートが作成されます。
          </p>
        </div>
      )}

      {/* Report List */}
      {!loading && reports.map(report => {
        const isExpanded = expandedId === report.id;
        const sess = report.session_id ? sessionMap[report.session_id] : null;
        const preview = report.output_text.slice(0, 200).replace(/\n/g, ' ');

        return (
          <div key={report.id} className="glass-card overflow-hidden">
            {/* Header */}
            <button
              onClick={() => setExpandedId(isExpanded ? null : report.id)}
              className="w-full text-left p-5 transition-all duration-200 hover:bg-white/[0.02]"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-base">🤖</span>
                  <h3 className="text-sm font-bold">
                    {sess?.title || (sess ? fmtDateShort(sess.started_at) : report.session_id?.slice(0, 8) || 'レポート')}
                  </h3>
                  {report.cast_name && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(168,85,247,0.1)', color: '#a855f7' }}>
                      {report.cast_name}
                    </span>
                  )}
                </div>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {isExpanded ? '▲ 閉じる' : '▼ 展開'}
                </span>
              </div>

              <div className="flex items-center gap-4 text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                <span>生成: {fmtDate(report.created_at)}</span>
                {sess && (
                  <>
                    <span>配信: {fmtDateShort(sess.started_at)}</span>
                    <span>{sess.unique_users}人</span>
                    <span className="text-amber-400">{sess.total_coins.toLocaleString()}c</span>
                  </>
                )}
                <span>Tokens: {report.tokens_used.toLocaleString()}</span>
                <span>Cost: ${report.cost_usd.toFixed(4)}</span>
              </div>

              {!isExpanded && (
                <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                  {preview}...
                </p>
              )}
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div className="px-5 pb-5 border-t" style={{ borderColor: 'var(--border-glass)' }}>
                <div className="pt-4 text-xs leading-relaxed space-y-3" style={{ color: 'var(--text-secondary)' }}>
                  {report.output_text.split('\n').map((line, li) => {
                    if (line.startsWith('## ')) {
                      return (
                        <h5 key={li} className="text-sm font-bold mt-4 mb-1" style={{ color: 'var(--text-primary)' }}>
                          {line.replace('## ', '')}
                        </h5>
                      );
                    }
                    if (line.startsWith('### ')) {
                      return (
                        <h6 key={li} className="text-xs font-bold mt-3 mb-1" style={{ color: '#a855f7' }}>
                          {line.replace('### ', '')}
                        </h6>
                      );
                    }
                    if (line.startsWith('- ')) {
                      return (
                        <p key={li} className="pl-3" style={{ borderLeft: '2px solid rgba(168,85,247,0.3)' }}>
                          {line.replace('- ', '')}
                        </p>
                      );
                    }
                    if (line.startsWith('**') && line.endsWith('**')) {
                      return (
                        <p key={li} className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {line.replace(/\*\*/g, '')}
                        </p>
                      );
                    }
                    if (line.trim() === '') return <div key={li} className="h-1" />;
                    return <p key={li}>{line}</p>;
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
