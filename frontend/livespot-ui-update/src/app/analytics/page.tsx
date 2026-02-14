'use client';
import { useState } from 'react';

const stats = [
  { label: '総売上', value: '¥12,450,000', change: '+12.4%', positive: true, icon: '💰' },
  { label: 'エージェンシー利益', value: '¥3,735,000', change: '+10.2%', positive: true, icon: '📈' },
  { label: 'キャスト総支払額', value: '¥8,715,000', change: '+15.8%', positive: true, icon: '💳' },
];

const castPayroll = [
  { name: '宮崎 さくら', tier: 'PREMIUM CAST', revenue: '¥2,450,000', rate: '30%', payout: '¥1,715,000', adj: '-¥245,000', status: '送金済み', statusColor: '#22c55e' },
  { name: '佐藤 美月', tier: 'Standard', revenue: '¥850,000', rate: '35%', payout: '¥552,500', adj: '-¥85,000', status: '処理中', statusColor: '#38bdf8' },
  { name: '田中 絵里', tier: 'Standard', revenue: '¥1,200,000', rate: '32%', payout: '¥816,000', adj: '-¥120,000', status: '送金済み', statusColor: '#22c55e' },
  { name: '渡辺 凛', tier: 'PREMIUM CAST', revenue: '¥1,980,000', rate: '30%', payout: '¥1,386,000', adj: '-¥198,000', status: '送金済み', statusColor: '#22c55e' },
];

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly'>('monthly');

  return (
    <div className="max-w-[1200px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">💰 給与計算（自動精算）</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            エージェンシー全体の報酬支払い状況と精算管理を行います。
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs flex items-center gap-1.5">≡ フィルター</button>
          <button className="btn-primary text-xs flex items-center gap-1.5">📥 全データPDF書き出し</button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4 anim-fade-up">
        {stats.map((s, i) => (
          <div key={i} className="glass-card p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.label}</p>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                s.positive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
              }`}>{s.change}</span>
            </div>
            <p className="text-3xl font-bold mt-2 tracking-tight" style={{ color: s.positive ? 'var(--accent-green)' : 'var(--text-primary)' }}>
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* Period Toggle + Status */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {(['daily', 'weekly', 'monthly'] as const).map(p => (
            <button key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                period === p ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:text-slate-200'
              }`}>
              {p === 'daily' ? '日次' : p === 'weekly' ? '週次' : '月次'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[10px] flex items-center gap-1.5 text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
            自動計算：完了
          </span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>更新日時: 2023/10/27 14:00</span>
        </div>
      </div>

      {/* Payroll Table */}
      <div className="glass-card p-6 anim-fade-up delay-2">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                <th className="pb-4 font-medium text-xs">キャスト名</th>
                <th className="pb-4 font-medium text-xs">総売上</th>
                <th className="pb-4 font-medium text-xs">紹介料率 (%)</th>
                <th className="pb-4 font-medium text-xs">最終支払額</th>
                <th className="pb-4 font-medium text-xs">源泉徴収・調整</th>
                <th className="pb-4 font-medium text-xs">ステータス</th>
              </tr>
            </thead>
            <tbody>
              {castPayroll.map((c, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                  <td className="py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm"
                        style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.2), rgba(168,85,247,0.2))' }}>
                        {c.name.charAt(0)}
                      </div>
                      <div>
                        <p className="font-semibold">{c.name}</p>
                        <p className={`text-[10px] ${c.tier === 'PREMIUM CAST' ? 'text-amber-400' : ''}`}
                          style={c.tier !== 'PREMIUM CAST' ? { color: 'var(--text-muted)' } : {}}>
                          {c.tier}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 font-semibold text-emerald-400">{c.revenue}</td>
                  <td className="py-4" style={{ color: 'var(--text-secondary)' }}>{c.rate}</td>
                  <td className="py-4 font-semibold">{c.payout}</td>
                  <td className="py-4 text-rose-400">{c.adj}</td>
                  <td className="py-4">
                    <span className="text-xs px-2.5 py-1 rounded-full"
                      style={{ background: `${c.statusColor}15`, color: c.statusColor }}>
                      {c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between mt-5 pt-4 border-t" style={{ borderColor: 'var(--border-glass)' }}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>表示中 1-4 / 全 128 キャスト</p>
          <div className="flex gap-1">
            <button className="w-8 h-8 rounded-lg text-xs flex items-center justify-center text-slate-400 hover:bg-white/[0.03]">‹</button>
            <button className="w-8 h-8 rounded-lg text-xs flex items-center justify-center bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">1</button>
            <button className="w-8 h-8 rounded-lg text-xs flex items-center justify-center text-slate-400 hover:bg-white/[0.03]">2</button>
            <button className="w-8 h-8 rounded-lg text-xs flex items-center justify-center text-slate-400 hover:bg-white/[0.03]">3</button>
            <span className="w-8 h-8 flex items-center justify-center text-xs text-slate-600">…</span>
            <button className="w-8 h-8 rounded-lg text-xs flex items-center justify-center text-slate-400 hover:bg-white/[0.03]">32</button>
            <button className="w-8 h-8 rounded-lg text-xs flex items-center justify-center text-slate-400 hover:bg-white/[0.03]">›</button>
          </div>
        </div>
      </div>
    </div>
  );
}
