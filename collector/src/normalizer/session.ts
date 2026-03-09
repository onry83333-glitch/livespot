/**
 * normalizeSession — セッションデータのバリデーション＋正規化
 *
 * バリデーションルール:
 *   1. accountId: 非空文字列必須、UUID形式チェック
 *   2. castName: 非空文字列必須
 *   3. sessionId: 非空文字列必須、UUID形式チェック
 *   4. startedAt: ISO 8601 タイムスタンプ必須
 *   5. endedAt: 省略可、指定時はISO 8601 + startedAt以降であること
 */

import type { RawSession, NormalizedSession } from './types.js';

/** UUID v4/v5 形式の簡易検証（ハイフン付き36文字） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isValidIsoTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 10) return false;
  const d = new Date(v);
  return !isNaN(d.getTime());
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

export function normalizeSession(raw: RawSession): NormalizedSession | null {
  // --- 必須フィールド ---
  const accountId = asString(raw.accountId).trim();
  if (!isValidUuid(accountId)) return null;

  const castName = asString(raw.castName).trim();
  if (!castName) return null;

  const sessionId = asString(raw.sessionId).trim();
  if (!isValidUuid(sessionId)) return null;

  // --- startedAt 必須 ---
  if (!isValidIsoTimestamp(raw.startedAt)) return null;
  const startedAt = raw.startedAt;

  // --- endedAt オプション ---
  let endedAt: string | null = null;
  if (raw.endedAt !== undefined && raw.endedAt !== null) {
    if (!isValidIsoTimestamp(raw.endedAt)) return null;
    // endedAt は startedAt 以降でなければならない
    if (new Date(raw.endedAt).getTime() < new Date(startedAt).getTime()) return null;
    endedAt = raw.endedAt;
  }

  return {
    sessionId,
    accountId,
    castName,
    startedAt,
    endedAt,
  };
}
