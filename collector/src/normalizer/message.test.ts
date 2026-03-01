import { describe, it, expect } from 'vitest';
import { normalizeMessage } from './message.js';
import type { RawMessage, NormalizedMessage } from './types.js';

// ============================================================
// normalizeMessage — Unit Tests
// ============================================================

/** 全必須フィールドが揃った最小限の有効入力 */
const validRaw: RawMessage = {
  account_id: 'acc-001',
  cast_name: 'Risa_06',
  user_name: 'testUser',
  msg_type: 'chat',
  message: 'Hello',
  tokens: 0,
  message_time: '2026-03-01T12:00:00Z',
};

describe('normalizeMessage', () => {
  // ----------------------------------------------------------
  // 正常系
  // ----------------------------------------------------------
  describe('正常系', () => {
    it('有効なメッセージを正規化できる', () => {
      const result = normalizeMessage(validRaw);
      expect(result).not.toBeNull();
      expect(result!.account_id).toBe('acc-001');
      expect(result!.cast_name).toBe('Risa_06');
      expect(result!.user_name).toBe('testUser');
      expect(result!.msg_type).toBe('chat');
      expect(result!.message).toBe('Hello');
      expect(result!.tokens).toBe(0);
      expect(result!.message_time).toBe('2026-03-01T12:00:00Z');
      expect(result!.is_vip).toBe(false);
      expect(result!.session_id).toBeNull();
      expect(result!.user_league).toBeNull();
      expect(result!.user_level).toBeNull();
      expect(result!.metadata).toEqual({});
    });

    it('tipメッセージのtokensが保持される', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'tip', tokens: 100 });
      expect(result!.msg_type).toBe('tip');
      expect(result!.tokens).toBe(100);
    });

    it('systemメッセージを受け入れる', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'system' });
      expect(result!.msg_type).toBe('system');
    });

    it('session_id が渡された場合に保持される', () => {
      const result = normalizeMessage({ ...validRaw, session_id: 'sess-123' });
      expect(result!.session_id).toBe('sess-123');
    });

    it('is_vip=true が保持される', () => {
      const result = normalizeMessage({ ...validRaw, is_vip: true });
      expect(result!.is_vip).toBe(true);
    });

    it('user_league と user_level が保持される', () => {
      const result = normalizeMessage({
        ...validRaw,
        user_league: 'gold',
        user_level: 15,
      });
      expect(result!.user_league).toBe('gold');
      expect(result!.user_level).toBe(15);
    });

    it('metadata オブジェクトが保持される', () => {
      const meta = { isKing: true, fanClubTier: 2 };
      const result = normalizeMessage({ ...validRaw, metadata: meta });
      expect(result!.metadata).toEqual(meta);
    });
  });

  // ----------------------------------------------------------
  // msg_type 正規化
  // ----------------------------------------------------------
  describe('msg_type 正規化', () => {
    it('不明な msg_type は "chat" にフォールバックする', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'unknown_type' });
      expect(result!.msg_type).toBe('chat');
    });

    it('msg_type 大文字 "TIP" が小文字 "tip" に正規化される', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'TIP' });
      expect(result!.msg_type).toBe('tip');
    });

    it('tokens > 0 なのに msg_type=chat の場合 tip に補正される', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'chat', tokens: 50 });
      expect(result!.msg_type).toBe('tip');
      expect(result!.tokens).toBe(50);
    });

    it('tokens > 0 + msg_type=system の場合は system のまま', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'system', tokens: 10 });
      expect(result!.msg_type).toBe('system');
    });
  });

  // ----------------------------------------------------------
  // tokens 正規化
  // ----------------------------------------------------------
  describe('tokens 正規化', () => {
    it('文字列 "50" が数値 50 に変換される', () => {
      const result = normalizeMessage({ ...validRaw, tokens: '50' });
      expect(result!.tokens).toBe(50);
    });

    it('負数は 0 に切り上げられる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: -10 });
      expect(result!.tokens).toBe(0);
    });

    it('小数は切り捨てられる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: 9.8 });
      expect(result!.tokens).toBe(9);
    });

    it('NaN 文字列は 0 になる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: 'abc' });
      expect(result!.tokens).toBe(0);
    });

    it('null は 0 になる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: null });
      expect(result!.tokens).toBe(0);
    });

    it('undefined は 0 になる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: undefined });
      expect(result!.tokens).toBe(0);
    });
  });

  // ----------------------------------------------------------
  // message_time 正規化
  // ----------------------------------------------------------
  describe('message_time 正規化', () => {
    it('有効な ISO 8601 タイムスタンプはそのまま保持される', () => {
      const result = normalizeMessage(validRaw);
      expect(result!.message_time).toBe('2026-03-01T12:00:00Z');
    });

    it('無効なタイムスタンプは現在時刻にフォールバックする', () => {
      const before = new Date().toISOString();
      const result = normalizeMessage({ ...validRaw, message_time: 'not-a-date' });
      const after = new Date().toISOString();
      expect(result!.message_time >= before).toBe(true);
      expect(result!.message_time <= after).toBe(true);
    });

    it('空文字は現在時刻にフォールバックする', () => {
      const result = normalizeMessage({ ...validRaw, message_time: '' });
      expect(new Date(result!.message_time).getTime()).not.toBeNaN();
    });

    it('null は現在時刻にフォールバックする', () => {
      const result = normalizeMessage({ ...validRaw, message_time: null });
      expect(new Date(result!.message_time).getTime()).not.toBeNaN();
    });
  });

  // ----------------------------------------------------------
  // 異常系（拒否）
  // ----------------------------------------------------------
  describe('異常系', () => {
    it('user_name が空の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: '' })).toBeNull();
    });

    it('user_name が "unknown" の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: 'unknown' })).toBeNull();
    });

    it('user_name が "Unknown"（大文字）の場合も null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: 'Unknown' })).toBeNull();
    });

    it('user_name が "undefined" の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: 'undefined' })).toBeNull();
    });

    it('user_name が "null" の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: 'null' })).toBeNull();
    });

    it('user_name が null の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: null })).toBeNull();
    });

    it('user_name が undefined の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: undefined })).toBeNull();
    });

    it('account_id が空の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, account_id: '' })).toBeNull();
    });

    it('account_id が null の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, account_id: null })).toBeNull();
    });

    it('cast_name が空の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, cast_name: '' })).toBeNull();
    });

    it('cast_name が null の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, cast_name: null })).toBeNull();
    });

    it('account_id が undefined の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, account_id: undefined })).toBeNull();
    });

    it('cast_name が undefined の場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, cast_name: undefined })).toBeNull();
    });

    it('user_name が空白のみの場合 null を返す', () => {
      expect(normalizeMessage({ ...validRaw, user_name: '   ' })).toBeNull();
    });

    it('全フィールド未設定（空オブジェクト）の場合 null を返す', () => {
      expect(normalizeMessage({})).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 境界値
  // ----------------------------------------------------------
  describe('境界値', () => {
    it('空の message は空文字列として保持される', () => {
      const result = normalizeMessage({ ...validRaw, message: '' });
      expect(result!.message).toBe('');
    });

    it('message の前後空白はトリムされる', () => {
      const result = normalizeMessage({ ...validRaw, message: '  hello  ' });
      expect(result!.message).toBe('hello');
    });

    it('user_name の前後空白はトリムされる', () => {
      const result = normalizeMessage({ ...validRaw, user_name: '  testUser  ' });
      expect(result!.user_name).toBe('testUser');
    });

    it('metadata が配列の場合は空オブジェクトになる', () => {
      const result = normalizeMessage({ ...validRaw, metadata: [1, 2, 3] });
      expect(result!.metadata).toEqual({});
    });

    it('metadata が null の場合は空オブジェクトになる', () => {
      const result = normalizeMessage({ ...validRaw, metadata: null });
      expect(result!.metadata).toEqual({});
    });

    it('is_vip が "true"（文字列）の場合は false になる', () => {
      const result = normalizeMessage({ ...validRaw, is_vip: 'true' });
      expect(result!.is_vip).toBe(false);
    });

    it('is_vip が 1（数値）の場合は false になる', () => {
      const result = normalizeMessage({ ...validRaw, is_vip: 1 });
      expect(result!.is_vip).toBe(false);
    });

    it('tokens が非常に大きい値でも正しく処理される', () => {
      const result = normalizeMessage({ ...validRaw, tokens: 999999 });
      expect(result!.tokens).toBe(999999);
    });

    it('user_level=0 は null ではなく 0 として保持される', () => {
      const result = normalizeMessage({ ...validRaw, user_level: 0 });
      expect(result!.user_level).toBe(0);
    });

    it('message が null の場合は空文字列になる', () => {
      const result = normalizeMessage({ ...validRaw, message: null });
      expect(result!.message).toBe('');
    });

    it('message が数値の場合は文字列に変換される', () => {
      const result = normalizeMessage({ ...validRaw, message: 42 });
      expect(result!.message).toBe('42');
    });

    it('tokens が boolean true の場合は 0 になる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: true });
      expect(result!.tokens).toBe(0);
    });

    it('tokens がオブジェクトの場合は 0 になる', () => {
      const result = normalizeMessage({ ...validRaw, tokens: {} });
      expect(result!.tokens).toBe(0);
    });

    it('metadata が文字列の場合は空オブジェクトになる', () => {
      const result = normalizeMessage({ ...validRaw, metadata: 'text' });
      expect(result!.metadata).toEqual({});
    });

    it('metadata が数値の場合は空オブジェクトになる', () => {
      const result = normalizeMessage({ ...validRaw, metadata: 123 });
      expect(result!.metadata).toEqual({});
    });

    it('session_id が数値の場合は文字列に変換される', () => {
      const result = normalizeMessage({ ...validRaw, session_id: 999 });
      expect(result!.session_id).toBe('999');
    });

    it('user_league が空文字の場合は null になる', () => {
      const result = normalizeMessage({ ...validRaw, user_league: '' });
      expect(result!.user_league).toBeNull();
    });

    it('user_level が undefined の場合は null になる', () => {
      const result = normalizeMessage({ ...validRaw, user_level: undefined });
      expect(result!.user_level).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // 型安全性（出力がNormalizedMessage型に適合するか）
  // ----------------------------------------------------------
  describe('型安全性', () => {
    it('戻り値が NormalizedMessage の全キーを持つ', () => {
      const result = normalizeMessage(validRaw)!;
      const requiredKeys = [
        'account_id', 'cast_name', 'message_time', 'msg_type',
        'user_name', 'message', 'tokens', 'is_vip',
        'session_id', 'user_league', 'user_level', 'metadata',
      ] as const;
      for (const key of requiredKeys) {
        expect(result).toHaveProperty(key as string);
      }
    });

    it('tokens は常に number 型', () => {
      const result = normalizeMessage({ ...validRaw, tokens: '42' })!;
      expect(typeof result.tokens).toBe('number');
    });

    it('is_vip は常に boolean 型', () => {
      const result = normalizeMessage(validRaw)!;
      expect(typeof result.is_vip).toBe('boolean');
    });

    it('msg_type は "chat" | "tip" | "system" のいずれか', () => {
      const result = normalizeMessage({ ...validRaw, msg_type: 'garbage' })!;
      expect(['chat', 'tip', 'system']).toContain(result.msg_type);
    });
  });
});
