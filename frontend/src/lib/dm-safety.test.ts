import { describe, it, expect } from 'vitest';
import { getRemainingDailyQuota, DEFAULT_DAILY_DM_LIMIT } from './dm-safety';

// ============================================================
// getRemainingDailyQuota（純粋関数のみテスト。async関数はDB依存のためスキップ）
// ============================================================
describe('getRemainingDailyQuota', () => {
  it('残りが正しく計算される', () => {
    const result = getRemainingDailyQuota({
      allowed: true,
      sentToday: 100,
      limit: 5000,
    });
    expect(result).toBe(4900);
  });

  it('上限到達時は 0', () => {
    const result = getRemainingDailyQuota({
      allowed: false,
      sentToday: 5000,
      limit: 5000,
      reason: '上限到達',
    });
    expect(result).toBe(0);
  });

  it('上限超過時でも負数にならない', () => {
    const result = getRemainingDailyQuota({
      allowed: false,
      sentToday: 5500,
      limit: 5000,
      reason: '上限超過',
    });
    expect(result).toBe(0);
  });

  it('未送信時は limit と同じ', () => {
    const result = getRemainingDailyQuota({
      allowed: true,
      sentToday: 0,
      limit: 5000,
    });
    expect(result).toBe(5000);
  });
});

// ============================================================
// DEFAULT_DAILY_DM_LIMIT
// ============================================================
describe('DEFAULT_DAILY_DM_LIMIT', () => {
  it('5000 である', () => {
    expect(DEFAULT_DAILY_DM_LIMIT).toBe(5000);
  });
});
