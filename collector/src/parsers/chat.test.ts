import { describe, it, expect } from 'vitest';
import { parseCentrifugoChat } from './chat.js';

// ============================================================
// parseCentrifugoChat — Unit Tests
// ============================================================

describe('parseCentrifugoChat', () => {
  // ----------------------------------------------------------
  // 正常系
  // ----------------------------------------------------------
  describe('正常系', () => {
    it('v3 ネスト構造のチャットメッセージをパースできる', () => {
      const data = {
        message: {
          userData: {
            username: 'testUser',
            id: '12345',
            userRanking: { league: 'gold', level: 15 },
            isModel: false,
          },
          details: { body: 'Hello world', amount: 0 },
          type: 'text',
          createdAt: '2026-01-15T12:00:00Z',
          additionalData: { isKing: false, isKnight: false },
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result).not.toBeNull();
      expect(result!.userName).toBe('testUser');
      expect(result!.message).toBe('Hello world');
      expect(result!.tokens).toBe(0);
      expect(result!.msgType).toBe('chat');
      expect(result!.messageTime).toBe('2026-01-15T12:00:00Z');
      expect(result!.userLeague).toBe('gold');
      expect(result!.userLevel).toBe(15);
      expect(result!.isModel).toBe(false);
      expect(result!.isKing).toBe(false);
      expect(result!.isKnight).toBe(false);
      expect(result!.userIdStripchat).toBe('12345');
      expect(result!.isFanClub).toBe(false);
    });

    it('tipメッセージ（type="tip"）を正しく判定する', () => {
      const data = {
        message: {
          userData: { username: 'tipper', id: '99' },
          details: { body: 'Nice!', amount: 50 },
          type: 'tip',
          createdAt: '2026-01-15T12:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.msgType).toBe('tip');
      expect(result!.tokens).toBe(50);
    });

    it('tokens > 0 の場合は type が text でも tip と判定する', () => {
      const data = {
        message: {
          userData: { username: 'user1', id: '1' },
          details: { body: '', amount: 100 },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.msgType).toBe('tip');
      expect(result!.tokens).toBe(100);
    });

    it('King/Knight/Model フラグを正しく検出する', () => {
      const data = {
        message: {
          userData: { username: 'vip', id: '7', isModel: true },
          details: { body: '' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
          additionalData: { isKing: true, isKnight: true },
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.isModel).toBe(true);
      expect(result!.isKing).toBe(true);
      expect(result!.isKnight).toBe(true);
    });

    it('ファンクラブ — fanClubNumberMonthsOfSubscribed で検出', () => {
      const data = {
        message: {
          userData: { username: 'fan', id: '8' },
          details: { body: '', fanClubNumberMonthsOfSubscribed: 3 },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.isFanClub).toBe(true);
    });

    it('ファンクラブ — isFanClubMember で検出', () => {
      const data = {
        message: {
          userData: { username: 'fan2', id: '9', isFanClubMember: true },
          details: { body: '' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.isFanClub).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // フォールバック
  // ----------------------------------------------------------
  describe('フォールバック', () => {
    it('screenName からユーザー名を取得する', () => {
      const data = {
        message: {
          userData: { screenName: 'fallbackUser', id: '10' },
          details: { body: 'msg' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.userName).toBe('fallbackUser');
    });

    it('d.username からフラットフォールバックで取得する', () => {
      const data = {
        username: 'flatUser',
        message: {
          userData: {},
          details: { body: 'msg' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.userName).toBe('flatUser');
    });

    it('details.text からメッセージ本文を取得する', () => {
      const data = {
        message: {
          userData: { username: 'user' },
          details: { text: 'alt body' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.message).toBe('alt body');
    });

    it('d.tokens からトークン額を取得する', () => {
      const data = {
        tokens: 200,
        message: {
          userData: { username: 'user' },
          details: {},
          type: 'tip',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.tokens).toBe(200);
    });

    it('createdAt が無い場合は現在時刻がセットされる', () => {
      const data = {
        message: {
          userData: { username: 'user' },
          details: { body: 'msg' },
          type: 'text',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.messageTime).toBeTruthy();
      // ISO文字列であること
      expect(() => new Date(result!.messageTime)).not.toThrow();
    });
  });

  // ----------------------------------------------------------
  // 異常系
  // ----------------------------------------------------------
  describe('異常系', () => {
    it('null を渡すと null を返す', () => {
      expect(parseCentrifugoChat(null)).toBeNull();
    });

    it('undefined を渡すと null を返す', () => {
      expect(parseCentrifugoChat(undefined)).toBeNull();
    });

    it('プリミティブ値を渡すと null を返す', () => {
      expect(parseCentrifugoChat('string')).toBeNull();
      expect(parseCentrifugoChat(123)).toBeNull();
      expect(parseCentrifugoChat(true)).toBeNull();
    });

    it('message フィールドが無いと null を返す', () => {
      expect(parseCentrifugoChat({})).toBeNull();
      expect(parseCentrifugoChat({ foo: 'bar' })).toBeNull();
    });

    it('message がオブジェクトでないと null を返す', () => {
      expect(parseCentrifugoChat({ message: 'string' })).toBeNull();
      expect(parseCentrifugoChat({ message: 42 })).toBeNull();
    });

    it('userName が空の場合は null を返す', () => {
      const data = {
        message: {
          userData: { username: '' },
          details: { body: 'msg' },
          type: 'text',
        },
      };
      expect(parseCentrifugoChat(data)).toBeNull();
    });

    it('userData が無い場合は null を返す (userName が取れない)', () => {
      const data = {
        message: {
          details: { body: 'msg' },
          type: 'text',
        },
      };
      expect(parseCentrifugoChat(data)).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 境界値
  // ----------------------------------------------------------
  describe('境界値', () => {
    it('tokens = 0 の tip type は tip と判定する', () => {
      const data = {
        message: {
          userData: { username: 'user' },
          details: { amount: 0 },
          type: 'tip',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      // type=tip なので tokens=0 でも tip になる
      expect(result!.msgType).toBe('tip');
    });

    it('tokens = 1 (最小チップ) で tip と判定', () => {
      const data = {
        message: {
          userData: { username: 'user' },
          details: { amount: 1 },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.msgType).toBe('tip');
      expect(result!.tokens).toBe(1);
    });

    it('文字列の数値を正しく変換する', () => {
      const data = {
        message: {
          userData: {
            username: 'user',
            id: 999,
            userRanking: { league: 'silver', level: '25' },
          },
          details: { body: 'msg', amount: '150' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.tokens).toBe(150);
      expect(result!.userLevel).toBe(25);
      expect(result!.userIdStripchat).toBe('999');
    });

    it('ranking が存在しない場合はデフォルト値', () => {
      const data = {
        message: {
          userData: { username: 'user', id: '1' },
          details: { body: '' },
          type: 'text',
          createdAt: '2026-01-01T00:00:00Z',
        },
      };

      const result = parseCentrifugoChat(data);
      expect(result!.userLeague).toBe('');
      expect(result!.userLevel).toBe(0);
    });
  });
});
