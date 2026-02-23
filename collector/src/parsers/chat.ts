/**
 * Chat message parser — Centrifugo newChatMessage
 *
 * Stripchat Centrifugo v3 メッセージ構造:
 *   data.message.userData.username    — 送信者名
 *   data.message.details.body         — メッセージ本文
 *   data.message.details.amount       — チップ額 (tipのみ)
 *   data.message.type                 — "text" | "tip"
 *   data.message.createdAt            — ISO timestamp
 *   data.message.userData.userRanking.league — gold/diamond/...
 *   data.message.userData.userRanking.level  — 数値
 *   data.message.userData.isModel     — 配信者フラグ
 *   data.message.additionalData.isKing/isKnight
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function str(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

export interface CentrifugoChat {
  userName: string;
  message: string;
  tokens: number;
  msgType: 'chat' | 'tip';
  messageTime: string;
  userLeague: string;
  userLevel: number;
  isModel: boolean;
  isKing: boolean;
  isKnight: boolean;
  userIdStripchat: string;
  isFanClub: boolean;
}

/**
 * Centrifugo newChatMessage の data オブジェクトをパース。
 * poc.ts で確認したネスト構造に対応。
 */
export function parseCentrifugoChat(data: unknown): CentrifugoChat | null {
  if (!data || typeof data !== 'object') return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any;
  const m = d.message;
  if (!m || typeof m !== 'object') return null;

  const userData = m.userData;
  const details = m.details;
  const ranking = userData?.userRanking;
  const additionalData = m.additionalData;

  // ユーザー名: ネスト構造 → フラットフォールバック
  const userName = str(userData?.username)
    || str(userData?.screenName)
    || str(d.username)
    || '';

  if (!userName) return null;

  // メッセージ本文
  const message = str(details?.body)
    || str(details?.text)
    || str(d.message?.text)
    || '';

  // チップ額
  const tokens = num(details?.amount) || num(d.tokens) || 0;

  // メッセージタイプ
  const rawType = str(m.type);
  const msgType: 'chat' | 'tip' = (rawType === 'tip' || tokens > 0) ? 'tip' : 'chat';

  // タイムスタンプ: createdAt → receivedAt フォールバック
  const messageTime = str(m.createdAt) || new Date().toISOString();

  // ユーザー情報
  const userLeague = str(ranking?.league);
  const userLevel = num(ranking?.level);
  const isModel = userData?.isModel === true;
  const isKing = additionalData?.isKing === true;
  const isKnight = additionalData?.isKnight === true;
  const userIdStripchat = str(userData?.id);

  // ファンクラブ
  const fanClubMonths = num(details?.fanClubNumberMonthsOfSubscribed);
  const isFanClub = fanClubMonths > 0 || userData?.isFanClubMember === true;

  return {
    userName,
    message,
    tokens,
    msgType,
    messageTime,
    userLeague,
    userLevel,
    isModel,
    isKing,
    isKnight,
    userIdStripchat,
    isFanClub,
  };
}
