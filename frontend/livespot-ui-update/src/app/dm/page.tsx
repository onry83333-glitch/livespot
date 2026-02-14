'use client';
import { useState } from 'react';

const targets = [
  'https://ja.stripchat.com/user/p_yutayuta_p',
  'https://ja.stripchat.com/user/Nekomeem34',
  'https://ja.stripchat.com/user/kantou1234',
  'https://ja.stripchat.com/user/pojipojipoji',
];

export default function DmPage() {
  const [message, setMessage] = useState('お久しぶりです！今夜空いてますか？またお話しできたら嬉しいです！');
  const [sendOrder, setSendOrder] = useState<'text-image' | 'image-text' | 'text-only'>('text-image');
  const [accessImage, setAccessImage] = useState<'free' | 'paid'>('free');
  const [sendMode, setSendMode] = useState<'sequential' | 'pipeline'>('pipeline');
  const [tabs, setTabs] = useState(3);

  return (
    <div className="max-w-[1400px] space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">💬 DM一斉送信</h1>
          <span className="badge-info text-[10px]">V7.0</span>
          <span className="badge-live text-[10px] flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 anim-live"></span>
            Chrome接続済み
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>SYSTEM HEALTH</span>
          <span className="text-xs font-semibold text-emerald-400">Excellent</span>
          <button className="text-slate-400 hover:text-white transition-colors">🔔</button>
        </div>
      </div>

      {/* Main 3-column grid */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left: Targets */}
        <div className="col-span-3 glass-card p-5">
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
            🎯 ターゲット
          </h3>
          <p className="text-[10px] mb-3" style={{ color: 'var(--text-muted)' }}>URLまたはユーザー名 ({targets.length}件)</p>
          <div className="glass-panel p-3 rounded-xl font-mono text-[11px] leading-relaxed max-h-64 overflow-auto"
            style={{ color: 'var(--text-secondary)' }}>
            {targets.map((t, i) => (
              <p key={i} className="break-all mb-1">{t}</p>
            ))}
          </div>
          <button className="mt-3 w-full btn-ghost text-xs py-2">+ ターゲット追加</button>

          <div className="mt-6">
            <button className="w-full py-3 rounded-xl font-semibold text-sm text-white flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)', boxShadow: '0 4px 15px rgba(244,63,94,0.25)' }}>
              🎯 目標確定
            </button>
            <div className="flex items-center justify-center gap-2 mt-2">
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>確定ブロック</span>
              <span className="text-2xl font-bold">4</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>名</span>
            </div>
          </div>
        </div>

        {/* Center: Message + Image */}
        <div className="col-span-5 space-y-4">
          {/* Message */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
              ✉️ 送信メッセージ
            </h3>
            <textarea
              className="input-glass h-28 resize-none text-sm"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="メッセージを入力..."
            />
          </div>

          {/* Image Upload */}
          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
              📎 画像添付
            </h3>
            <div className="border-2 border-dashed rounded-xl p-8 text-center transition-colors hover:border-sky-500/30"
              style={{ borderColor: 'var(--border-glass)' }}>
              <div className="text-4xl mb-3 opacity-30">🏠</div>
              <p className="text-sm mb-1">ファイルをここにドラッグアンドドロップしてください</p>
              <p className="text-[10px] mb-4" style={{ color: 'var(--text-muted)' }}>PNG, JPG, GIF (MAX 200MB)</p>
              <button className="btn-ghost text-xs">ファイルを閲覧する</button>
            </div>

            <div className="mt-3 glass-panel p-3 rounded-lg flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-base">🖼</span>
                <div>
                  <p className="text-xs font-medium">screenshot_2025_11_22.png</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>104.5 KB • UPLOADED</p>
                </div>
              </div>
              <button className="text-slate-500 hover:text-rose-400 transition-colors">✕</button>
            </div>
          </div>
        </div>

        {/* Right: Settings */}
        <div className="col-span-4 glass-card p-5">
          <h3 className="text-sm font-bold mb-4 flex items-center gap-2">
            ⚙ 設定
          </h3>

          {/* Send Order */}
          <div className="mb-5">
            <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>📤 順番送信</p>
            <div className="space-y-2">
              {([
                { key: 'text-image', label: 'テキスト → 画像' },
                { key: 'image-text', label: '画像 → テキスト' },
                { key: 'text-only', label: 'テキストのみ' },
              ] as const).map(o => (
                <button key={o.key}
                  onClick={() => setSendOrder(o.key)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                    sendOrder === o.key
                      ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20'
                      : 'text-slate-400 hover:bg-white/[0.03]'
                  }`}>
                  <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${
                    sendOrder === o.key ? 'bg-sky-400 border-sky-400' : 'border-slate-600'
                  }`}></span>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Access Image */}
          <div className="mb-5">
            <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>🖼 アクセス画像</p>
            <div className="flex gap-2">
              <button onClick={() => setAccessImage('free')}
                className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                  accessImage === 'free' ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' : 'btn-ghost'
                }`}>無料</button>
              <button onClick={() => setAccessImage('paid')}
                className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                  accessImage === 'paid' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'btn-ghost'
                }`}>有料設定</button>
            </div>
          </div>

          {/* Send Mode */}
          <div className="mb-5">
            <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>🚀 送信モード</p>
            <div className="space-y-2">
              <button onClick={() => setSendMode('sequential')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                  sendMode === 'sequential' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'
                }`}>
                <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendMode === 'sequential' ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                順次 (安全)
              </button>
              <button onClick={() => setSendMode('pipeline')}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all ${
                  sendMode === 'pipeline' ? 'bg-sky-500/15 text-sky-400 border border-sky-500/20' : 'text-slate-400 hover:bg-white/[0.03]'
                }`}>
                <span className={`inline-block w-3 h-3 rounded-full mr-2 border-2 ${sendMode === 'pipeline' ? 'bg-sky-400 border-sky-400' : 'border-slate-600'}`}></span>
                パイプライン (高速)
              </button>
            </div>
          </div>

          {/* Concurrent Tabs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>🔗 同時タブ</p>
              <span className="text-2xl font-bold text-sky-400">{tabs}</span>
            </div>
            <input type="range" min="1" max="5" value={tabs}
              onChange={(e) => setTabs(Number(e.target.value))}
              className="w-full accent-sky-400"
            />
            <p className="text-[10px] text-right mt-1" style={{ color: 'var(--accent-green)' }}>
              🚀 約{tabs}倍速で配信中
            </p>
          </div>
        </div>
      </div>

      {/* Send Button */}
      <button className="w-full py-4 rounded-2xl text-lg font-bold text-white transition-all duration-300 flex items-center justify-center gap-3"
        style={{
          background: 'linear-gradient(135deg, var(--accent-pink), #e11d48)',
          boxShadow: '0 6px 30px rgba(244,63,94,0.3)',
        }}>
        🚀 送信開始
      </button>
    </div>
  );
}
