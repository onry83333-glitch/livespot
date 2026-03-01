/**
 * normalizeMessage — spy_messages 行のバリデーション＋正規化
 *
 * バリデーションルール:
 *   1. user_name: null/undefined/空文字/'unknown' → 拒否（return null）
 *   2. account_id: 空 → 拒否
 *   3. cast_name: 空 → 拒否
 *   4. msg_type: 'chat' | 'tip' | 'system' に正規化（不明値 → 'chat'）
 *   5. tokens: 数値に変換、NaN → 0、負数 → 0
 *   6. message_time: ISO 8601 検証、無効 → 現在時刻
 *   7. message: 文字列に変換、前後空白トリム
 *   8. is_vip: boolean に変換
 *   9. metadata: object でなければ空 {}
 */

import type { RawMessage, NormalizedMessage } from './types.js';

const VALID_MSG_TYPES = new Set(['chat', 'tip', 'system']);
const REJECTED_USERNAMES = new Set(['unknown', 'undefined', 'null', '']);

/** ISO 8601 タイムスタンプの簡易検証 */
function isValidIsoTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 10) return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}

/** unknown → string（空文字フォールバック） */
function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

/** unknown → 非負整数 */
function asNonNegativeInt(v: unknown): number {
  if (typeof v === 'number') return Math.max(0, Math.floor(v));
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : Math.max(0, n);
  }
  return 0;
}

export function normalizeMessage(raw: RawMessage): NormalizedMessage | null {
  // --- 必須フィールド ---
  const userName = asString(raw.user_name).trim();
  if (!userName || REJECTED_USERNAMES.has(userName.toLowerCase())) return null;

  const accountId = asString(raw.account_id).trim();
  if (!accountId) return null;

  const castName = asString(raw.cast_name).trim();
  if (!castName) return null;

  // --- msg_type 正規化 ---
  const rawType = asString(raw.msg_type).toLowerCase();
  const msgType = VALID_MSG_TYPES.has(rawType)
    ? (rawType as 'chat' | 'tip' | 'system')
    : 'chat';

  // --- tokens 正規化 ---
  const tokens = asNonNegativeInt(raw.tokens);

  // tip 整合性: tokens > 0 なのに msg_type が chat → tip に補正
  const finalMsgType = (tokens > 0 && msgType === 'chat') ? 'tip' : msgType;

  // --- message_time 正規化 ---
  const messageTime = isValidIsoTimestamp(raw.message_time)
    ? raw.message_time
    : new Date().toISOString();

  // --- その他フィールド ---
  const message = asString(raw.message).trim();
  const isVip = raw.is_vip === true;
  const sessionId = asString(raw.session_id) || null;

  const userLeague = asString(raw.user_league) || null;
  const userLevel = raw.user_level != null ? asNonNegativeInt(raw.user_level) : null;

  const metadata = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata))
    ? raw.metadata as Record<string, unknown>
    : {};

  return {
    account_id: accountId,
    cast_name: castName,
    message_time: messageTime,
    msg_type: finalMsgType,
    user_name: userName,
    message,
    tokens,
    is_vip: isVip,
    session_id: sessionId,
    user_league: userLeague,
    user_level: userLevel,
    metadata,
  };
}
