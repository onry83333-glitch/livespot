'use client';
import Link from 'next/link';

const stats = [
  { label: 'オンライン合計', value: '42', change: '+3', positive: true },
  { label: '平均エンゲージメント', value: '84%', change: null, positive: true },
  { label: '稼働ルーム数', value: '18', change: null, positive: true },
];

const whaleRanking = [
  { rank: 1, name: 'Tanaka-San / 田中さん', ltv: '¥1,850,000' },
  { rank: 2, name: 'King_Cobra99', ltv: '¥1,460,000' },
  { rank: 3, name: 'Satoshi_Vibe', ltv: '¥1,200,000' },
  { rank: 4, name: 'Executive_User', ltv: '¥790,000' },
];

const whispers = [
  { type: 'engagement', time: '2分前', title: 'エンゲージメント・チャンス', msg: '田中さんにパーソナライズされた歓迎メッセージを送りましょう。', color: '#38bdf8' },
  { type: 'system', time: '5分前', title: 'システム通知', msg: 'アカウント "Yuna_01" が4時間以上オンラインです。休憩を推奨します。', color: '#f59e0b' },
  { type: 'security', time: '12分前', title: 'セキュリティ・プロトコル', msg: '大阪ノードから異常なログインパターンを検出しました。IPを確認', color: '#f43f5e' },
];

const payroll = [
  { name: 'Yuki (ID: 004)', revenue: '¥675,000', fee: '¥135,000', payout: '¥540,000', status: '支払い準備完了' },
  { name: 'Mei-Mei (ID: 012)', revenue: '¥480,000', fee: '¥96,000', payout: '¥384,000', status: '支払い準備確認中' },
  { name: 'Sakura (ID: 028)', revenue: '¥420,000', fee: '¥84,000', payout: '¥336,000', status: '保留中' },
];

export default function DashboardPage() {
  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <input
            className="input-glass w-80"
            placeholder="🔍 アカウント、ログ、ホエールを検索..."
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="anim-pulse-glow px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-2"
            style={{ background: 'rgba(244,63,94,0.15)', color: 'var(--accent-pink)', border: '1px solid rgba(244,63,94,0.2)' }}>
            ⚡ 優良顧客（ホエール）が入室しました
          </div>
          <div className="badge-live flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
            サーバー状態: 最適化済み
          </div>
        </div>
      </div>

      {/* Top row: Account stats + Whale ranking */}
      <div className="grid grid-cols-3 gap-5 anim-fade-up">
        {/* Active Accounts */}
        <div className="col-span-2 glass-card p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-xl font-bold">アクティブ・アカウント</h2>
              <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                アクティブなキャストプロフィールのリアルタイム管理
              </p>
            </div>
            <div className="badge-live flex items-center gap-1.5 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
              稼働中 42
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-5">
            {stats.map((s, i) => (
              <div key={i} className="glass-panel p-4 rounded-xl">
                <p className="text-3xl font-bold tracking-tight">{s.value}
                  {s.change && (
                    <span className="text-xs ml-2 text-emerald-400 font-medium">{s.change}</span>
                  )}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{s.label}</p>
              </div>
            ))}
          </div>

          <div className="glass-panel px-4 py-3 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-lg">🛡</span>
              <div>
                <p className="text-sm font-medium">BAN保護機能</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>高度なプロキシと動作監視が有効です</p>
              </div>
            </div>
            <div className="w-11 h-6 rounded-full bg-emerald-500 relative cursor-pointer">
              <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white"></div>
            </div>
          </div>
        </div>

        {/* Whale Ranking */}
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold">上位15名 優良顧客(ホエール)ランキング</h3>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              顧客生涯価値 (LTV)
            </p>
          </div>
          <div className="space-y-0">
            {whaleRanking.map((w, i) => (
              <div key={i} className="flex items-center justify-between py-3 border-b"
                style={{ borderColor: 'var(--border-glass)' }}>
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-bold ${i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-orange-400' : 'text-slate-500'}`}>
                    #{w.rank}
                  </span>
                  <span className="text-sm">{w.name}</span>
                </div>
                <span className="text-sm font-semibold text-emerald-400">{w.ltv}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom row: Whisper Feed + Payroll Overview */}
      <div className="grid grid-cols-5 gap-5 anim-fade-up delay-2">
        {/* Whisper Feed */}
        <div className="col-span-2 glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold flex items-center gap-2">
              🔮 ウィスパーフィード
            </h3>
            <span className="badge-info">AI推奨</span>
          </div>
          <div className="space-y-3">
            {whispers.map((w, i) => (
              <div key={i} className="glass-panel p-4 rounded-xl border-l-2" style={{ borderLeftColor: w.color }}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold" style={{ color: w.color }}>{w.title}</span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{w.time}</span>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{w.msg}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Payroll Overview */}
        <div className="col-span-3 glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-bold flex items-center gap-2">
              📋 給与オーバービュー (今期)
            </h3>
            <button className="btn-ghost text-xs flex items-center gap-1.5">
              📥 PDFダウンロード
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--text-muted)' }}>
                  <th className="pb-3 font-medium text-xs">キャスト名</th>
                  <th className="pb-3 font-medium text-xs">総売上</th>
                  <th className="pb-3 font-medium text-xs">代理店手数料(20%)</th>
                  <th className="pb-3 font-medium text-xs">キャスト支払額</th>
                  <th className="pb-3 font-medium text-xs">ステータス</th>
                </tr>
              </thead>
              <tbody>
                {payroll.map((p, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                    <td className="py-3 font-medium">{p.name}</td>
                    <td className="py-3" style={{ color: 'var(--text-secondary)' }}>{p.revenue}</td>
                    <td className="py-3" style={{ color: 'var(--text-secondary)' }}>{p.fee}</td>
                    <td className="py-3 font-semibold text-emerald-400">{p.payout}</td>
                    <td className="py-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        p.status.includes('完了') ? 'bg-emerald-500/10 text-emerald-400' :
                        p.status.includes('確認') ? 'bg-sky-500/10 text-sky-400' :
                        'bg-amber-500/10 text-amber-400'
                      }`}>{p.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-glass)' }}>
            <div>
              <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>総代理店収益</p>
              <p className="text-xl font-bold">¥358,500</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>総支払額</p>
              <p className="text-xl font-bold text-emerald-400">¥1,434,000</p>
            </div>
            <div className="text-right">
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>次回処理まで 14時間 22分</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
