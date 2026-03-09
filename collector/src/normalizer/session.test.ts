import { describe, it, expect } from 'vitest';
import { normalizeSession } from './session.js';
import type { RawSession, NormalizedSession } from './types.js';

// ============================================================
// normalizeSession — Unit Tests
// ============================================================

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const validRaw: RawSession = {
  sessionId: VALID_UUID,
  accountId: VALID_UUID_2,
  castName: 'Risa_06',
  startedAt: '2026-03-01T10:00:00Z',
};

describe('normalizeSession', () => {
  // ----------------------------------------------------------
  // 正常系
  // ----------------------------------------------------------
  describe('正常系', () => {
    it('有効なセッションを正規化できる', () => {
      const result = normalizeSession(validRaw);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe(VALID_UUID);
      expect(result!.accountId).toBe(VALID_UUID_2);
      expect(result!.castName).toBe('Risa_06');
      expect(result!.startedAt).toBe('2026-03-01T10:00:00Z');
      expect(result!.endedAt).toBeNull();
    });

    it('endedAt がある場合に保持される', () => {
      const result = normalizeSession({
        ...validRaw,
        endedAt: '2026-03-01T12:00:00Z',
      });
      expect(result!.endedAt).toBe('2026-03-01T12:00:00Z');
    });

    it('endedAt が startedAt と同じ時刻でも有効', () => {
      const result = normalizeSession({
        ...validRaw,
        endedAt: '2026-03-01T10:00:00Z',
      });
      expect(result).not.toBeNull();
      expect(result!.endedAt).toBe('2026-03-01T10:00:00Z');
    });

    it('endedAt が null の場合は null のまま', () => {
      const result = normalizeSession({ ...validRaw, endedAt: null });
      expect(result!.endedAt).toBeNull();
    });

    it('endedAt が undefined の場合は null のまま', () => {
      const result = normalizeSession({ ...validRaw, endedAt: undefined });
      expect(result!.endedAt).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // UUID バリデーション
  // ----------------------------------------------------------
  describe('UUID バリデーション', () => {
    it('sessionId が UUID でない場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, sessionId: 'not-a-uuid' })).toBeNull();
    });

    it('accountId が UUID でない場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, accountId: 'not-a-uuid' })).toBeNull();
    });

    it('sessionId が空の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, sessionId: '' })).toBeNull();
    });

    it('accountId が空の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, accountId: '' })).toBeNull();
    });

    it('sessionId が null の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, sessionId: null })).toBeNull();
    });

    it('accountId が null の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, accountId: null })).toBeNull();
    });

    it('ハイフンなし UUID は拒否される', () => {
      expect(normalizeSession({
        ...validRaw,
        sessionId: '550e8400e29b41d4a716446655440000',
      })).toBeNull();
    });

    it('大文字 UUID は受け入れる', () => {
      const result = normalizeSession({
        ...validRaw,
        sessionId: '550E8400-E29B-41D4-A716-446655440000',
      });
      expect(result).not.toBeNull();
    });
  });

  // ----------------------------------------------------------
  // castName バリデーション
  // ----------------------------------------------------------
  describe('castName バリデーション', () => {
    it('castName が空の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, castName: '' })).toBeNull();
    });

    it('castName が null の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, castName: null })).toBeNull();
    });

    it('castName が空白のみの場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, castName: '   ' })).toBeNull();
    });

    it('castName の前後空白はトリムされる', () => {
      const result = normalizeSession({ ...validRaw, castName: '  Risa_06  ' });
      expect(result!.castName).toBe('Risa_06');
    });
  });

  // ----------------------------------------------------------
  // タイムスタンプ バリデーション
  // ----------------------------------------------------------
  describe('タイムスタンプ バリデーション', () => {
    it('startedAt が無効な場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, startedAt: 'not-a-date' })).toBeNull();
    });

    it('startedAt が空の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, startedAt: '' })).toBeNull();
    });

    it('startedAt が null の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, startedAt: null })).toBeNull();
    });

    it('endedAt が無効な日付の場合 null を返す', () => {
      expect(normalizeSession({
        ...validRaw,
        endedAt: 'invalid-date',
      })).toBeNull();
    });

    it('endedAt が startedAt より前の場合 null を返す', () => {
      expect(normalizeSession({
        ...validRaw,
        startedAt: '2026-03-01T12:00:00Z',
        endedAt: '2026-03-01T10:00:00Z',
      })).toBeNull();
    });

    it('タイムゾーン付き ISO 8601 を受け入れる', () => {
      const result = normalizeSession({
        ...validRaw,
        startedAt: '2026-03-01T10:00:00+09:00',
      });
      expect(result).not.toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 型安全性
  // ----------------------------------------------------------
  describe('型安全性', () => {
    it('戻り値が NormalizedSession の全キーを持つ', () => {
      const result = normalizeSession(validRaw)!;
      const keys: (keyof NormalizedSession)[] = [
        'sessionId', 'accountId', 'castName', 'startedAt', 'endedAt',
      ];
      for (const key of keys) {
        expect(result).toHaveProperty(key);
      }
    });

    it('endedAt が null | string のいずれか', () => {
      const withEnd = normalizeSession({ ...validRaw, endedAt: '2026-03-01T12:00:00Z' })!;
      expect(typeof withEnd.endedAt).toBe('string');

      const withoutEnd = normalizeSession(validRaw)!;
      expect(withoutEnd.endedAt).toBeNull();
    });

    it('全フィールドが string 型（endedAt 以外）', () => {
      const result = normalizeSession(validRaw)!;
      expect(typeof result.sessionId).toBe('string');
      expect(typeof result.accountId).toBe('string');
      expect(typeof result.castName).toBe('string');
      expect(typeof result.startedAt).toBe('string');
    });
  });

  // ----------------------------------------------------------
  // 追加エッジケース
  // ----------------------------------------------------------
  describe('追加エッジケース', () => {
    it('sessionId が undefined の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, sessionId: undefined })).toBeNull();
    });

    it('accountId が undefined の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, accountId: undefined })).toBeNull();
    });

    it('castName が undefined の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, castName: undefined })).toBeNull();
    });

    it('startedAt が undefined の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, startedAt: undefined })).toBeNull();
    });

    it('endedAt が空文字の場合 null を返す', () => {
      expect(normalizeSession({ ...validRaw, endedAt: '' })).toBeNull();
    });

    it('全フィールド未設定（空オブジェクト）の場合 null を返す', () => {
      expect(normalizeSession({})).toBeNull();
    });

    it('sessionId が数値の場合 null を返す（UUID形式ではない）', () => {
      expect(normalizeSession({ ...validRaw, sessionId: 12345 })).toBeNull();
    });

    it('accountId が数値の場合 null を返す（UUID形式ではない）', () => {
      expect(normalizeSession({ ...validRaw, accountId: 12345 })).toBeNull();
    });
  });
});
