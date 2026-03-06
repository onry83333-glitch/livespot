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

/** Default coin rate: 1 token ≈ ¥7.7 */
export const COIN_RATE = 7.7;

/** Format tokens to JPY estimate (default 1tk ≈ ¥7.7, configurable per account) */
export function tokensToJPY(tokens: number, coinRate: number = COIN_RATE): string {
  return '\u00A5' + Math.round(tokens * coinRate).toLocaleString();
}

/** Format date to JST display */
export function formatJST(dateStr: string): string {
  return new Date(dateStr).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

/** Format tokens as dual currency: N tk (¥yen) — tk主表示・円副表示 */
export function formatCoinDual(tokens: number, coinRate: number = COIN_RATE): string {
  return `${tokens.toLocaleString()} tk (${tokensToJPY(tokens, coinRate)})`;
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

/** ユーザー名からハッシュベースの一貫した色を生成（方式Bフォールバック）
 * 同じユーザー名は常に同じ色。user_colorもuser_levelも取得できない場合に使用。
 */
export function getUserHashColor(userName: string | null | undefined): string {
  if (!userName) return '#9CA3AF';
  let hash = 0;
  for (let i = 0; i < userName.length; i++) {
    hash = userName.charCodeAt(i) + ((hash << 5) - hash);
  }
  // 彩度と明度を固定し、色相をハッシュで決定（暗い背景で読みやすい色）
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 65%)`;
}

// ============================================================
// 期間計算ユーティリティ（JST基準）
// ============================================================

/** JST今日0:00をUTCで返す */
export function getTodayStartJST(): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  return new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - 9 * 3600000
  );
}

/**
 * 週境界をUTCで返す（月曜03:00 JST = 送金サイクル区切り）
 * 月曜 0:00〜2:59 JST の売上は前週に計上される。
 * offset=0: 今週、offset=1: 先週
 */
export function getWeekStartJST(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  const day = jst.getUTCDay();
  const hour = jst.getUTCHours();
  let diff = day === 0 ? 6 : day - 1;
  if (day === 1 && hour < 3) diff = 7;
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() - diff - offset * 7);
  monday.setUTCHours(3, 0, 0, 0);
  return new Date(monday.getTime() - 9 * 3600000);
}

/**
 * JST月初1日0:00をUTCで返す。
 * offset=0: 今月、offset=1: 先月
 */
export function getMonthStartJST(offset = 0): Date {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth() - offset;
  return new Date(Date.UTC(y, m, 1) - 9 * 3600000);
}

/** Message type to display */
export function msgTypeLabel(type: string): string {
  const map: Record<string, string> = {
    chat: '💬', gift: '🎁', tip: '💰', goal: '🎯', enter: '🚪', leave: '👋', system: '⚙️', viewer_count: '📊',
  };
  return map[type] || type;
}
