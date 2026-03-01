import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatTokens,
  tokensToJPY,
  formatCoinDual,
  timeAgo,
  lifecycleColor,
  getUserLeagueColor,
  getUserHashColor,
  msgTypeLabel,
  COIN_RATE,
} from './utils';

// ============================================================
// formatTokens
// ============================================================
describe('formatTokens', () => {
  it('通常のトークン数をカンマ区切りで表示', () => {
    expect(formatTokens(1000)).toBe('1,000 tk');
  });

  it('0 トークン', () => {
    expect(formatTokens(0)).toBe('0 tk');
  });

  it('大きな数値', () => {
    expect(formatTokens(1234567)).toBe('1,234,567 tk');
  });

  it('小さな数値', () => {
    expect(formatTokens(5)).toBe('5 tk');
  });
});

// ============================================================
// COIN_RATE
// ============================================================
describe('COIN_RATE', () => {
  it('7.7 である', () => {
    expect(COIN_RATE).toBe(7.7);
  });
});

// ============================================================
// tokensToJPY
// ============================================================
describe('tokensToJPY', () => {
  it('デフォルトレート(7.7)で変換', () => {
    // 100 * 7.7 = 770
    expect(tokensToJPY(100)).toBe('\u00A5770');
  });

  it('0 トークン', () => {
    expect(tokensToJPY(0)).toBe('\u00A50');
  });

  it('カスタムレート', () => {
    // 100 * 10 = 1000
    expect(tokensToJPY(100, 10)).toBe('\u00A51,000');
  });

  it('小数点は四捨五入', () => {
    // 3 * 7.7 = 23.1 → ¥23
    expect(tokensToJPY(3)).toBe('\u00A523');
  });

  it('大きな値はカンマ区切り', () => {
    // 10000 * 7.7 = 77000
    expect(tokensToJPY(10000)).toBe('\u00A577,000');
  });
});

// ============================================================
// formatCoinDual
// ============================================================
describe('formatCoinDual', () => {
  it('デュアル表示: ¥yen (N tk)', () => {
    const result = formatCoinDual(100);
    expect(result).toBe('\u00A5770 (100 tk)');
  });

  it('0 トークン', () => {
    expect(formatCoinDual(0)).toBe('\u00A50 (0 tk)');
  });

  it('大きな値', () => {
    const result = formatCoinDual(10000);
    expect(result).toBe('\u00A577,000 (10,000 tk)');
  });
});

// ============================================================
// timeAgo
// ============================================================
describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('1分未満は「たった今」', () => {
    expect(timeAgo('2026-03-02T11:59:30Z')).toBe('たった今');
  });

  it('分単位の表示', () => {
    expect(timeAgo('2026-03-02T11:30:00Z')).toBe('30分前');
  });

  it('時間単位の表示', () => {
    expect(timeAgo('2026-03-02T09:00:00Z')).toBe('3時間前');
  });

  it('日単位の表示', () => {
    expect(timeAgo('2026-02-28T12:00:00Z')).toBe('2日前');
  });

  it('ちょうど1時間前', () => {
    expect(timeAgo('2026-03-02T11:00:00Z')).toBe('1時間前');
  });

  it('ちょうど1日前', () => {
    expect(timeAgo('2026-03-01T12:00:00Z')).toBe('1日前');
  });
});

// ============================================================
// lifecycleColor
// ============================================================
describe('lifecycleColor', () => {
  it('active → green', () => {
    expect(lifecycleColor('active')).toBe('bg-green-500');
  });

  it('dormant → yellow', () => {
    expect(lifecycleColor('dormant')).toBe('bg-yellow-500');
  });

  it('churned → red', () => {
    expect(lifecycleColor('churned')).toBe('bg-red-500');
  });

  it('new → blue', () => {
    expect(lifecycleColor('new')).toBe('bg-blue-500');
  });

  it('不明な値 → gray', () => {
    expect(lifecycleColor('unknown')).toBe('bg-gray-500');
    expect(lifecycleColor('')).toBe('bg-gray-500');
  });
});

// ============================================================
// getUserLeagueColor
// ============================================================
describe('getUserLeagueColor', () => {
  it('null → グレー', () => {
    expect(getUserLeagueColor(null)).toBe('#9CA3AF');
  });

  it('undefined → グレー', () => {
    expect(getUserLeagueColor(undefined)).toBe('#9CA3AF');
  });

  it('0 → グレー', () => {
    expect(getUserLeagueColor(0)).toBe('#9CA3AF');
  });

  it('負数 → グレー', () => {
    expect(getUserLeagueColor(-5)).toBe('#9CA3AF');
  });

  it('level 5 → グレー (1-9)', () => {
    expect(getUserLeagueColor(5)).toBe('#9CA3AF');
  });

  it('level 15 → ブロンズ (10-19)', () => {
    expect(getUserLeagueColor(15)).toBe('#CD7F32');
  });

  it('level 25 → シルバー (20-34)', () => {
    expect(getUserLeagueColor(25)).toBe('#c9e7fe');
  });

  it('level 40 → ゴールド (35-54)', () => {
    expect(getUserLeagueColor(40)).toBe('#FFD700');
  });

  it('level 60 → ダイアモンド (55-79)', () => {
    expect(getUserLeagueColor(60)).toBe('#8A2BE2');
  });

  it('level 90 → ロイヤル (80-99)', () => {
    expect(getUserLeagueColor(90)).toBe('#FF4500');
  });

  it('level 100 → レジェンド (100+)', () => {
    expect(getUserLeagueColor(100)).toBe('#FF0000');
  });

  // 境界値
  it('level 10 → ブロンズ（境界）', () => {
    expect(getUserLeagueColor(10)).toBe('#CD7F32');
  });

  it('level 9 → グレー（境界-1）', () => {
    expect(getUserLeagueColor(9)).toBe('#9CA3AF');
  });
});

// ============================================================
// getUserHashColor
// ============================================================
describe('getUserHashColor', () => {
  it('null → グレー', () => {
    expect(getUserHashColor(null)).toBe('#9CA3AF');
  });

  it('undefined → グレー', () => {
    expect(getUserHashColor(undefined)).toBe('#9CA3AF');
  });

  it('空文字 → グレー', () => {
    expect(getUserHashColor('')).toBe('#9CA3AF');
  });

  it('同じユーザー名は常に同じ色', () => {
    const color1 = getUserHashColor('testUser');
    const color2 = getUserHashColor('testUser');
    expect(color1).toBe(color2);
  });

  it('異なるユーザー名は異なる色の可能性が高い', () => {
    const color1 = getUserHashColor('alice');
    const color2 = getUserHashColor('bob');
    // 確率的に異なるはず（衝突は理論上ありえるが、この2名は異なる）
    expect(color1).not.toBe(color2);
  });

  it('HSL形式で返す', () => {
    const color = getUserHashColor('testUser');
    expect(color).toMatch(/^hsl\(\d+, 65%, 65%\)$/);
  });

  it('色相が 0-359 の範囲', () => {
    const color = getUserHashColor('testUser');
    const hue = parseInt(color.match(/hsl\((\d+)/)?.[1] || '-1');
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

// ============================================================
// msgTypeLabel
// ============================================================
describe('msgTypeLabel', () => {
  it('chat → 💬', () => {
    expect(msgTypeLabel('chat')).toBe('💬');
  });

  it('tip → 💰', () => {
    expect(msgTypeLabel('tip')).toBe('💰');
  });

  it('gift → 🎁', () => {
    expect(msgTypeLabel('gift')).toBe('🎁');
  });

  it('goal → 🎯', () => {
    expect(msgTypeLabel('goal')).toBe('🎯');
  });

  it('system → ⚙️', () => {
    expect(msgTypeLabel('system')).toBe('⚙️');
  });

  it('不明な型はそのまま返す', () => {
    expect(msgTypeLabel('unknown_type')).toBe('unknown_type');
  });
});
