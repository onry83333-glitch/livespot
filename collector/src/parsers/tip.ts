/**
 * Tip/gift event parser
 * Maps Stripchat transaction types to internal msg_type
 */

const TYPE_MAP: Record<string, string> = {
  tip: 'tip',
  gift: 'gift',
  private: 'private',
  spy: 'spy',
  ticket: 'ticket',
  group: 'group',
  striptease: 'striptease',
  cam2cam: 'cam2cam',
};

export interface TipEvent {
  castName: string;
  userName: string;
  tokens: number;
  type: string;
  date: string;
  sourceDetail: string;
}

export function parseTipEvent(raw: unknown): TipEvent | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  const userName = String(obj.userName || obj.user_name || obj.username || '');
  const tokens = Number(obj.tokens || obj.amount || 0);

  if (!userName || tokens <= 0) return null;

  const rawType = String(obj.type || obj.source || 'unknown');

  return {
    castName: String(obj.castName || obj.cast_name || ''),
    userName,
    tokens,
    type: TYPE_MAP[rawType] || rawType,
    date: String(obj.date || obj.createdAt || obj.created_at || new Date().toISOString()),
    sourceDetail: String(obj.description || obj.sourceDetail || ''),
  };
}
