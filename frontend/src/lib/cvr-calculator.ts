/**
 * チケットショーCVR（コンバージョン率）計算
 *
 * viewer_stats のスナップショットとチケット購入者数から CVR を計算する。
 */

export interface ViewerSnapshot {
  total: number;
  coin_holders: number;
  ultimate_count: number;
}

export interface TicketShowCVR {
  overall_cvr: number | null; // attendees / total_viewers * 100
  coin_holder_cvr: number | null; // attendees / coin_holders * 100
  total_viewers: number;
  coin_holders: number;
  ultimate_count: number;
  attendees: number;
}

export function calculateCVR(
  snapshot: ViewerSnapshot | null,
  attendees: number
): TicketShowCVR {
  return {
    overall_cvr:
      snapshot && snapshot.total > 0
        ? +((attendees / snapshot.total) * 100).toFixed(1)
        : null,
    coin_holder_cvr:
      snapshot && snapshot.coin_holders > 0
        ? +((attendees / snapshot.coin_holders) * 100).toFixed(1)
        : null,
    total_viewers: snapshot?.total || 0,
    coin_holders: snapshot?.coin_holders || 0,
    ultimate_count: snapshot?.ultimate_count || 0,
    attendees,
  };
}
