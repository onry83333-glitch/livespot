import { describe, it, expect } from 'vitest';
import { calculateCVR } from './cvr-calculator';
import type { ViewerSnapshot } from './cvr-calculator';

// ============================================================
// calculateCVR
// ============================================================
describe('calculateCVR', () => {
  const snapshot: ViewerSnapshot = {
    total: 100,
    coin_holders: 20,
    ultimate_count: 5,
  };

  describe('正常系', () => {
    it('overall_cvr を正しく計算', () => {
      const result = calculateCVR(snapshot, 10);
      expect(result.overall_cvr).toBe(10.0); // 10/100 * 100
    });

    it('coin_holder_cvr を正しく計算', () => {
      const result = calculateCVR(snapshot, 10);
      expect(result.coin_holder_cvr).toBe(50.0); // 10/20 * 100
    });

    it('attendees をそのまま返す', () => {
      const result = calculateCVR(snapshot, 7);
      expect(result.attendees).toBe(7);
    });

    it('snapshot のフィールドをコピー', () => {
      const result = calculateCVR(snapshot, 5);
      expect(result.total_viewers).toBe(100);
      expect(result.coin_holders).toBe(20);
      expect(result.ultimate_count).toBe(5);
    });

    it('小数点1桁に丸め', () => {
      const s: ViewerSnapshot = { total: 3, coin_holders: 7, ultimate_count: 0 };
      const result = calculateCVR(s, 1);
      // 1/3 * 100 = 33.333... → 33.3
      expect(result.overall_cvr).toBe(33.3);
    });
  });

  describe('snapshot が null の場合', () => {
    it('overall_cvr が null', () => {
      const result = calculateCVR(null, 5);
      expect(result.overall_cvr).toBeNull();
    });

    it('coin_holder_cvr が null', () => {
      const result = calculateCVR(null, 5);
      expect(result.coin_holder_cvr).toBeNull();
    });

    it('total_viewers が 0', () => {
      const result = calculateCVR(null, 5);
      expect(result.total_viewers).toBe(0);
      expect(result.coin_holders).toBe(0);
      expect(result.ultimate_count).toBe(0);
    });
  });

  describe('ゼロ除算', () => {
    it('total=0 の場合 overall_cvr は null', () => {
      const s: ViewerSnapshot = { total: 0, coin_holders: 10, ultimate_count: 0 };
      const result = calculateCVR(s, 5);
      expect(result.overall_cvr).toBeNull();
    });

    it('coin_holders=0 の場合 coin_holder_cvr は null', () => {
      const s: ViewerSnapshot = { total: 100, coin_holders: 0, ultimate_count: 0 };
      const result = calculateCVR(s, 5);
      expect(result.coin_holder_cvr).toBeNull();
    });
  });

  describe('境界値', () => {
    it('attendees=0', () => {
      const result = calculateCVR(snapshot, 0);
      expect(result.overall_cvr).toBe(0);
      expect(result.coin_holder_cvr).toBe(0);
    });

    it('100% CVR', () => {
      const s: ViewerSnapshot = { total: 10, coin_holders: 10, ultimate_count: 0 };
      const result = calculateCVR(s, 10);
      expect(result.overall_cvr).toBe(100.0);
      expect(result.coin_holder_cvr).toBe(100.0);
    });
  });
});
