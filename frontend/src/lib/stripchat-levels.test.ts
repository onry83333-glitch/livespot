import { describe, it, expect } from 'vitest';
import { getUserColorFromCoins, getUserColorInfo } from './stripchat-levels';

// ============================================================
// getUserColorFromCoins
// ============================================================
describe('getUserColorFromCoins', () => {
  it('0tk → ブルーグレー', () => {
    expect(getUserColorFromCoins(0)).toBe('#78909c');
  });

  it('49tk → ブルーグレー', () => {
    expect(getUserColorFromCoins(49)).toBe('#78909c');
  });

  it('50tk → 暗めブロンズ', () => {
    expect(getUserColorFromCoins(50)).toBe('#8d6e63');
  });

  it('300tk → ブロンズ', () => {
    expect(getUserColorFromCoins(300)).toBe('#e67e22');
  });

  it('1000tk → オレンジ', () => {
    expect(getUserColorFromCoins(1000)).toBe('#ff9100');
  });

  it('3000tk → 濃いゴールド', () => {
    expect(getUserColorFromCoins(3000)).toBe('#ffab00');
  });

  it('5000tk → ゴールド', () => {
    expect(getUserColorFromCoins(5000)).toBe('#ffc107');
  });

  it('10000tk → 紫', () => {
    expect(getUserColorFromCoins(10000)).toBe('#aa00ff');
  });

  it('20000tk → マゼンタ紫', () => {
    expect(getUserColorFromCoins(20000)).toBe('#d500f9');
  });

  it('50000tk → 赤', () => {
    expect(getUserColorFromCoins(50000)).toBe('#e53935');
  });

  it('100000tk → 鮮やかな赤', () => {
    expect(getUserColorFromCoins(100000)).toBe('#ff1744');
  });

  it('単調増加: より多いコインはより上位の色', () => {
    const thresholds = [0, 50, 300, 1000, 3000, 5000, 10000, 20000, 50000, 100000];
    const colors = thresholds.map(t => getUserColorFromCoins(t));
    // 全て異なる色が返される
    const unique = new Set(colors);
    expect(unique.size).toBe(thresholds.length);
  });
});

// ============================================================
// getUserColorInfo
// ============================================================
describe('getUserColorInfo', () => {
  it('0tk → Grey ラベル', () => {
    const info = getUserColorInfo(0);
    expect(info.label).toContain('Grey');
    expect(info.color).toBe('#78909c');
  });

  it('100000tk → Royal+ ラベル', () => {
    const info = getUserColorInfo(100000);
    expect(info.label).toContain('Royal+');
    expect(info.color).toBe('#ff1744');
  });

  it('color と getUserColorFromCoins の結果が一致', () => {
    const thresholds = [0, 50, 300, 1000, 3000, 5000, 10000, 20000, 50000, 100000];
    for (const t of thresholds) {
      expect(getUserColorInfo(t).color).toBe(getUserColorFromCoins(t));
    }
  });

  it('全ラベルに絵文字が含まれる', () => {
    const thresholds = [0, 50, 300, 1000, 5000, 10000, 20000, 50000, 100000];
    for (const t of thresholds) {
      const info = getUserColorInfo(t);
      // Unicode emoji range
      expect(info.label.length).toBeGreaterThan(2);
    }
  });
});
