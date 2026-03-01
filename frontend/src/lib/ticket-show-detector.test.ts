import { describe, it, expect } from 'vitest';
import { detectTicketShows } from './ticket-show-detector';
import type { TipMessage } from './ticket-show-detector';

// ============================================================
// detectTicketShows
// ============================================================
describe('detectTicketShows', () => {
  describe('正常系', () => {
    it('3件以上の同額チップ（30秒以内）をチケットショーとして検出', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 50, message_time: '2026-03-01T10:00:10Z', user_name: 'b' },
        { tokens: 50, message_time: '2026-03-01T10:00:20Z', user_name: 'c' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(1);
      expect(shows[0].ticket_price).toBe(50);
      expect(shows[0].estimated_attendees).toBe(3);
      expect(shows[0].ticket_revenue).toBe(150);
    });

    it('5件のチケット購入を検出', () => {
      const tips: TipMessage[] = Array.from({ length: 5 }, (_, i) => ({
        tokens: 100,
        message_time: `2026-03-01T10:00:${String(i * 5).padStart(2, '0')}Z`,
        user_name: `user${i}`,
      }));
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(1);
      expect(shows[0].estimated_attendees).toBe(5);
      expect(shows[0].ticket_revenue).toBe(500);
    });
  });

  describe('検出されないケース', () => {
    it('2件以下の同額チップは検出しない', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 50, message_time: '2026-03-01T10:00:10Z', user_name: 'b' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(0);
    });

    it('30秒以上離れた同額チップは検出しない', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 50, message_time: '2026-03-01T10:00:40Z', user_name: 'b' },
        { tokens: 50, message_time: '2026-03-01T10:01:20Z', user_name: 'c' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(0);
    });

    it('異なる金額のチップは検出しない', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 100, message_time: '2026-03-01T10:00:05Z', user_name: 'b' },
        { tokens: 200, message_time: '2026-03-01T10:00:10Z', user_name: 'c' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(0);
    });

    it('空配列', () => {
      expect(detectTicketShows([])).toEqual([]);
    });
  });

  describe('ソート', () => {
    it('時刻がバラバラでもソートされて正しく検出', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:20Z', user_name: 'c' },
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 50, message_time: '2026-03-01T10:00:10Z', user_name: 'b' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(1);
      expect(shows[0].started_at).toBe('2026-03-01T10:00:00Z');
      expect(shows[0].ended_at).toBe('2026-03-01T10:00:20Z');
    });
  });

  describe('tip_revenue（チケット外チップ）', () => {
    it('チケットショー中の異なる金額チップを tip_revenue に集計', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 50, message_time: '2026-03-01T10:00:05Z', user_name: 'b' },
        { tokens: 50, message_time: '2026-03-01T10:00:10Z', user_name: 'c' },
        { tokens: 50, message_time: '2026-03-01T10:00:15Z', user_name: 'd' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows).toHaveLength(1);
      expect(shows[0].tip_revenue).toBe(0); // 全部同額なので外部チップなし
    });
  });

  describe('フィールド検証', () => {
    it('必須フィールドが全て含まれる', () => {
      const tips: TipMessage[] = [
        { tokens: 50, message_time: '2026-03-01T10:00:00Z', user_name: 'a' },
        { tokens: 50, message_time: '2026-03-01T10:00:05Z', user_name: 'b' },
        { tokens: 50, message_time: '2026-03-01T10:00:10Z', user_name: 'c' },
      ];
      const shows = detectTicketShows(tips);
      expect(shows[0]).toHaveProperty('started_at');
      expect(shows[0]).toHaveProperty('ended_at');
      expect(shows[0]).toHaveProperty('ticket_price');
      expect(shows[0]).toHaveProperty('ticket_revenue');
      expect(shows[0]).toHaveProperty('estimated_attendees');
      expect(shows[0]).toHaveProperty('tip_revenue');
    });
  });
});
