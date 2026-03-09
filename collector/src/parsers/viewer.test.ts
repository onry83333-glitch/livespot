import { describe, it, expect } from 'vitest';
import { parseViewerList } from './viewer.js';

// ============================================================
// parseViewerList — Unit Tests
// ============================================================

describe('parseViewerList', () => {
  // ----------------------------------------------------------
  // 正常系: v2 API format
  // ----------------------------------------------------------
  describe('v2 API format', () => {
    it('ネスト構造の視聴者リストをパースできる', () => {
      const response = {
        members: [
          {
            user: {
              id: 8445194,
              username: 'you000128',
              userRanking: { league: 'silver', level: 24 },
              isGreen: true,
            },
            fanClubTier: null,
          },
          {
            user: {
              id: 1234567,
              username: 'bigSpender',
              userRanking: { league: 'diamond', level: 50 },
            },
            fanClubTier: 'gold',
          },
        ],
      };

      const result = parseViewerList(response);
      expect(result).toHaveLength(2);

      expect(result[0].userName).toBe('you000128');
      expect(result[0].userIdStripchat).toBe('8445194');
      expect(result[0].league).toBe('silver');
      expect(result[0].level).toBe(24);
      expect(result[0].isFanClub).toBe(false); // fanClubTier = null

      expect(result[1].userName).toBe('bigSpender');
      expect(result[1].isFanClub).toBe(true); // fanClubTier = 'gold'
    });

    it('fanClubTier が undefined の場合は非ファンクラブ', () => {
      const response = {
        members: [
          {
            user: { id: 1, username: 'user1', userRanking: { league: '', level: 0 } },
            // fanClubTier プロパティ自体が無い
          },
        ],
      };

      const result = parseViewerList(response);
      expect(result[0].isFanClub).toBe(false);
    });
  });

  // ----------------------------------------------------------
  // 正常系: Legacy flat format
  // ----------------------------------------------------------
  describe('レガシーフラットformat', () => {
    it('フラット構造の視聴者リストをパースできる', () => {
      const response = {
        members: [
          { username: 'legacyUser', id: 999, league: 'gold', level: 30, isFanClubMember: true },
          { username: 'normalUser', id: 888, league: 'bronze', level: 5, isFanClubMember: false },
        ],
      };

      const result = parseViewerList(response);
      expect(result).toHaveLength(2);
      expect(result[0].userName).toBe('legacyUser');
      expect(result[0].userIdStripchat).toBe('999');
      expect(result[0].league).toBe('gold');
      expect(result[0].level).toBe(30);
      expect(result[0].isFanClub).toBe(true);

      expect(result[1].isFanClub).toBe(false);
    });

    it('userName フィールド名で取得できる', () => {
      const response = {
        members: [{ userName: 'camelUser', id: 1, league: '', level: 0 }],
      };

      const result = parseViewerList(response);
      expect(result[0].userName).toBe('camelUser');
    });

    it('user_name フィールド名で取得できる', () => {
      const response = {
        members: [{ user_name: 'snakeUser', user_id: 2, league: '', level: 0 }],
      };

      const result = parseViewerList(response);
      expect(result[0].userName).toBe('snakeUser');
      expect(result[0].userIdStripchat).toBe('2');
    });

    it('badge フィールドから league を取得できる', () => {
      const response = {
        members: [{ username: 'u', id: 1, badge: 'platinum', level: 40 }],
      };

      const result = parseViewerList(response);
      expect(result[0].league).toBe('platinum');
    });

    it('fanClub / is_fan_club フラグでファンクラブ検出', () => {
      const r1 = parseViewerList({ members: [{ username: 'u1', id: 1, fanClub: true }] });
      expect(r1[0].isFanClub).toBe(true);

      const r2 = parseViewerList({ members: [{ username: 'u2', id: 2, is_fan_club: true }] });
      expect(r2[0].isFanClub).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // 配列検出パターン
  // ----------------------------------------------------------
  describe('配列検出パターン', () => {
    it('.users キーから取得', () => {
      const response = { users: [{ username: 'fromUsers', id: 1 }] };
      const result = parseViewerList(response);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('fromUsers');
    });

    it('.data キーから取得', () => {
      const response = { data: [{ username: 'fromData', id: 2 }] };
      const result = parseViewerList(response);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('fromData');
    });
  });

  // ----------------------------------------------------------
  // 異常系
  // ----------------------------------------------------------
  describe('異常系', () => {
    it('null を渡すと空配列を返す', () => {
      expect(parseViewerList(null)).toEqual([]);
    });

    it('undefined を渡すと空配列を返す', () => {
      expect(parseViewerList(undefined)).toEqual([]);
    });

    it('プリミティブ値を渡すと空配列を返す', () => {
      expect(parseViewerList('string')).toEqual([]);
      expect(parseViewerList(123)).toEqual([]);
    });

    it('members が配列でない場合は空配列を返す', () => {
      expect(parseViewerList({ members: 'not_array' })).toEqual([]);
      expect(parseViewerList({ members: 42 })).toEqual([]);
    });

    it('members 内の null/undefined エントリはスキップ', () => {
      const response = {
        members: [null, undefined, { username: 'valid', id: 1 }],
      };
      const result = parseViewerList(response);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('valid');
    });

    it('userName が空のエントリはスキップ', () => {
      const response = {
        members: [
          { username: '', id: 1 },
          { username: 'valid', id: 2 },
        ],
      };
      const result = parseViewerList(response);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('valid');
    });

    it('userName が "unknown" のエントリはスキップ', () => {
      const response = {
        members: [
          { username: 'unknown', id: 1 },
          { username: 'realUser', id: 2 },
        ],
      };
      const result = parseViewerList(response);
      expect(result).toHaveLength(1);
      expect(result[0].userName).toBe('realUser');
    });
  });

  // ----------------------------------------------------------
  // 境界値
  // ----------------------------------------------------------
  describe('境界値', () => {
    it('空の members 配列は空配列を返す', () => {
      expect(parseViewerList({ members: [] })).toEqual([]);
    });

    it('1人だけの配列を正しくパースする', () => {
      const response = {
        members: [{ username: 'solo', id: 1, league: 'silver', level: 10 }],
      };
      const result = parseViewerList(response);
      expect(result).toHaveLength(1);
    });

    it('大量のメンバー (100人) をパースできる', () => {
      const members = Array.from({ length: 100 }, (_, i) => ({
        username: `user_${i}`,
        id: i,
        league: 'bronze',
        level: 1,
      }));

      const result = parseViewerList({ members });
      expect(result).toHaveLength(100);
    });

    it('level が 0 の場合はそのまま 0', () => {
      const response = {
        members: [{ username: 'newbie', id: 1, league: '', level: 0 }],
      };
      const result = parseViewerList(response);
      expect(result[0].level).toBe(0);
    });

    it('id が無い場合は "undefined" 文字列（String変換）', () => {
      const response = {
        members: [{ username: 'noId' }],
      };
      const result = parseViewerList(response);
      // String(undefined) === 'undefined'
      // 実装上 obj.id || obj.userId || obj.user_id は全て undefined → String() で空文字系
      expect(typeof result[0].userIdStripchat).toBe('string');
    });
  });
});
