/**
 * Supabase RPC Integration Test 雛形
 *
 * 実行方法:
 *   SUPABASE_URL=xxx SUPABASE_SERVICE_KEY=xxx npx vitest run src/parsers/rpc-integration.test.ts
 *
 * CI では環境変数が無いためスキップされる。
 * ローカルでのみ実行する integration test。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || '940e7248-1d73-4259-a538-56fdaea9d740';

const canRun = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

describe.skipIf(!canRun)('Supabase RPC Integration', () => {
  let sb: SupabaseClient;

  beforeAll(() => {
    sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  });

  // ============================================================
  // get_session_list_v2
  // ============================================================
  describe('get_session_list_v2', () => {
    it('配列を返す', async () => {
      const { data, error } = await sb.rpc('get_session_list_v2', {
        p_account_id: ACCOUNT_ID,
      });

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it('各行に必須フィールドが含まれる', async () => {
      const { data } = await sb.rpc('get_session_list_v2', {
        p_account_id: ACCOUNT_ID,
      });

      if (data && data.length > 0) {
        const row = data[0];
        // セッション基本情報
        expect(row).toHaveProperty('session_id');
        expect(row).toHaveProperty('cast_name');
        expect(row).toHaveProperty('started_at');
      }
    });

    it('cast_name フィルタが機能する', async () => {
      const { data, error } = await sb.rpc('get_session_list_v2', {
        p_account_id: ACCOUNT_ID,
        p_cast_name: 'Risa_06',
      });

      expect(error).toBeNull();
      if (data && data.length > 0) {
        for (const row of data) {
          expect(row.cast_name).toBe('Risa_06');
        }
      }
    });
  });

  // ============================================================
  // get_monthly_pl
  // ============================================================
  describe('get_monthly_pl', () => {
    it('配列を返す', async () => {
      const { data, error } = await sb.rpc('get_monthly_pl', {
        p_account_id: ACCOUNT_ID,
      });

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
    });

    it('各行にP/Lフィールドが含まれる', async () => {
      const { data } = await sb.rpc('get_monthly_pl', {
        p_account_id: ACCOUNT_ID,
      });

      if (data && data.length > 0) {
        const row = data[0];
        expect(row).toHaveProperty('month');
        // coin_revenue または total_revenue が存在
        expect(
          'coin_revenue' in row || 'total_revenue' in row || 'revenue' in row
        ).toBe(true);
      }
    });

    it('月の降順で返される', async () => {
      const { data } = await sb.rpc('get_monthly_pl', {
        p_account_id: ACCOUNT_ID,
      });

      if (data && data.length >= 2) {
        const months = data.map((r: Record<string, string>) => r.month);
        for (let i = 0; i < months.length - 1; i++) {
          expect(months[i] >= months[i + 1]).toBe(true);
        }
      }
    });
  });

  // ============================================================
  // check_spy_data_integrity
  // ============================================================
  describe('check_spy_data_integrity', () => {
    it('エラーなく実行できる', async () => {
      const { data, error } = await sb.rpc('check_spy_data_integrity', {
        p_account_id: ACCOUNT_ID,
      });

      expect(error).toBeNull();
      // data が配列またはオブジェクトであること
      expect(data !== null && data !== undefined).toBe(true);
    });

    it('整合性チェック結果に必須フィールドがある', async () => {
      const { data } = await sb.rpc('check_spy_data_integrity', {
        p_account_id: ACCOUNT_ID,
      });

      if (Array.isArray(data) && data.length > 0) {
        const row = data[0];
        // check_name or check_type が存在
        expect(
          'check_name' in row || 'check_type' in row || 'status' in row
        ).toBe(true);
      }
    });
  });
});
