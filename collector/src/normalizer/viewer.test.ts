import { describe, it, expect } from 'vitest';
import { normalizeViewers } from './viewer.js';
import type { RawViewer } from './types.js';

// ============================================================
// normalizeViewers — Unit Tests
// ============================================================

const validViewer: RawViewer = {
  userName: 'viewer1',
  userIdStripchat: '12345',
  league: 'Gold',
  level: 15,
  isFanClub: false,
};

describe('normalizeViewers', () => {
  // ----------------------------------------------------------
  // 正常系
  // ----------------------------------------------------------
  describe('正常系', () => {
    it('有効な視聴者を正規化できる', () => {
      const result = normalizeViewers([validViewer]);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('viewer1');
      expect(result[0].userIdStripchat).toBe('12345');
      expect(result[0].league).toBe('gold');
      expect(result[0].level).toBe(15);
      expect(result[0].isFanClub).toBe(false);
      expect(result[0].isNew).toBe(false);
    });

    it('複数の視聴者を正規化できる', () => {
      const viewers: RawViewer[] = [
        { userName: 'alice', userIdStripchat: '1', league: 'silver', level: 5, isFanClub: false },
        { userName: 'bob', userIdStripchat: '2', league: 'gold', level: 20, isFanClub: true },
      ];
      const result = normalizeViewers(viewers);
      expect(result).toHaveLength(2);
      expect(result[0].userName).toBe('alice');
      expect(result[1].userName).toBe('bob');
    });

    it('league が小文字に正規化される', () => {
      const result = normalizeViewers([{ ...validViewer, league: 'DIAMOND' }]);
      expect(result[0].league).toBe('diamond');
    });

    it('isFanClub=true が保持される', () => {
      const result = normalizeViewers([{ ...validViewer, isFanClub: true }]);
      expect(result[0].isFanClub).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // isNew 計算
  // ----------------------------------------------------------
  describe('isNew 計算', () => {
    it('existingUserNames に含まれない場合 isNew=true', () => {
      const existing = new Set(['existingUser']);
      const result = normalizeViewers([validViewer], existing);
      expect(result[0].isNew).toBe(true);
    });

    it('existingUserNames に含まれる場合 isNew=false', () => {
      const existing = new Set(['viewer1']);
      const result = normalizeViewers([validViewer], existing);
      expect(result[0].isNew).toBe(false);
    });

    it('existingUserNames が省略の場合 isNew=false', () => {
      const result = normalizeViewers([validViewer]);
      expect(result[0].isNew).toBe(false);
    });

    it('existingUserNames が空Setの場合 全員 isNew=true', () => {
      const result = normalizeViewers([validViewer], new Set());
      expect(result[0].isNew).toBe(true);
    });

    it('isNew はユーザー名の完全一致（大文字小文字区別）', () => {
      const existing = new Set(['Viewer1']); // 大文字V
      const result = normalizeViewers([validViewer], existing); // viewer1 小文字v
      expect(result[0].isNew).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 重複排除
  // ----------------------------------------------------------
  describe('重複排除', () => {
    it('同一 userName の重複を排除する（最初のみ残す）', () => {
      const viewers: RawViewer[] = [
        { userName: 'alice', userIdStripchat: '1', league: 'gold', level: 10, isFanClub: false },
        { userName: 'alice', userIdStripchat: '2', league: 'silver', level: 5, isFanClub: true },
      ];
      const result = normalizeViewers(viewers);
      expect(result).toHaveLength(1);
      expect(result[0].userIdStripchat).toBe('1'); // 最初のデータ
    });

    it('大文字小文字の違いも重複として扱う', () => {
      const viewers: RawViewer[] = [
        { userName: 'Alice', userIdStripchat: '1', league: 'gold', level: 10, isFanClub: false },
        { userName: 'alice', userIdStripchat: '2', league: 'silver', level: 5, isFanClub: false },
        { userName: 'ALICE', userIdStripchat: '3', league: 'bronze', level: 1, isFanClub: false },
      ];
      const result = normalizeViewers(viewers);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('Alice');
    });
  });

  // ----------------------------------------------------------
  // 異常系（除外）
  // ----------------------------------------------------------
  describe('異常系', () => {
    it('userName が空の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: '' }]);
      expect(result).toHaveLength(0);
    });

    it('userName が "unknown" の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: 'unknown' }]);
      expect(result).toHaveLength(0);
    });

    it('userName が "Unknown"（大文字）の場合もスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: 'Unknown' }]);
      expect(result).toHaveLength(0);
    });

    it('userName が "undefined" の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: 'undefined' }]);
      expect(result).toHaveLength(0);
    });

    it('userName が "null" の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: 'null' }]);
      expect(result).toHaveLength(0);
    });

    it('userName が null の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: null }]);
      expect(result).toHaveLength(0);
    });

    it('userName が undefined の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: undefined }]);
      expect(result).toHaveLength(0);
    });

    it('無効な視聴者を除外しつつ有効な視聴者は残す', () => {
      const viewers: RawViewer[] = [
        { userName: '', userIdStripchat: '1', league: '', level: 0, isFanClub: false },
        validViewer,
        { userName: 'unknown', userIdStripchat: '3', league: '', level: 0, isFanClub: false },
      ];
      const result = normalizeViewers(viewers);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('viewer1');
    });
  });

  // ----------------------------------------------------------
  // 境界値
  // ----------------------------------------------------------
  describe('境界値', () => {
    it('空配列は空配列を返す', () => {
      const result = normalizeViewers([]);
      expect(result).toEqual([]);
    });

    it('level が文字列 "10" の場合は数値 10 に変換される', () => {
      const result = normalizeViewers([{ ...validViewer, level: '10' }]);
      expect(result[0].level).toBe(10);
    });

    it('level が負数の場合は 0 になる', () => {
      const result = normalizeViewers([{ ...validViewer, level: -5 }]);
      expect(result[0].level).toBe(0);
    });

    it('level が null の場合は 0 になる', () => {
      const result = normalizeViewers([{ ...validViewer, level: null }]);
      expect(result[0].level).toBe(0);
    });

    it('league が null の場合は空文字になる', () => {
      const result = normalizeViewers([{ ...validViewer, league: null }]);
      expect(result[0].league).toBe('');
    });

    it('userIdStripchat が null の場合は空文字になる', () => {
      const result = normalizeViewers([{ ...validViewer, userIdStripchat: null }]);
      expect(result[0].userIdStripchat).toBe('');
    });

    it('isFanClub が "true"（文字列）の場合は false になる', () => {
      const result = normalizeViewers([{ ...validViewer, isFanClub: 'true' }]);
      expect(result[0].isFanClub).toBe(false);
    });

    it('userName 前後の空白はトリムされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: '  alice  ' }]);
      expect(result[0].userName).toBe('alice');
    });

    it('100人の大量バッチを処理できる', () => {
      const viewers: RawViewer[] = Array.from({ length: 100 }, (_, i) => ({
        userName: `user${i}`,
        userIdStripchat: String(i),
        league: 'gold',
        level: i,
        isFanClub: false,
      }));
      const result = normalizeViewers(viewers);
      expect(result).toHaveLength(100);
    });

    it('userIdStripchat が数値の場合は文字列に変換される', () => {
      const result = normalizeViewers([{ ...validViewer, userIdStripchat: 12345 }]);
      expect(result[0].userIdStripchat).toBe('12345');
      expect(typeof result[0].userIdStripchat).toBe('string');
    });

    it('level が小数の場合は切り捨てされる', () => {
      const result = normalizeViewers([{ ...validViewer, level: 15.7 }]);
      expect(result[0].level).toBe(15);
    });

    it('league が undefined の場合は空文字になる', () => {
      const result = normalizeViewers([{ ...validViewer, league: undefined }]);
      expect(result[0].league).toBe('');
    });

    it('isFanClub が null の場合は false になる', () => {
      const result = normalizeViewers([{ ...validViewer, isFanClub: null }]);
      expect(result[0].isFanClub).toBe(false);
    });

    it('isFanClub が 1（数値）の場合は false になる', () => {
      const result = normalizeViewers([{ ...validViewer, isFanClub: 1 }]);
      expect(result[0].isFanClub).toBe(false);
    });

    it('userName が "UNKNOWN"（全大文字）の場合はスキップされる', () => {
      const result = normalizeViewers([{ ...validViewer, userName: 'UNKNOWN' }]);
      expect(result).toHaveLength(0);
    });

    it('level が undefined の場合は 0 になる', () => {
      const result = normalizeViewers([{ ...validViewer, level: undefined }]);
      expect(result[0].level).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // 型安全性
  // ----------------------------------------------------------
  describe('型安全性', () => {
    it('常に配列を返す（null を返さない）', () => {
      const result = normalizeViewers([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it('各要素が NormalizedViewer の全キーを持つ', () => {
      const result = normalizeViewers([validViewer]);
      const keys = ['userName', 'userIdStripchat', 'league', 'level', 'isFanClub', 'isNew'];
      for (const key of keys) {
        expect(result[0]).toHaveProperty(key);
      }
    });

    it('level は常に number 型', () => {
      const result = normalizeViewers([{ ...validViewer, level: '42' }]);
      expect(typeof result[0].level).toBe('number');
    });

    it('isFanClub は常に boolean 型', () => {
      const result = normalizeViewers([validViewer]);
      expect(typeof result[0].isFanClub).toBe('boolean');
    });

    it('isNew は常に boolean 型', () => {
      const result = normalizeViewers([validViewer]);
      expect(typeof result[0].isNew).toBe('boolean');
    });
  });
});
