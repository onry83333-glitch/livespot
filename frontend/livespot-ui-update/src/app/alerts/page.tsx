'use client';
import { useState } from 'react';

const alerts = [
  { name: 'Kenji_Diamond', id: '994203', coins: '842,000c', time: '1分前に入室', level: 'CRITICAL', avatar: '💎', selected: true },
  { name: 'Mister_X', id: '192455', coins: '120,500c', time: '45日ぶりの訪問', level: null, avatar: '🎭', selected: false },
  { name: 'S.Hiroshi', id: '082012', coins: '55,200c', time: '15分前に入室', level: null, avatar: '👤', selected: false },
  { name: 'Take-San', id: '442991', coins: '28,000c', time: '退室済み（30分前）', level: null, avatar: '🧑', selected: false },
];

const triggerSettings = [
  { label: '超高額消費ユーザー', desc: '累計 100,000c 以上', active: true },
  { label: '休眠復帰ユーザー', desc: '30日以上未ログイン', active: true },
  { label: '特定タグ保持者', desc: '#ブラックカード', active: false },
];

const selectedUser = {
  name: 'Kenji_Diamond',
  badge: 'BLACK CARD MEMBER',
  totalCoins: '842,000c',
  regDate: '2023年04月12日',
  lastLogin: '1分前',
  tags: ['#癒やしあり', '#コスプレ', '#お姉さん', '#長時間チャット'],
  memo: '「週末の深夜帯によく現れる。アニメの話を振ると喜び、投げ銭が増える傾向あり。」',
};

export default function AlertsPage() {
  const [onlineVip] = useState(24);
  const [todaySales] = useState('1.2M');

  return (
    <div className="h-[calc(100vh-48px)] flex gap-5">
      {/* Left: Stats + Trigger Settings */}
      <div className="w-56 flex-shrink-0 space-y-4">
        <div className="glass-card p-5">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>現在のオンラインVIP</p>
          <div className="flex items-baseline gap-2 mt-1">
            <p className="text-4xl font-bold text-sky-400">{onlineVip}</p>
            <span className="text-xs text-emerald-400">↗+12%</span>
          </div>
        </div>

        <div className="glass-card p-5">
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>本日のVIP総売上</p>
          <div className="flex items-baseline gap-1 mt-1">
            <p className="text-4xl font-bold text-emerald-400">{todaySales}</p>
            <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Coins</span>
          </div>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
            🔧 アラートトリガー設定
          </h3>
          <div className="space-y-4">
            {triggerSettings.map((t, i) => (
              <div key={i} className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium">{t.label}</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{t.desc}</p>
                </div>
                <div className={`w-10 h-5 rounded-full relative cursor-pointer transition-colors ${t.active ? 'bg-rose-500' : 'bg-slate-700'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${t.active ? 'right-0.5' : 'left-0.5'}`}></div>
                </div>
              </div>
            ))}
          </div>
          <button className="text-xs mt-4 w-full text-center" style={{ color: 'var(--accent-pink)' }}>
            詳細なルールを編集
          </button>
        </div>
      </div>

      {/* Center: Alert List */}
      <div className="flex-1 glass-card p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            🚨 入室アラート（リアルタイム）
          </h2>
          <div className="flex gap-2">
            <button className="btn-primary text-xs py-1.5">全て表示</button>
            <button className="btn-ghost text-xs py-1.5">未対応のみ</button>
          </div>
        </div>

        <div className="flex-1 overflow-auto space-y-3">
          {alerts.map((a, i) => (
            <div key={i}
              className={`p-4 rounded-xl transition-all duration-200 cursor-pointer ${
                a.selected ? 'border-2' : 'glass-panel hover:bg-white/[0.03]'
              }`}
              style={a.selected ? {
                background: 'rgba(244,63,94,0.06)',
                borderColor: 'rgba(244,63,94,0.3)',
                boxShadow: '0 0 20px rgba(244,63,94,0.1)',
              } : {}}
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                  style={{ background: 'rgba(15,23,42,0.8)' }}>
                  {a.avatar}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{a.name}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>ID: {a.id}</span>
                    {a.level && <span className="badge-critical text-[9px]">{a.level}</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-amber-400">💰 {a.coins}</span>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>⏱ {a.time}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="px-4 py-2 rounded-lg text-xs font-medium text-white"
                    style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)' }}>
                    レディを割り当てる
                  </button>
                  <button className="btn-ghost text-xs">詳細</button>
                </div>
              </div>

              {!a.selected && a.name === 'Mister_X' && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">✓ 対応中: Yui.A</span>
                  <button className="text-[10px]" style={{ color: 'var(--text-muted)' }}>チャットログ</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Right: User Detail */}
      <div className="w-72 flex-shrink-0 glass-card p-5 flex flex-col">
        <div className="text-center mb-5">
          <div className="w-20 h-20 rounded-full mx-auto mb-3 flex items-center justify-center text-4xl"
            style={{ background: 'linear-gradient(135deg, rgba(244,63,94,0.2), rgba(168,85,247,0.2))', border: '2px solid rgba(244,63,94,0.3)' }}>
            💎
          </div>
          <h3 className="text-lg font-bold">{selectedUser.name}</h3>
          <span className="badge-premium text-[10px]">✦ {selectedUser.badge}</span>
        </div>

        <div className="space-y-3 flex-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="glass-panel p-3 rounded-lg">
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>累計消費コイン</p>
              <p className="text-sm font-bold text-amber-400">{selectedUser.totalCoins}</p>
            </div>
            <div className="glass-panel p-3 rounded-lg">
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>登録日</p>
              <p className="text-sm font-bold">{selectedUser.regDate}</p>
            </div>
          </div>
          <div className="glass-panel p-3 rounded-lg">
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>最終ログイン</p>
            <p className="text-sm font-bold text-emerald-400">{selectedUser.lastLogin}</p>
          </div>

          <div>
            <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>好みの属性</p>
            <div className="flex flex-wrap gap-1.5">
              {selectedUser.tags.map(t => (
                <span key={t} className="text-[10px] px-2 py-1 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/15">{t}</span>
              ))}
            </div>
          </div>

          <div className="glass-panel p-3 rounded-xl">
            <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}>管理者メモ</p>
            <p className="text-xs italic leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{selectedUser.memo}</p>
          </div>
        </div>

        <button className="mt-4 w-full py-3 rounded-xl font-semibold text-sm text-white"
          style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)', boxShadow: '0 4px 20px rgba(244,63,94,0.3)' }}>
          💬 ダイレクトメッセージ
        </button>
      </div>
    </div>
  );
}
