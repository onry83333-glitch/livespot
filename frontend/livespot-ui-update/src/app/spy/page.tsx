'use client';
import { useState } from 'react';

const rooms = [
  { name: 'サクラ (Lv.4)', status: 'WARNING', statusColor: '#f59e0b', lastMsg: 'Client: 「今夜空いてる？」', time: '活動 02:45' },
  { name: 'ミキ (Lv.5)', status: 'LIVE', statusColor: '#22c55e', lastMsg: 'Cast: 「もちろんですよ！乾杯しましょ」', time: '活動中 12:45' },
  { name: 'ユア (Lv.3)', status: 'LIVE', statusColor: '#22c55e', lastMsg: 'Client: 「また来週も会える？」', time: '経過 09:20' },
  { name: 'ハル (Lv.2)', status: 'LIVE', statusColor: '#22c55e', lastMsg: 'Cast: 「今日は遅くまで一緒だね」', time: '経過 08:15' },
];

const chatMessages = [
  { time: '22:48:12', sender: 'CLIENT', text: 'ねえ、サクラちゃん。最近冷たくない？昨日のメールも返信遅かったし。', color: '#f43f5e' },
  { time: '22:48:45', sender: 'CAST', text: 'そんなことないよ！ちょっとバタバタしてただけだよ。ごめんね🥺', color: '#38bdf8' },
  { time: '22:48:30', sender: 'CLIENT', text: 'バタバタって何？他の客と話してたんでしょ。今夜はっきりさせて。空いてるの？', color: '#f43f5e' },
];

const aiSuggestions = {
  sentiment: { label: 'NEGATIVE (72%)', level: 72, color: '#f43f5e' },
  potential: { label: 'HIGH (¥450,000+)', color: '#22c55e' },
  recommendation: '「怒らせちゃってごめんね。でも〇〇さんのこと大事に酔ってるから、つい言葉が足りなくなっちゃうの。許してくれる？」',
  gift: 'クライアントの独占欲が高まっています。「シャンパン（お祝い）」をねだる絶好のタイミングです。',
  userInfo: { id: '#9821', totalSpend: '¥450,200', frequency: '週 4-5回', favCasts: 'サクラ, ハル', risk: '粘着傾向' },
};

export default function SpyPage() {
  const [activeRoom, setActiveRoom] = useState(0);
  const [tab, setTab] = useState<'Realtime' | 'History'>('Realtime');

  return (
    <div className="h-[calc(100vh-48px)] flex gap-4">
      {/* Left: Room List */}
      <div className="w-64 flex-shrink-0 glass-card p-4 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">稼働中ルーム</h3>
          <button className="text-xs" style={{ color: 'var(--text-muted)' }}>フィルター</button>
        </div>
        <div className="flex-1 space-y-2 overflow-auto">
          {rooms.map((r, i) => (
            <button key={i}
              onClick={() => setActiveRoom(i)}
              className={`w-full text-left p-3 rounded-xl transition-all duration-200 ${
                activeRoom === i ? 'border' : 'hover:bg-white/[0.03]'
              }`}
              style={activeRoom === i ? {
                background: 'rgba(56,189,248,0.08)',
                borderColor: 'rgba(56,189,248,0.2)',
              } : {}}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold">{r.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                  style={{ background: `${r.statusColor}15`, color: r.statusColor }}>
                  {r.status}
                </span>
              </div>
              <p className="text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>{r.lastMsg}</p>
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>{r.time}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Center: Chat Log */}
      <div className="flex-1 glass-card p-5 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              🔍 スパイログ（SPY LOGS）
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Target: サクラ＆ユーザー#9821
            </p>
          </div>
          <div className="flex gap-1">
            {(['Realtime', 'History'] as const).map(t => (
              <button key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  tab === t ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'text-slate-400 hover:text-slate-200'
                }`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto space-y-4 pr-2">
          {chatMessages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.sender === 'CAST' ? 'items-end' : 'items-start'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-semibold" style={{ color: m.color }}>{m.sender}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{m.time}</span>
              </div>
              <div className={`max-w-[75%] p-3 rounded-xl text-sm leading-relaxed ${
                m.sender === 'CAST' ? 'glass-panel' : ''
              }`}
                style={m.sender === 'CLIENT' ? {
                  background: 'rgba(244,63,94,0.08)',
                  border: '1px solid rgba(244,63,94,0.12)',
                } : {}}>
                {m.text}
              </div>
            </div>
          ))}

          {/* Whisper sent indicator */}
          <div className="flex justify-center">
            <span className="text-[10px] px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
              🔒 WHISPER SENT BY MANAGER
            </span>
          </div>

          {/* AI Detection */}
          <div className="flex justify-center">
            <span className="text-[10px] px-3 py-1 rounded-full" style={{ background: 'rgba(245,158,11,0.08)', color: 'var(--accent-amber)', border: '1px solid rgba(245,158,11,0.12)' }}>
              ⚠ AI detected: Client sentiment is deteriorating (Negative)
            </span>
          </div>
        </div>

        {/* Input */}
        <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-glass)' }}>
          <div className="flex gap-2 mb-3 flex-wrap">
            {['謝罪 + 甘え (Template)', '嫉妬を煽る', '延長の打診'].map(t => (
              <button key={t} className="btn-ghost text-[11px] py-1.5 px-3">{t}</button>
            ))}
            <button className="btn-ghost text-[11px] py-1.5 px-2">+</button>
          </div>
          <div className="flex gap-3">
            <input className="input-glass flex-1" placeholder='キャストに「ささやく」メッセージを入力... (Ctrl + Enter で送信)' />
            <button className="btn-primary text-xs whitespace-nowrap">送信 (Whisper)</button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>● このメッセージはキャストのみに表示されます</p>
            <div className="flex items-center gap-2">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>AI Auto-pilot</span>
              <div className="w-8 h-4 rounded-full bg-slate-700 relative cursor-pointer">
                <div className="absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-slate-400"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: AI Suggestions */}
      <div className="w-72 flex-shrink-0 space-y-4 overflow-auto">
        <div className="glass-card p-5">
          <h3 className="text-sm font-bold mb-3">🤖 AI 推奨アクション</h3>

          {/* Sentiment */}
          <div className="glass-panel p-3 rounded-xl mb-3">
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>感情分析 & リスク評価</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span>SENTIMENT</span>
                <span style={{ color: aiSuggestions.sentiment.color }}>{aiSuggestions.sentiment.label}</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-slate-800">
                <div className="h-full rounded-full" style={{ width: `${aiSuggestions.sentiment.level}%`, background: aiSuggestions.sentiment.color }}></div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span>POTENTIAL SPEND</span>
                <span style={{ color: aiSuggestions.potential.color }}>{aiSuggestions.potential.label}</span>
              </div>
            </div>
          </div>

          {/* Recommendation */}
          <div className="mb-3">
            <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>💡 推奨メッセージ #1</p>
            <div className="glass-panel p-3 rounded-xl">
              <p className="text-xs leading-relaxed italic" style={{ color: 'var(--text-secondary)' }}>「{aiSuggestions.recommendation}」</p>
            </div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary text-[11px] flex-1 py-2">WHISPERを送る</button>
              <button className="btn-ghost text-[11px] py-2 px-2">📋</button>
            </div>
          </div>

          {/* Gift suggestion */}
          <div className="glass-panel p-3 rounded-xl border-l-2" style={{ borderLeftColor: 'var(--accent-amber)' }}>
            <p className="text-xs font-semibold mb-1" style={{ color: 'var(--accent-amber)' }}>💎 ギフト誘導</p>
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{aiSuggestions.gift}</p>
            <button className="btn-ghost text-[10px] mt-2 w-full py-1.5">定型文を使用</button>
          </div>
        </div>

        {/* User Info */}
        <div className="glass-card p-5">
          <h3 className="text-sm font-bold mb-3">👤 ユーザー情報: {aiSuggestions.userInfo.id}</h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p style={{ color: 'var(--text-muted)' }}>累計消費</p>
              <p className="font-semibold">{aiSuggestions.userInfo.totalSpend}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)' }}>来店頻度</p>
              <p className="font-semibold">{aiSuggestions.userInfo.frequency}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)' }}>推しキャスト</p>
              <p className="font-semibold">{aiSuggestions.userInfo.favCasts}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)' }}>リスク</p>
              <p className="font-semibold text-rose-400">{aiSuggestions.userInfo.risk}</p>
            </div>
          </div>
        </div>

        <button className="btn-danger w-full text-xs py-3">
          🚫 強制退室・ブラックリスト
        </button>
      </div>
    </div>
  );
}
