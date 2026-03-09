/**
 * RPC 入出力型テスト
 *
 * Normalizer 出力が Supabase テーブルスキーマに適合するかを検証する。
 * RPC 関数の戻り値型を runtime assertion で確認する。
 *
 * - Unit テスト（常時実行）: 型適合チェック
 * - Integration テスト（SUPABASE_URL 要）: 実 RPC 呼び出しの戻り値スキーマ検証
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { normalizeMessage } from './message.js';
import { normalizeViewers } from './viewer.js';
import { normalizeSession } from './session.js';
import type { NormalizedMessage, NormalizedViewer, NormalizedSession } from './types.js';

// ============================================================
// Unit: Normalizer出力 → Supabase スキーマ適合
// ============================================================

describe('Normalizer → Supabase スキーマ適合', () => {
  // ----------------------------------------------------------
  // spy_messages テーブル
  // ----------------------------------------------------------
  describe('spy_messages テーブル', () => {
    const SPY_MESSAGES_COLUMNS = [
      'account_id', 'cast_name', 'message_time', 'msg_type',
      'user_name', 'message', 'tokens', 'is_vip',
      'session_id', 'user_league', 'user_level', 'metadata',
    ] as const;

    it('NormalizedMessage が spy_messages の全カラムを含む', () => {
      const msg = normalizeMessage({
        account_id: 'acc-1',
        cast_name: 'Risa_06',
        user_name: 'testUser',
        msg_type: 'chat',
        message: 'Hello',
        tokens: 0,
        message_time: '2026-03-01T12:00:00Z',
      })!;

      for (const col of SPY_MESSAGES_COLUMNS) {
        expect(msg).toHaveProperty(col);
      }
    });

    it('account_id が文字列型', () => {
      const msg = normalizeMessage({
        account_id: 'acc-1', cast_name: 'c', user_name: 'u',
        message_time: '2026-01-01T00:00:00Z',
      })!;
      expect(typeof msg.account_id).toBe('string');
    });

    it('tokens が非負整数', () => {
      const msg = normalizeMessage({
        account_id: 'a', cast_name: 'c', user_name: 'u',
        tokens: -5, message_time: '2026-01-01T00:00:00Z',
      })!;
      expect(msg.tokens).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(msg.tokens)).toBe(true);
    });

    it('msg_type が許可値のみ', () => {
      const allowed = new Set(['chat', 'tip', 'system']);
      for (const input of ['chat', 'tip', 'system', 'garbage', '', undefined]) {
        const msg = normalizeMessage({
          account_id: 'a', cast_name: 'c', user_name: 'u',
          msg_type: input, message_time: '2026-01-01T00:00:00Z',
        })!;
        expect(allowed.has(msg.msg_type)).toBe(true);
      }
    });

    it('message_time が有効な ISO 8601', () => {
      const msg = normalizeMessage({
        account_id: 'a', cast_name: 'c', user_name: 'u',
        message_time: '2026-03-01T12:00:00Z',
      })!;
      expect(new Date(msg.message_time).getTime()).not.toBeNaN();
    });

    it('metadata が JSONB 互換のオブジェクト', () => {
      const msg = normalizeMessage({
        account_id: 'a', cast_name: 'c', user_name: 'u',
        message_time: '2026-01-01T00:00:00Z',
        metadata: { key: 'value', nested: { a: 1 } },
      })!;
      // JSON.stringify できること = JSONB互換
      expect(() => JSON.stringify(msg.metadata)).not.toThrow();
      expect(typeof msg.metadata).toBe('object');
      expect(Array.isArray(msg.metadata)).toBe(false);
    });

    it('session_id が string | null', () => {
      const msg1 = normalizeMessage({
        account_id: 'a', cast_name: 'c', user_name: 'u',
        session_id: 'sess-123', message_time: '2026-01-01T00:00:00Z',
      })!;
      expect(typeof msg1.session_id === 'string' || msg1.session_id === null).toBe(true);

      const msg2 = normalizeMessage({
        account_id: 'a', cast_name: 'c', user_name: 'u',
        message_time: '2026-01-01T00:00:00Z',
      })!;
      expect(msg2.session_id).toBeNull();
    });
  });

  // ----------------------------------------------------------
  // sessions テーブル
  // ----------------------------------------------------------
  describe('sessions テーブル', () => {
    const UUID = '550e8400-e29b-41d4-a716-446655440000';
    const UUID2 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    const SESSIONS_COLUMNS = [
      'sessionId', 'accountId', 'castName', 'startedAt', 'endedAt',
    ] as const;

    it('NormalizedSession が sessions の全カラムを含む', () => {
      const sess = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'Risa_06', startedAt: '2026-03-01T10:00:00Z',
      })!;
      for (const col of SESSIONS_COLUMNS) {
        expect(sess).toHaveProperty(col);
      }
    });

    it('sessionId が UUID 形式', () => {
      const sess = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'c', startedAt: '2026-01-01T00:00:00Z',
      })!;
      expect(sess.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('accountId が UUID 形式', () => {
      const sess = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'c', startedAt: '2026-01-01T00:00:00Z',
      })!;
      expect(sess.accountId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('startedAt が有効な ISO 8601', () => {
      const sess = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'c', startedAt: '2026-03-01T10:00:00Z',
      })!;
      expect(new Date(sess.startedAt).getTime()).not.toBeNaN();
    });

    it('endedAt が null | 有効な ISO 8601', () => {
      const sess1 = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'c', startedAt: '2026-03-01T10:00:00Z',
      })!;
      expect(sess1.endedAt).toBeNull();

      const sess2 = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'c', startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T12:00:00Z',
      })!;
      expect(new Date(sess2.endedAt!).getTime()).not.toBeNaN();
    });

    it('endedAt >= startedAt が保証される', () => {
      const sess = normalizeSession({
        sessionId: UUID, accountId: UUID2,
        castName: 'c', startedAt: '2026-03-01T10:00:00Z',
        endedAt: '2026-03-01T12:00:00Z',
      })!;
      expect(new Date(sess.endedAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(sess.startedAt).getTime(),
      );
    });
  });

  // ----------------------------------------------------------
  // spy_viewers テーブル（viewer 正規化出力）
  // ----------------------------------------------------------
  describe('spy_viewers テーブル', () => {
    const VIEWER_FIELDS = [
      'userName', 'userIdStripchat', 'league', 'level', 'isFanClub', 'isNew',
    ] as const;

    it('NormalizedViewer が必要フィールドを全て含む', () => {
      const viewers = normalizeViewers([{
        userName: 'testUser', userIdStripchat: '123',
        league: 'gold', level: 10, isFanClub: false,
      }]);
      expect(viewers).toHaveLength(1);
      for (const field of VIEWER_FIELDS) {
        expect(viewers[0]).toHaveProperty(field);
      }
    });

    it('userName が非空文字列', () => {
      const viewers = normalizeViewers([{
        userName: 'alice', userIdStripchat: '1',
        league: 'gold', level: 5, isFanClub: false,
      }]);
      expect(viewers[0].userName.length).toBeGreaterThan(0);
    });

    it('level が非負整数', () => {
      const viewers = normalizeViewers([{
        userName: 'u', userIdStripchat: '1',
        league: '', level: -1, isFanClub: false,
      }]);
      expect(viewers[0].level).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(viewers[0].level)).toBe(true);
    });

    it('league が小文字', () => {
      const viewers = normalizeViewers([{
        userName: 'u', userIdStripchat: '1',
        league: 'DIAMOND', level: 0, isFanClub: false,
      }]);
      expect(viewers[0].league).toBe(viewers[0].league.toLowerCase());
    });

    it('isFanClub/isNew が boolean', () => {
      const viewers = normalizeViewers([{
        userName: 'u', userIdStripchat: '1',
        league: '', level: 0, isFanClub: false,
      }]);
      expect(typeof viewers[0].isFanClub).toBe('boolean');
      expect(typeof viewers[0].isNew).toBe('boolean');
    });
  });
});

// ============================================================
// Integration: 実 RPC の戻り値スキーマ検証
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || '940e7248-1d73-4259-a538-56fdaea9d740';
const canRun = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

describe.skipIf(!canRun)('RPC 戻り値スキーマ検証（Integration）', () => {
  let sb: import('@supabase/supabase-js').SupabaseClient;

  beforeAll(async () => {
    const { createClient } = await import('@supabase/supabase-js');
    sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  });

  // ----------------------------------------------------------
  // get_session_list_v2
  // ----------------------------------------------------------
  describe('get_session_list_v2', () => {
    it('戻り値の各行が必須フィールドを持つ', async () => {
      const { data, error } = await sb.rpc('get_session_list_v2', {
        p_account_id: ACCOUNT_ID,
      });
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);

      if (data && data.length > 0) {
        const row = data[0];
        expect(typeof row.session_id).toBe('string');
        expect(typeof row.cast_name).toBe('string');
        expect(typeof row.started_at).toBe('string');
      }
    });

    it('session_id が UUID 形式', async () => {
      const { data } = await sb.rpc('get_session_list_v2', {
        p_account_id: ACCOUNT_ID,
      });
      if (data && data.length > 0) {
        expect(data[0].session_id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      }
    });

    it('started_at が有効な ISO 8601', async () => {
      const { data } = await sb.rpc('get_session_list_v2', {
        p_account_id: ACCOUNT_ID,
      });
      if (data && data.length > 0) {
        expect(new Date(data[0].started_at).getTime()).not.toBeNaN();
      }
    });
  });

  // ----------------------------------------------------------
  // get_monthly_pl
  // ----------------------------------------------------------
  describe('get_monthly_pl', () => {
    it('戻り値の各行が必須フィールドと正しい型を持つ', async () => {
      const { data, error } = await sb.rpc('get_monthly_pl', {
        p_account_id: ACCOUNT_ID,
      });
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);

      if (data && data.length > 0) {
        const row = data[0];
        expect(typeof row.month).toBe('string');
        // 金額フィールドは数値
        const numericFields = ['coin_revenue', 'total_revenue', 'revenue'].filter(
          f => f in row,
        );
        expect(numericFields.length).toBeGreaterThan(0);
        for (const f of numericFields) {
          expect(typeof row[f]).toBe('number');
        }
      }
    });

    it('month が YYYY-MM 形式', async () => {
      const { data } = await sb.rpc('get_monthly_pl', {
        p_account_id: ACCOUNT_ID,
      });
      if (data && data.length > 0) {
        expect(data[0].month).toMatch(/^\d{4}-\d{2}/);
      }
    });
  });

  // ----------------------------------------------------------
  // check_spy_data_integrity
  // ----------------------------------------------------------
  describe('check_spy_data_integrity', () => {
    it('エラーなく実行でき結果がある', async () => {
      const { data, error } = await sb.rpc('check_spy_data_integrity', {
        p_account_id: ACCOUNT_ID,
      });
      expect(error).toBeNull();
      expect(data !== null && data !== undefined).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // get_cast_stats
  // ----------------------------------------------------------
  describe('get_cast_stats', () => {
    it('配列を返し各行に集計フィールドがある', async () => {
      const { data, error } = await sb.rpc('get_cast_stats', {
        p_account_id: ACCOUNT_ID,
        p_cast_names: ['Risa_06', 'hanshakun'],
      });
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);

      if (data && data.length > 0) {
        const row = data[0];
        expect(typeof row.cast_name).toBe('string');
      }
    });
  });

  // ----------------------------------------------------------
  // close_orphan_sessions
  // ----------------------------------------------------------
  describe('close_orphan_sessions', () => {
    it('数値を返す（閉じたセッション数）', async () => {
      const { data, error } = await sb.rpc('close_orphan_sessions', {
        p_stale_threshold: '6 hours',
      });
      expect(error).toBeNull();
      expect(typeof data).toBe('number');
    });
  });

  // ----------------------------------------------------------
  // refresh_segments
  // ----------------------------------------------------------
  describe('refresh_segments', () => {
    it('エラーなく実行できる', async () => {
      const { error } = await sb.rpc('refresh_segments', {
        p_account_id: ACCOUNT_ID,
      });
      expect(error).toBeNull();
    });
  });
});
