'use client';
import { useState, useEffect, useMemo } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';

interface ActivityCalendarProps {
  accountId: string;
  castName: string;
  sb: SupabaseClient;
}

interface ActivityDay {
  activity_date: string;
  has_session: boolean;
  session_count: number;
  has_dm: boolean;
  dm_count: number;
  has_report: boolean;
  report_count: number;
  has_revenue: boolean;
  revenue_tokens: number;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export default function ActivityCalendar({ accountId, castName, sb }: ActivityCalendarProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-based
  const [data, setData] = useState<ActivityDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<ActivityDay | null>(null);

  useEffect(() => {
    if (!accountId || !castName) return;
    setLoading(true);
    sb.rpc('get_cast_activity_calendar', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_year: year,
      p_month: month,
    }).then(({ data: result }) => {
      setData((result || []) as ActivityDay[]);
      setLoading(false);
    });
  }, [accountId, castName, year, month, sb]);

  const todayStr = useMemo(() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  }, []);

  // Build calendar grid
  const grid = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month, 0).getDate();
    const dayMap = new Map<number, ActivityDay>();
    for (const d of data) {
      const dayNum = new Date(d.activity_date).getDate();
      dayMap.set(dayNum, d);
    }
    const cells: (ActivityDay & { dayNum: number } | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const act = dayMap.get(d);
      cells.push(act ? { ...act, dayNum: d } : {
        dayNum: d,
        activity_date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        has_session: false, session_count: 0,
        has_dm: false, dm_count: 0,
        has_report: false, report_count: 0,
        has_revenue: false, revenue_tokens: 0,
      });
    }
    return cells;
  }, [data, year, month]);

  const goPrev = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const goNext = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };

  return (
    <div className="space-y-4">
      {/* Header: nav + month label */}
      <div className="flex items-center justify-between">
        <button onClick={goPrev} className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-white/[0.05]"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}>◀</button>
        <h3 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
          {year}年{month}月
        </h3>
        <button onClick={goNext} className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:bg-white/[0.05]"
          style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}>▶</button>
      </div>

      {/* Calendar grid */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
        {/* Weekday headers */}
        <div className="grid grid-cols-7" style={{ borderBottom: '1px solid var(--border-primary)' }}>
          {WEEKDAYS.map((w, i) => (
            <div key={w} className="text-center py-2 text-[11px] font-medium"
              style={{ color: i === 0 ? '#ef4444' : i === 6 ? '#38bdf8' : 'var(--text-muted)' }}>
              {w}
            </div>
          ))}
        </div>

        {/* Day cells */}
        {loading ? (
          <div className="h-64 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'transparent' }} />
          </div>
        ) : (
          <div className="grid grid-cols-7">
            {grid.map((cell, i) => {
              if (!cell) {
                return <div key={`empty-${i}`} className="min-h-[72px] p-1" style={{ borderBottom: '1px solid var(--border-primary)', borderRight: i % 7 !== 6 ? '1px solid var(--border-primary)' : undefined }} />;
              }
              const isToday = cell.activity_date === todayStr;
              const hasAny = cell.has_session || cell.has_dm || cell.has_report || cell.has_revenue;
              const dayOfWeek = (new Date(year, month - 1, cell.dayNum).getDay());
              return (
                <div
                  key={cell.dayNum}
                  onClick={() => hasAny && setSelectedDay(cell)}
                  className={`min-h-[72px] p-1.5 transition-colors ${hasAny ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
                  style={{
                    borderBottom: '1px solid var(--border-primary)',
                    borderRight: i % 7 !== 6 ? '1px solid var(--border-primary)' : undefined,
                    background: isToday ? 'rgba(56,189,248,0.08)' : undefined,
                  }}
                >
                  <div className={`text-[11px] font-medium mb-1 ${isToday ? 'text-sky-400' : ''}`}
                    style={{ color: isToday ? '#38bdf8' : dayOfWeek === 0 ? '#ef4444' : dayOfWeek === 6 ? '#38bdf8' : 'var(--text-primary)' }}>
                    {cell.dayNum}
                  </div>
                  <div className="flex flex-wrap gap-0.5 text-[12px] leading-none">
                    {cell.has_session && <span title="配信">🎙️</span>}
                    {cell.has_dm && <span title="DM送信">✉️</span>}
                    {cell.has_report && <span title="レポート">📊</span>}
                    {cell.has_revenue && <span title="売上">💰</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <span>🎙️ 配信</span>
        <span>✉️ DM送信</span>
        <span>📊 レポート</span>
        <span>💰 売上</span>
      </div>

      {/* Detail Modal */}
      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSelectedDay(null)}>
          <div className="rounded-xl p-5 w-[320px] max-w-[90vw] space-y-3"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {(() => {
                  const d = new Date(selectedDay.activity_date);
                  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
                })()}
              </h4>
              <button onClick={() => setSelectedDay(null)} className="text-lg leading-none" style={{ color: 'var(--text-muted)' }}>×</button>
            </div>
            <div className="space-y-2 text-[13px]" style={{ color: 'var(--text-primary)' }}>
              {selectedDay.has_session && (
                <div className="flex items-center gap-2">
                  <span>🎙️</span>
                  <span>配信: {selectedDay.session_count}回</span>
                </div>
              )}
              {selectedDay.has_revenue && (
                <div className="flex items-center gap-2">
                  <span>💰</span>
                  <span>売上: {Number(selectedDay.revenue_tokens).toLocaleString()} tk</span>
                </div>
              )}
              {selectedDay.has_report && (
                <div className="flex items-center gap-2">
                  <span>📊</span>
                  <span>レポート: {selectedDay.report_count}件</span>
                </div>
              )}
              {selectedDay.has_dm && (
                <div className="flex items-center gap-2">
                  <span>✉️</span>
                  <span>DM: {selectedDay.dm_count}件送信</span>
                </div>
              )}
              {!selectedDay.has_session && !selectedDay.has_revenue && !selectedDay.has_report && !selectedDay.has_dm && (
                <p className="text-center py-2" style={{ color: 'var(--text-muted)' }}>アクティビティなし</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
