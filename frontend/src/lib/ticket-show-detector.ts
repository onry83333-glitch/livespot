/**
 * チケットショー（チケチャ）検出ロジック
 *
 * 30秒以内に同額のチップが3件以上連続した場合、チケットショーと判定する。
 * チケット価格 = その繰り返し金額。
 */

export interface TipMessage {
  tokens: number;
  message_time: string;
  user_name: string;
}

export interface TicketShow {
  started_at: string;
  ended_at: string;
  ticket_price: number;
  ticket_revenue: number;
  estimated_attendees: number;
  tip_revenue: number; // non-ticket tips during the show
}

export function detectTicketShows(tipMessages: TipMessage[]): TicketShow[] {
  // Sort by time
  const sorted = [...tipMessages].sort(
    (a, b) =>
      new Date(a.message_time).getTime() - new Date(b.message_time).getTime()
  );

  const shows: TicketShow[] = [];
  let i = 0;

  while (i < sorted.length) {
    const amount = sorted[i].tokens;
    const streak = [sorted[i]];
    let j = i + 1;

    // Find consecutive same-amount tips within 30 seconds of each other
    while (
      j < sorted.length &&
      sorted[j].tokens === amount &&
      new Date(sorted[j].message_time).getTime() -
        new Date(streak[streak.length - 1].message_time).getTime() <
        30000
    ) {
      streak.push(sorted[j]);
      j++;
    }

    if (streak.length >= 3) {
      // Extend: keep collecting same-amount tips within 60s gaps
      let endIdx = j - 1;
      while (
        endIdx + 1 < sorted.length &&
        sorted[endIdx + 1].tokens === amount &&
        new Date(sorted[endIdx + 1].message_time).getTime() -
          new Date(sorted[endIdx].message_time).getTime() <
          60000
      ) {
        endIdx++;
      }

      const allInRange = sorted.slice(i, endIdx + 1);
      const ticketTips = allInRange.filter((t) => t.tokens === amount);
      const otherTips = allInRange.filter((t) => t.tokens !== amount);

      shows.push({
        started_at: streak[0].message_time,
        ended_at: sorted[endIdx].message_time,
        ticket_price: amount,
        ticket_revenue: ticketTips.reduce((s, t) => s + t.tokens, 0),
        estimated_attendees: ticketTips.length,
        tip_revenue: otherTips.reduce((s, t) => s + t.tokens, 0),
      });

      i = endIdx + 1;
    } else {
      i++;
    }
  }

  return shows;
}
