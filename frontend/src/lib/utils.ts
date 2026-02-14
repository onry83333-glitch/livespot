import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind class merge */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format tokens with comma separators */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString() + ' tk';
}

/** Format tokens to JPY estimate (default 1tk ≈ ¥7.7, configurable per account) */
export function tokensToJPY(tokens: number, coinRate: number = 7.7): string {
  return '\u00A5' + Math.round(tokens * coinRate).toLocaleString();
}

/** Format date to JST display */
export function formatJST(dateStr: string): string {
  return new Date(dateStr).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

/** Format relative time */
export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'たった今';
  if (mins < 60) return `${mins}分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

/** Lifecycle badge color */
export function lifecycleColor(lifecycle: string): string {
  switch (lifecycle) {
    case 'active': return 'bg-green-500';
    case 'dormant': return 'bg-yellow-500';
    case 'churned': return 'bg-red-500';
    case 'new': return 'bg-blue-500';
    default: return 'bg-gray-500';
  }
}

/** Stripchat league color by user level */
export function getUserLeagueColor(level: number | null | undefined): string {
  if (level == null || level <= 0) return '#9CA3AF';
  if (level < 10) return '#9CA3AF';
  if (level < 20) return '#CD7F32';
  if (level < 35) return '#c9e7fe';
  if (level < 55) return '#FFD700';
  if (level < 80) return '#8A2BE2';
  if (level < 100) return '#FF4500';
  return '#FF0000';
}

/** Message type to display */
export function msgTypeLabel(type: string): string {
  const map: Record<string, string> = {
    chat: '💬', gift: '🎁', tip: '💰', enter: '🚪', leave: '👋', system: '⚙️',
  };
  return map[type] || type;
}
