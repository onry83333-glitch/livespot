/**
 * normalizeViewers — 視聴者リストのバリデーション＋正規化
 *
 * バリデーションルール:
 *   1. userName: null/undefined/空文字/'unknown' → 除外
 *   2. 重複排除: userName で deduplicate（最初の出現を残す）
 *   3. userIdStripchat: 文字列に変換
 *   4. league: 文字列に変換、小文字正規化
 *   5. level: 非負整数に変換
 *   6. isFanClub: boolean に変換
 *   7. isNew: existingUserNames セットとの差分で計算
 */

import type { RawViewer, NormalizedViewer } from './types.js';

const REJECTED_USERNAMES = new Set(['unknown', 'undefined', 'null', '']);

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function asNonNegativeInt(v: unknown): number {
  if (typeof v === 'number') return Math.max(0, Math.floor(v));
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : Math.max(0, n);
  }
  return 0;
}

/**
 * 視聴者リストを正規化する。
 *
 * @param rawViewers パーサー出力の生視聴者リスト
 * @param existingUserNames 既にDBに存在するユーザー名のSet（isNew判定用、省略可）
 * @returns 正規化＋重複排除＋isNew付きの視聴者リスト
 */
export function normalizeViewers(
  rawViewers: RawViewer[],
  existingUserNames?: ReadonlySet<string>,
): NormalizedViewer[] {
  const seen = new Set<string>();
  const result: NormalizedViewer[] = [];

  for (const raw of rawViewers) {
    const userName = asString(raw.userName).trim();
    if (!userName || REJECTED_USERNAMES.has(userName.toLowerCase())) continue;

    // 重複排除
    const key = userName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const userIdStripchat = asString(raw.userIdStripchat);
    const league = asString(raw.league).toLowerCase();
    const level = asNonNegativeInt(raw.level);
    const isFanClub = raw.isFanClub === true;
    const isNew = existingUserNames ? !existingUserNames.has(userName) : false;

    result.push({
      userName,
      userIdStripchat,
      league,
      level,
      isFanClub,
      isNew,
    });
  }

  return result;
}
