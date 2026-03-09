import { describe, it, expect } from 'vitest';
import { parseTipEvent } from './tip.js';

// ============================================================
// parseTipEvent — Unit Tests
// ============================================================

describe('parseTipEvent', () => {
  // ----------------------------------------------------------
  // 正常系
  // ----------------------------------------------------------
  describe('正常系', () => {
    it('標準的な tip イベントをパースできる', () => {
      const raw = {
        castName: 'Risa_06',
        userName: 'bigFan',
        tokens: 500,
        type: 'tip',
        date: '2026-01-15T12:00:00Z',
        description: 'thank you',
      };

      const result = parseTipEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.castName).toBe('Risa_06');
      expect(result!.userName).toBe('bigFan');
      expect(result!.tokens).toBe(500);
      expect(result!.type).toBe('tip');
      expect(result!.date).toBe('2026-01-15T12:00:00Z');
      expect(result!.sourceDetail).toBe('thank you');
    });

    it('全ての TYPE_MAP エントリを正しくマッピングする', () => {
      const types = ['tip', 'gift', 'private', 'spy', 'ticket', 'group', 'striptease', 'cam2cam'];

      for (const t of types) {
        const result = parseTipEvent({ userName: 'u', tokens: 10, type: t });
        expect(result!.type).toBe(t);
      }
    });

    it('TYPE_MAP にない type はそのまま通す', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10, type: 'custom_type' });
      expect(result!.type).toBe('custom_type');
    });
  });

  // ----------------------------------------------------------
  // フィールド名フォールバック
  // ----------------------------------------------------------
  describe('フィールド名フォールバック', () => {
    it('user_name から userName を取得', () => {
      const result = parseTipEvent({ user_name: 'snakeUser', tokens: 10 });
      expect(result!.userName).toBe('snakeUser');
    });

    it('username から userName を取得', () => {
      const result = parseTipEvent({ username: 'lowerUser', tokens: 10 });
      expect(result!.userName).toBe('lowerUser');
    });

    it('amount から tokens を取得', () => {
      const result = parseTipEvent({ userName: 'u', amount: 250 });
      expect(result!.tokens).toBe(250);
    });

    it('cast_name から castName を取得', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10, cast_name: 'cast1' });
      expect(result!.castName).toBe('cast1');
    });

    it('createdAt から date を取得', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10, createdAt: '2026-02-01T00:00:00Z' });
      expect(result!.date).toBe('2026-02-01T00:00:00Z');
    });

    it('created_at から date を取得', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10, created_at: '2026-02-02T00:00:00Z' });
      expect(result!.date).toBe('2026-02-02T00:00:00Z');
    });

    it('source から type を取得', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10, source: 'gift' });
      expect(result!.type).toBe('gift');
    });

    it('sourceDetail から sourceDetail を取得', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10, sourceDetail: 'from API' });
      expect(result!.sourceDetail).toBe('from API');
    });
  });

  // ----------------------------------------------------------
  // 異常系
  // ----------------------------------------------------------
  describe('異常系', () => {
    it('null を渡すと null を返す', () => {
      expect(parseTipEvent(null)).toBeNull();
    });

    it('undefined を渡すと null を返す', () => {
      expect(parseTipEvent(undefined)).toBeNull();
    });

    it('プリミティブ値を渡すと null を返す', () => {
      expect(parseTipEvent('string')).toBeNull();
      expect(parseTipEvent(123)).toBeNull();
    });

    it('userName が空の場合は null を返す', () => {
      expect(parseTipEvent({ userName: '', tokens: 100 })).toBeNull();
    });

    it('tokens が 0 の場合は null を返す', () => {
      expect(parseTipEvent({ userName: 'user', tokens: 0 })).toBeNull();
    });

    it('tokens が負数の場合は null を返す', () => {
      expect(parseTipEvent({ userName: 'user', tokens: -5 })).toBeNull();
    });

    it('tokens フィールドが無い場合は null を返す', () => {
      expect(parseTipEvent({ userName: 'user' })).toBeNull();
    });

    it('userName フィールドが無い場合は null を返す', () => {
      expect(parseTipEvent({ tokens: 100 })).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 境界値
  // ----------------------------------------------------------
  describe('境界値', () => {
    it('tokens = 1 (最小有効値) でパース成功', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 1 });
      expect(result).not.toBeNull();
      expect(result!.tokens).toBe(1);
    });

    it('tokens が非常に大きい値でもパース成功', () => {
      const result = parseTipEvent({ userName: 'whale', tokens: 999999 });
      expect(result!.tokens).toBe(999999);
    });

    it('date が無い場合はデフォルト日時がセットされる', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10 });
      expect(result!.date).toBeTruthy();
      // 不正なISO文字列でないこと
      expect(result!.date).not.toBe('undefined');
    });

    it('castName が無い場合は空文字', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10 });
      expect(result!.castName).toBe('');
    });

    it('type が無い場合は "unknown"', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10 });
      expect(result!.type).toBe('unknown');
    });

    it('description が無い場合は空文字', () => {
      const result = parseTipEvent({ userName: 'u', tokens: 10 });
      expect(result!.sourceDetail).toBe('');
    });
  });
});
