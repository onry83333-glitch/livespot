'use client';

import type { SpyMessage } from '@/types';
import { getUserLeagueColor, tokensToJPY } from '@/lib/utils';

/** メッセージタイプ別の色設定 (B.2 enhanced) */
const typeStyles: Record<string, { color: string; bg: string; border: string; label: string }> = {
  chat:   { color: 'var(--text-primary)',  bg: 'transparent',            border: 'transparent',            label: '\ud83d\udcac' },
  gift:   { color: 'var(--accent-amber)',  bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', label: '\ud83c\udf81' },
  tip:    { color: 'var(--accent-amber)',  bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', label: '\ud83d\udcb0' },
  goal:   { color: 'var(--accent-purple)', bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.25)', label: '\ud83c\udfaf' },
  enter:  { color: 'var(--accent-green)',  bg: 'rgba(34,197,94,0.05)',  border: 'rgba(34,197,94,0.15)',  label: '\ud83d\udc4b' },
  leave:  { color: 'var(--accent-pink)',   bg: 'rgba(244,63,94,0.05)',  border: 'rgba(244,63,94,0.15)',  label: '\ud83d\udeaa' },
  system: { color: 'var(--text-muted)',    bg: 'rgba(100,116,139,0.04)', border: 'transparent',           label: '\ud83d\udd14' },
  viewer_count: { color: '#38bdf8',      bg: 'rgba(56,189,248,0.06)', border: 'rgba(56,189,248,0.18)', label: '\ud83d\udcca' },
};

export function ChatMessage({ message: msg }: { message: SpyMessage }) {
  const style = typeStyles[msg.msg_type] ?? typeStyles.chat;
  const isTip = msg.msg_type === 'tip' || msg.msg_type === 'gift' || msg.msg_type === 'goal';
  const isSystem = msg.msg_type === 'system';

  const time = new Date(msg.message_time).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div
      className={`px-3 rounded-lg anim-fade ${isTip ? 'py-2.5' : 'py-1.5'}`}
      style={{
        background: style.bg,
        borderLeft: style.border !== 'transparent' ? `3px solid ${style.border}` : undefined,
        fontSize: isTip ? '14px' : '13px',
      }}
    >
      {/* 時刻 */}
      <span className="text-[10px] mr-2 tabular-nums" style={{ color: 'var(--text-muted)' }}>{time}</span>

      {/* タイプアイコン */}
      <span className="mr-1.5">{style.label}</span>

      {/* ユーザー名 (league color) */}
      {msg.user_name && (
        <span className={`font-semibold mr-2 ${isTip ? 'text-sm' : 'text-xs'}`}
          style={{ color: msg.user_color || getUserLeagueColor((msg as unknown as Record<string, unknown>).user_level as number | null) }}>
          {msg.user_name}
        </span>
      )}

      {/* トークン (B.2: 大きめ + 円換算) */}
      {msg.tokens > 0 && (
        <span className={`font-bold mr-2 ${isTip ? 'text-sm' : 'text-[11px]'}`} style={{ color: 'var(--accent-amber)' }}>
          [{msg.tokens.toLocaleString()} tk / {tokensToJPY(msg.tokens)}]
        </span>
      )}

      {/* メッセージ本文 */}
      {msg.message && (
        <span style={{ color: style.color, fontStyle: isSystem ? 'italic' : undefined }}>
          {msg.message}
        </span>
      )}

      {/* enter/leave用のテキスト */}
      {!msg.message && msg.msg_type === 'enter' && (
        <span style={{ color: style.color }}>が入室しました</span>
      )}
      {!msg.message && msg.msg_type === 'leave' && (
        <span style={{ color: style.color }}>が退室しました</span>
      )}
    </div>
  );
}
