'use client';
import { useState } from 'react';

const securityLogs = [
  { time: '10:45:22', event: '異常なログイン試行', ip: '192.168.1.195', status: 'BLOCKED', action: '...' },
  { time: '10:32:15', event: 'レート制限超過', ip: '10.0.0.42', status: 'WARNING', action: '...' },
  { time: '10:15:03', event: '正常アクセス', ip: '172.16.0.1', status: 'OK', action: '...' },
];

export default function SettingsPage() {
  const [banProtection, setBanProtection] = useState(true);
  const [burstMode, setBurstMode] = useState(false);
  const [sensitivity, setSensitivity] = useState(3);
  const [rateLimit, setRateLimit] = useState(45);
  const [sessionLimit, setSessionLimit] = useState(5);

  return (
    <div className="max-w-[1200px] space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>🏠 / システム管理</p>
          <h1 className="text-xl font-bold flex items-center gap-2 mt-1">🛡 管理＆セキュリティ</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>システムの安全性を維持し、アカウントBANを防止するための高度な設定。</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs">↻ リロード</button>
          <button className="btn-danger text-xs">🔒 設定を保存</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 anim-fade-up">
        <div className="glass-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>有効な保護機能</p>
            <span className="text-emerald-400 text-lg">✓</span>
          </div>
          <p className="text-3xl font-bold mt-2">12 <span className="text-xs text-emerald-400 font-medium">+2 active</span></p>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>本日のブロック数</p>
            <span className="text-amber-400 text-lg">⚠</span>
          </div>
          <p className="text-3xl font-bold mt-2">483 <span className="text-xs text-emerald-400 font-medium">↑5%</span></p>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center justify-between">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>現在の接続数</p>
            <span className="text-sky-400 text-lg">🔗</span>
          </div>
          <p className="text-3xl font-bold mt-2">24 <span className="text-xs text-rose-400 font-medium">↓2%</span></p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-5">
          <h2 className="text-base font-bold flex items-center gap-2">⚙ リミッター設定</h2>

          <div className="grid grid-cols-2 gap-4">
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-bold">BAN保護機能</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>アルゴリズムによる自動BAN回避</p>
                </div>
                <button onClick={() => setBanProtection(!banProtection)}
                  className={`w-11 h-6 rounded-full relative transition-colors ${banProtection ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${banProtection ? 'right-1' : 'left-1'}`}></div>
                </button>
              </div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span>感度レベル</span><span>高</span>
              </div>
              <input type="range" min="1" max="5" value={sensitivity} onChange={e => setSensitivity(Number(e.target.value))} className="w-full accent-emerald-400" />
              <p className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>* AIが不自然なメッセージ送信間隔を自動的に調整します。</p>
            </div>

            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-bold">バーストモード</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>短時間の集中トラフィック制御</p>
                </div>
                <button onClick={() => setBurstMode(!burstMode)}
                  className={`w-11 h-6 rounded-full relative transition-colors ${burstMode ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                  <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform ${burstMode ? 'right-1' : 'left-1'}`}></div>
                </button>
              </div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span>送信制限/分</span><span className="font-mono font-semibold">{rateLimit} msgs</span>
              </div>
              <input type="range" min="10" max="100" value={rateLimit} onChange={e => setRateLimit(Number(e.target.value))} className="w-full accent-sky-400" />
            </div>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-bold">接続制限 (Connection Limiting)</p>
                <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>1アカウントあたりの同時接続セッション数</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400">Stable (32%)</span>
                <span className="text-2xl font-bold font-mono">05</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs">セッション上限</span>
              <input type="range" min="1" max="10" value={sessionLimit} onChange={e => setSessionLimit(Number(e.target.value))} className="flex-1 accent-emerald-400" />
              <span className="text-sm font-mono font-bold">{sessionLimit}</span>
            </div>
            <div className="mt-3 p-2.5 rounded-lg flex items-center gap-2" style={{ background: 'rgba(244,63,94,0.06)', border: '1px solid rgba(244,63,94,0.12)' }}>
              <span className="text-xs text-rose-400">⚠</span>
              <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>5個以上の接続は、一部のプラットフォームで検知リスクが高まります。</p>
            </div>
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold">📋 セキュリティログ</h3>
              <button className="text-xs" style={{ color: 'var(--accent-primary)' }}>全てのログを見る</button>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left pb-3 font-medium">発生日時</th>
                  <th className="text-left pb-3 font-medium">イベント</th>
                  <th className="text-left pb-3 font-medium">IPアドレス</th>
                  <th className="text-left pb-3 font-medium">ステータス</th>
                  <th className="text-left pb-3 font-medium">アクション</th>
                </tr>
              </thead>
              <tbody>
                {securityLogs.map((l, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--border-glass)' }}>
                    <td className="py-3 font-mono">{l.time}</td>
                    <td className="py-3">{l.event}</td>
                    <td className="py-3 font-mono" style={{ color: 'var(--text-muted)' }}>{l.ip}</td>
                    <td className="py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${l.status === 'BLOCKED' ? 'bg-rose-500/10 text-rose-400' : l.status === 'WARNING' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{l.status}</span>
                    </td>
                    <td className="py-3 text-slate-500">{l.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-5">
          <h2 className="text-base font-bold flex items-center gap-2">📡 システム稼働状況</h2>

          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>総合保護スコア</p>
            </div>
            <div className="text-center">
              <p className="text-5xl font-bold text-emerald-400">98%</p>
              <p className="text-[10px] mt-2" style={{ color: 'var(--text-secondary)' }}>全ての推奨セキュリティ設定が適用されています。現在の脅威レベルは「低」です。</p>
            </div>
          </div>

          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-3">クイックアクション</h3>
            <div className="space-y-2">
              <button className="w-full glass-panel p-3 rounded-xl text-left flex items-center gap-3 hover:bg-white/[0.03] transition-all">
                <span className="text-rose-400 text-lg">⏹</span>
                <div>
                  <p className="text-xs font-medium">緊急停止</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>全接続を即時に切断します</p>
                </div>
              </button>
              <button className="w-full glass-panel p-3 rounded-xl text-left flex items-center gap-3 hover:bg-white/[0.03] transition-all">
                <span className="text-sky-400 text-lg">🔄</span>
                <div>
                  <p className="text-xs font-medium">自動最適化</p>
                  <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>リミッターを最適値に再構成</p>
                </div>
              </button>
            </div>
          </div>

          <div className="glass-card p-5">
            <h3 className="text-sm font-bold mb-3">プロキシ接続地域</h3>
            <div className="glass-panel p-4 rounded-xl text-center">
              <div className="text-4xl mb-2 opacity-40">🌐</div>
              <p className="text-xs font-medium">Main Node: Tokyo, JP</p>
              <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>Ping: 12ms</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
