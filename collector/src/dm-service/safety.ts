/**
 * DM送信安全機構
 *
 * P0-5: キャスト身元検証ゲート
 * - ログイン中のStripchatセッションと送信先キャストの照合
 * - 別キャストのアカウントでDMを送信しないようブロック
 *
 * テストモード:
 * - DM_TEST_MODE=true (デフォルト) でホワイトリスト外への送信をブロック
 * - 本番送信時のみ DM_TEST_MODE=false に明示設定する
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SessionData } from './stripchat-api.js';

// ============================================================
// Test mode (DM_TEST_MODE)
// ============================================================

/** テストモードがONか（デフォルト: true） */
export const DM_TEST_MODE = (process.env.DM_TEST_MODE ?? 'true').toLowerCase() !== 'false';

/** テスト送信を許可するSAKURAアカウントのホワイトリスト */
export const TEST_WHITELIST: ReadonlySet<string> = new Set([
  'pojipojipoji',
  'kantou1234',
  'Nekomeem34',
]);

/**
 * テストモード時にホワイトリスト外ユーザーへの送信をブロック
 * @returns ブロックすべき場合はエラーメッセージ、許可する場合はnull
 */
export function checkTestModeBlock(username: string): string | null {
  if (!DM_TEST_MODE) return null;
  if (TEST_WHITELIST.has(username)) return null;
  return `TEST MODE: blocked send to ${username} — ホワイトリスト外`;
}

// ============================================================
// Types
// ============================================================

export interface CastIdentityMap {
  /** cast_name → stripchat_user_id */
  map: Map<string, string>;
  /** セッションの stripchat_user_id */
  sessionUserId: string;
}

// ============================================================
// Session retrieval
// ============================================================

/**
 * 有効なStripchatセッションを取得
 */
export async function getActiveSession(
  sb: SupabaseClient,
  accountId: string,
): Promise<SessionData | null> {
  const { data, error } = await sb
    .from('stripchat_sessions')
    .select('id, account_id, session_cookie, csrf_token, csrf_timestamp, stripchat_user_id, front_version, cookies_json, jwt_token')
    .eq('account_id', accountId)
    .eq('is_valid', true)
    .maybeSingle();

  if (error || !data) return null;
  return data as SessionData;
}

/**
 * セッションを無効化
 */
export async function invalidateSession(
  sb: SupabaseClient,
  sessionId: string,
): Promise<void> {
  await sb
    .from('stripchat_sessions')
    .update({ is_valid: false, updated_at: new Date().toISOString() })
    .eq('id', sessionId);
}

// ============================================================
// Cast identity gate (P0-5)
// ============================================================

/**
 * キャスト身元検証マップを構築
 */
export async function buildCastIdentityMap(
  sb: SupabaseClient,
  accountId: string,
  sessionUserId: string,
): Promise<CastIdentityMap> {
  const { data: casts } = await sb
    .from('registered_casts')
    .select('cast_name, stripchat_user_id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .not('stripchat_user_id', 'is', null);

  const map = new Map<string, string>();
  if (casts) {
    for (const c of casts) {
      map.set(c.cast_name, String(c.stripchat_user_id));
    }
  }

  return { map, sessionUserId };
}

/**
 * タスクのcast_nameとセッションの身元が一致するか検証
 * @returns エラーメッセージ（不一致の場合）またはnull（OK）
 */
export function verifyCastIdentity(
  identity: CastIdentityMap,
  taskCastName: string,
): string | null {
  if (!taskCastName) return null; // cast_name未設定はスキップ

  const registeredId = identity.map.get(taskCastName);
  if (!registeredId) return null; // 未登録キャストはスキップ

  if (registeredId !== identity.sessionUserId) {
    return `CAST_IDENTITY_MISMATCH: cast=${taskCastName}(ID:${registeredId}) != session(${identity.sessionUserId})`;
  }

  return null;
}

// ============================================================
// Campaign format validation
// ============================================================

/**
 * campaign文字列が正規UIフローから発行されたものか検証
 * 'TEST' は E2Eテスト用として明示的に許可
 */
export function isValidCampaign(campaign: string): boolean {
  if (!campaign) return false;
  return (
    campaign === 'TEST' ||
    campaign.startsWith('pipe') ||
    campaign.startsWith('seq') ||
    campaign.startsWith('bulk') ||
    campaign.startsWith('trigger_') ||
    campaign.includes('_sched_')
  );
}

/**
 * campaign_idがNULL/空文字のDMを送信拒否するチェック
 * @returns ブロックすべき場合はtrue
 */
export function isMissingCampaign(campaign: string | null | undefined): boolean {
  return !campaign || campaign.trim() === '';
}

// ============================================================
// userId resolution with cache
// ============================================================

/**
 * paid_usersキャッシュ → Stripchat API フォールバック でuserId解決
 */
export async function resolveUserIdCached(
  sb: SupabaseClient,
  userName: string,
  accountId: string,
  castName: string,
): Promise<string | null> {
  // 1. paid_users キャッシュ
  const { data: cached } = await sb
    .from('paid_users')
    .select('user_id_stripchat')
    .eq('user_name', userName)
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .not('user_id_stripchat', 'is', null)
    .limit(1)
    .maybeSingle();

  if ((cached as Record<string, unknown>)?.user_id_stripchat) {
    return String((cached as Record<string, unknown>).user_id_stripchat);
  }

  return null;
}
