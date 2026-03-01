/**
 * coin-sync.ts — Collectorからのコイン同期
 *
 * Chrome拡張が停止していても、Stripchat Earnings APIを呼び出し
 * coin_transactionsを更新する。
 *
 * Cookie取得の優先順位（4層フォールバック）:
 *   0a. .auth/stripchat-state.json（coin-auth保存済みセッション）
 *   0b. cookies.json / ss_cookies.json / cookie_header.txt（ファイル）
 *   1.  stripchat_sessions DB（Chrome拡張保存）
 *   2.  Login API直叩き（STRIPCHAT_USERNAME/PASSWORD設定時、ブラウザ不要）
 *
 * フロー:
 *   1. registered_casts から自社キャスト一覧取得
 *   2. 認証cookie取得（ファイル → DB → Playwrightフォールバック）
 *   3. Stripchat /api/front/users/{uid}/transactions を呼び出し
 *   4. coin_transactions に UPSERT
 *   5. refresh_paying_users + refresh_segments RPC実行
 */

import { getSupabase, PLAYWRIGHT_CONFIG } from './config.js';
import { createLogger } from './utils/logger.js';
import { loadSavedSession } from './coin-auth.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const log = createLogger('coin-sync');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_JSON_FILE = path.join(__dirname, '..', 'cookies.json');
const SS_COOKIES_JSON_FILE = path.join(__dirname, '..', '..', 'ss_cookies.json');
const COOKIE_HEADER_FILE = path.join(__dirname, '..', '..', 'cookie_header.txt');

const EARNINGS_API = 'https://stripchat.com/api/front/users';
const MAX_PAGES = 20;
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 600;
const BATCH_SIZE = 500;

interface StripchatSession {
  account_id: string;
  cookies_json: Record<string, string> | null;
  stripchat_user_id: string | null;
  is_valid: boolean;
}

interface RegisteredCast {
  account_id: string;
  cast_name: string;
  stripchat_model_id: string | null;
  stripchat_user_id: string | null;
}

interface Transaction {
  id?: number;
  userName?: string;
  user_name?: string;
  username?: string;
  userId?: number;
  tokens?: number;
  amount?: number;
  type?: string;
  source?: string;
  date?: string;
  createdAt?: string;
  created_at?: string;
  description?: string;
  sourceDetail?: string;
  isAnonymous?: boolean | number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * cookies.json / ss_cookies.json / cookie_header.txt からcookieを読み込み
 * 検索順: cookies.json → ss_cookies.json → cookie_header.txt
 */
function loadCookiesJsonFile(accountId: string): {
  cookieHeader: string; userId: string; cookiesJson: Record<string, string>;
} | null {
  // 方式A: cookies.json（Chrome拡張保存フォーマット: {cookies: {...}}）
  const resultA = tryLoadCookiesJson(COOKIES_JSON_FILE, accountId);
  if (resultA) return resultA;

  // 方式B: ss_cookies.json（プロジェクトルート: [{cookies_json: {...}}]）
  const resultB = tryLoadSsCookiesJson(accountId);
  if (resultB) return resultB;

  // 方式C: cookie_header.txt（生Cookie文字列）
  const resultC = tryLoadCookieHeaderTxt();
  if (resultC) return resultC;

  return null;
}

function tryLoadCookiesJson(filePath: string, accountId: string): {
  cookieHeader: string; userId: string; cookiesJson: Record<string, string>;
} | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const cookies: Record<string, string> = raw.cookies || {};
    if (Object.keys(cookies).length === 0) return null;

    if (raw.account_id && raw.account_id !== accountId) {
      log.debug('cookies.json account_id不一致');
      return null;
    }

    return extractAuthFromCookies(cookies, 'cookies.json');
  } catch {
    return null;
  }
}

function tryLoadSsCookiesJson(accountId: string): {
  cookieHeader: string; userId: string; cookiesJson: Record<string, string>;
} | null {
  try {
    if (!fs.existsSync(SS_COOKIES_JSON_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SS_COOKIES_JSON_FILE, 'utf-8'));

    // フォーマット: [{cookies_json: {...}}] or {cookies_json: {...}}
    let cookies: Record<string, string> | null = null;
    if (Array.isArray(raw) && raw.length > 0) {
      cookies = raw[0].cookies_json || raw[0].cookies || null;
    } else if (raw.cookies_json) {
      cookies = raw.cookies_json;
    } else if (raw.cookies) {
      cookies = raw.cookies;
    }

    if (!cookies || Object.keys(cookies).length === 0) return null;
    return extractAuthFromCookies(cookies, 'ss_cookies.json');
  } catch {
    return null;
  }
}

function tryLoadCookieHeaderTxt(): {
  cookieHeader: string; userId: string; cookiesJson: Record<string, string>;
} | null {
  try {
    if (!fs.existsSync(COOKIE_HEADER_FILE)) return null;
    const headerStr = fs.readFileSync(COOKIE_HEADER_FILE, 'utf-8').trim();
    if (!headerStr) return null;

    // Cookie文字列をパース
    const cookies: Record<string, string> = {};
    for (const pair of headerStr.split('; ')) {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        cookies[pair.substring(0, idx)] = pair.substring(idx + 1);
      }
    }
    if (Object.keys(cookies).length === 0) return null;
    return extractAuthFromCookies(cookies, 'cookie_header.txt');
  } catch {
    return null;
  }
}

/**
 * Cookie辞書から認証情報を抽出（共通処理）
 * userId: stripchat_com_userId Cookie → AMP cookie内のuserId → 空文字
 */
function extractAuthFromCookies(
  cookies: Record<string, string>,
  source: string,
): { cookieHeader: string; userId: string; cookiesJson: Record<string, string> } | null {
  const userId = cookies['stripchat_com_userId'] || '';
  const isLogged = cookies['isLogged'] === '1';
  const hasSessionId = !!cookies['stripchat_com_sessionId'];

  if (!userId && !(isLogged && hasSessionId)) {
    log.debug(`${source} に認証cookieなし`);
    return null;
  }

  // AMP cookieからuserIdを抽出（stripchat_com_userId がない場合のフォールバック）
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    resolvedUserId = extractUserIdFromAmpCookie(cookies['AMP_19a23394ad'] || '') || '';
  }

  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  log.info(`${source} から認証cookie検出 (isLogged=${isLogged}, userId=${resolvedUserId || '(未解決)'})`);
  return { cookieHeader, userId: resolvedUserId, cookiesJson: cookies };
}

/**
 * AMP cookie (base64エンコードJSON) から userId を抽出
 */
function extractUserIdFromAmpCookie(ampValue: string): string | null {
  if (!ampValue) return null;
  try {
    const decoded = Buffer.from(ampValue, 'base64').toString('utf-8');
    // AMP cookieはbase64(URLエンコードJSON)形式のため、decodeURIComponent必要
    let jsonStr = decoded;
    if (decoded.includes('%7B') || decoded.includes('%22')) {
      jsonStr = decodeURIComponent(decoded);
    }
    const json = JSON.parse(jsonStr);
    if (json.userId) return String(json.userId);
  } catch { /* ignore */ }
  return null;
}

/**
 * Stripchat Login APIで認証cookie取得（ブラウザ不要）
 * STRIPCHAT_USERNAME + STRIPCHAT_PASSWORD が .env に設定されている場合のみ動作
 *
 * API: POST https://stripchat.com/api/front/auth/login
 * Body: { loginOrEmail, password }
 * Response: Set-Cookie ヘッダーに認証cookie
 */
async function refreshCookiesViaApi(
  accountId: string,
): Promise<{ cookieHeader: string; userId: string } | null> {
  const { username, password } = PLAYWRIGHT_CONFIG;
  if (!username || !password) {
    log.warn('APIログイン不可 — STRIPCHAT_USERNAME/PASSWORDがcollector/.envに未設定');
    return null;
  }

  log.info(`[${accountId}] Stripchat Login APIでcookie取得開始...`);

  try {
    const resp = await fetch('https://stripchat.com/api/front/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Origin: 'https://stripchat.com',
        Referer: 'https://stripchat.com/login',
      },
      body: JSON.stringify({ loginOrEmail: username, password }),
      redirect: 'manual', // Set-Cookieヘッダーをキャプチャするため
    });

    if (!resp.ok && resp.status !== 301 && resp.status !== 302) {
      const body = await resp.text().catch(() => '');
      log.warn(`[${accountId}] Login API ${resp.status}: ${body.substring(0, 200)}`);
      return null;
    }

    // Set-Cookieヘッダーからcookieを抽出
    const setCookies = resp.headers.getSetCookie?.() || [];
    const cookiesJson: Record<string, string> = {};
    for (const sc of setCookies) {
      const nameVal = sc.split(';')[0];
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx > 0) {
        cookiesJson[nameVal.substring(0, eqIdx)] = nameVal.substring(eqIdx + 1);
      }
    }

    // レスポンスボディからもuserIdを取得
    let userId = cookiesJson['stripchat_com_userId'] || '';
    let bodyData: { user?: { id?: number }; data?: { user?: { id?: number } } } = {};
    try {
      bodyData = await resp.json() as typeof bodyData;
      const bodyUserId = bodyData?.user?.id || bodyData?.data?.user?.id;
      if (bodyUserId && !userId) {
        userId = String(bodyUserId);
      }
    } catch { /* body parse optional */ }

    if (!userId) {
      // AMP cookieからフォールバック
      userId = extractUserIdFromAmpCookie(cookiesJson['AMP_19a23394ad'] || '') || '';
    }

    if (!userId) {
      log.warn(`[${accountId}] Login API成功だがuserId取得不可 — cookies: ${Object.keys(cookiesJson).join(', ')}`);
      return null;
    }

    const cookieHeader = Object.entries(cookiesJson).map(([k, v]) => `${k}=${v}`).join('; ');
    log.info(`[${accountId}] Login API成功 (userId=${userId}, cookies=${Object.keys(cookiesJson).length}個)`);

    // stripchat_sessions更新
    const sb = getSupabase();
    await sb.from('stripchat_sessions').upsert({
      account_id: accountId,
      cookies_json: cookiesJson,
      stripchat_user_id: userId,
      is_valid: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });

    return { cookieHeader, userId };
  } catch (err) {
    log.error(`[${accountId}] Login APIエラー`, err);
    return null;
  }
}

/**
 * 全自社キャストのコイン同期を実行
 */
export async function runCoinSync(): Promise<void> {
  const sb = getSupabase();

  // 1. 自社キャスト一覧
  const { data: casts, error: castErr } = await sb
    .from('registered_casts')
    .select('account_id, cast_name, stripchat_model_id, stripchat_user_id')
    .eq('is_active', true);

  if (castErr || !casts || casts.length === 0) {
    log.warn('自社キャスト取得失敗またはゼロ件', castErr);
    return;
  }

  log.info(`コイン同期開始: ${casts.length}キャスト`);

  // account_id ごとにグループ化
  const byAccount = new Map<string, RegisteredCast[]>();
  for (const c of casts) {
    const list = byAccount.get(c.account_id) || [];
    list.push(c);
    byAccount.set(c.account_id, list);
  }

  let overallSuccess = false;
  let failureReason = '';

  for (const [accountId, accountCasts] of byAccount) {
    const result = await syncAccount(sb, accountId, accountCasts);

    // Earnings API 403 → Login APIでcookieリフレッシュしてリトライ
    if (result === 'auth_failed') {
      log.info(`[${accountId}] Login APIでcookie自動取得を試行...`);
      const fresh = await refreshCookiesViaApi(accountId);
      if (fresh) {
        const retryResult = await syncAccountCasts(sb, accountId, accountCasts, fresh.userId, fresh.cookieHeader, true);
        if (retryResult === 'ok') {
          overallSuccess = true;
        } else {
          failureReason = 'Login APIリトライ後も認証失敗';
        }
      } else {
        failureReason = '認証cookie期限切れ — collector/.envにSTRIPCHAT_USERNAME/PASSWORDを設定してください';
        log.error(`[${accountId}] ${failureReason}`);
      }
    } else if (result === 'ok') {
      overallSuccess = true;
    }

    // MV + セグメント更新（成功時のみ実行）
    if (overallSuccess) {
      try {
        await sb.rpc('refresh_paying_users');
        log.info(`[${accountId}] refresh_paying_users 完了`);
      } catch {
        log.debug('refresh_paying_users スキップ');
      }

      try {
        await sb.rpc('refresh_segments', { p_account_id: accountId });
        log.info(`[${accountId}] refresh_segments 完了`);
      } catch {
        log.debug('refresh_segments スキップ');
      }
    }
  }

  // 5. pipeline_status 更新（実際の結果を反映）
  try {
    await sb.from('pipeline_status').upsert(
      {
        pipeline_name: 'CoinSync',
        status: 'auto',
        source: 'Stripchat Earnings API',
        destination: 'coin_transactions',
        detail: overallSuccess
          ? `${casts.length}キャスト同期完了`
          : `同期失敗: ${failureReason || '不明なエラー'}`,
        last_run_at: new Date().toISOString(),
        last_success: overallSuccess,
        error_message: overallSuccess ? null : failureReason,
      },
      { onConflict: 'pipeline_name' },
    );
  } catch {
    log.debug('pipeline_status更新スキップ');
  }

  if (overallSuccess) {
    log.info('コイン同期完了');
  } else {
    log.error(`コイン同期失敗: ${failureReason}`);
  }
}

/**
 * 1アカウントのcookie取得 + userId解決 + キャスト同期
 * @returns 'ok' | 'auth_failed' | 'skipped'
 */
async function syncAccount(
  sb: ReturnType<typeof getSupabase>,
  accountId: string,
  accountCasts: RegisteredCast[],
): Promise<'ok' | 'auth_failed' | 'skipped'> {
  // 認証方式の可用性ログ
  const savedSession = loadSavedSession();
  const cookieFileExists = fs.existsSync(SS_COOKIES_JSON_FILE) || fs.existsSync(COOKIES_JSON_FILE) || fs.existsSync(COOKIE_HEADER_FILE);
  log.info(`[${accountId}] 認証チェーン: state.json=${savedSession ? 'あり' : 'なし'}, cookieファイル=${cookieFileExists ? 'あり' : 'なし'}, LoginAPI=${PLAYWRIGHT_CONFIG.username ? '可' : '不可'}`);

  // 方式0a: 保存済みセッション（npm run coin-auth で取得したもの）を最優先
  if (savedSession) {
    log.info(`[${accountId}] 保存済みセッションを検出 (userId=${savedSession.userId})`);
    const result = await syncAccountCasts(
      sb, accountId, accountCasts, savedSession.userId, savedSession.cookieHeader, true,
    );
    if (result === 'ok') return 'ok';
    log.warn(`[${accountId}] 保存済みセッションが期限切れ — DBフォールバック`);
  }

  // 方式0b: ファイルからcookie読み込み（cookies.json / ss_cookies.json / cookie_header.txt）
  const cookiesFromFile = loadCookiesJsonFile(accountId);
  if (cookiesFromFile) {
    // userId が空の場合はregistered_castsからフォールバック
    let fileUserId = cookiesFromFile.userId;
    if (!fileUserId) {
      const fallbackId = accountCasts[0]?.stripchat_user_id || accountCasts[0]?.stripchat_model_id;
      if (fallbackId) fileUserId = String(fallbackId);
    }
    if (!fileUserId) {
      log.warn(`[${accountId}] cookieファイル: userId解決不可`);
    } else {
      log.info(`[${accountId}] cookieファイルから認証情報を検出 (userId=${fileUserId})`);
    }
    const result = fileUserId
      ? await syncAccountCasts(sb, accountId, accountCasts, fileUserId, cookiesFromFile.cookieHeader, true)
      : 'auth_failed' as const;
    if (result === 'ok') {
      // 成功 → stripchat_sessions も更新
      await sb.from('stripchat_sessions').upsert({
        account_id: accountId,
        cookies_json: cookiesFromFile.cookiesJson,
        stripchat_user_id: fileUserId,
        is_valid: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' });
      return 'ok';
    }
    log.warn(`[${accountId}] cookieファイルのcookieも期限切れ`);
  }

  // 方式1: stripchat_sessions から有効なcookieを取得（is_valid=falseも試行）
  const { data: sessions, error: sessErr } = await sb
    .from('stripchat_sessions')
    .select('account_id, cookies_json, stripchat_user_id, is_valid')
    .eq('account_id', accountId)
    .order('is_valid', { ascending: false }) // true を先に
    .limit(1);

  if (sessErr || !sessions || sessions.length === 0) {
    log.warn(`[${accountId}] stripchat_sessionなし`);
    return 'auth_failed'; // Playwrightフォールバック対象
  }

  const sess = sessions[0] as StripchatSession;
  if (!sess.is_valid) {
    log.info(`[${accountId}] is_valid=false のセッションを試行（期限切れの可能性あり）`);
  }
  if (!sess.cookies_json || Object.keys(sess.cookies_json).length === 0) {
    log.warn(`[${accountId}] cookies_jsonが空`);
    return 'auth_failed';
  }

  // Cookie文字列を構築（userId解決で使うため先に定義）
  const cookieHeader = Object.entries(sess.cookies_json)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  let userId = sess.stripchat_user_id;

  // stripchat_user_id が未設定の場合、cookies_json から自動取得
  if (!userId) {
    const cookieUserId = sess.cookies_json?.['stripchat_com_userId'];
    if (cookieUserId) {
      userId = String(cookieUserId);
      log.info(`[${accountId}] cookies_jsonからuserId取得: ${userId}`);
      await sb
        .from('stripchat_sessions')
        .update({ stripchat_user_id: userId })
        .eq('account_id', accountId)
        .eq('is_valid', true);
    }
  }

  // API /user/me で自動検出
  if (!userId) {
    try {
      const meResp = await fetch('https://stripchat.com/api/front/v2/user/me', {
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (meResp.ok) {
        const meData = (await meResp.json()) as { user?: { id?: number } };
        if (meData.user?.id) {
          userId = String(meData.user.id);
          log.info(`[${accountId}] API /user/me からuserId取得: ${userId}`);
          await sb
            .from('stripchat_sessions')
            .update({ stripchat_user_id: userId })
            .eq('account_id', accountId)
            .eq('is_valid', true);
        }
      } else {
        log.warn(`[${accountId}] /user/me HTTP ${meResp.status}`);
      }
    } catch (err) {
      log.warn(`[${accountId}] /user/me 取得失敗`, err);
    }
  }

  // /initial-dynamic API フォールバック（/user/me が 404 の場合）
  if (!userId) {
    try {
      const dynResp = await fetch('https://stripchat.com/api/front/v2/initial-dynamic?requestType=initial', {
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (dynResp.ok) {
        const dynData = (await dynResp.json()) as {
          initialDynamic?: { user?: { id?: number } };
          user?: { id?: number };
        };
        const dynUserId = dynData?.initialDynamic?.user?.id || dynData?.user?.id;
        if (dynUserId && dynUserId > 0) {
          userId = String(dynUserId);
          log.info(`[${accountId}] API /initial-dynamic からuserId取得: ${userId}`);
          await sb
            .from('stripchat_sessions')
            .update({ stripchat_user_id: userId })
            .eq('account_id', accountId)
            .eq('is_valid', true);
        }
      } else {
        log.warn(`[${accountId}] /initial-dynamic HTTP ${dynResp.status}`);
      }
    } catch (err) {
      log.warn(`[${accountId}] /initial-dynamic 取得失敗`, err);
    }
  }

  // 最終フォールバック: registered_casts.stripchat_user_id → stripchat_model_id
  if (!userId) {
    const registeredUserId = accountCasts[0]?.stripchat_user_id;
    const modelId = accountCasts[0]?.stripchat_model_id;
    const fallbackId = registeredUserId || modelId;
    if (fallbackId) {
      userId = String(fallbackId);
      log.info(`[${accountId}] registered_castsからuserId取得: ${userId}`);
    }
  }

  if (!userId) {
    log.warn(`[${accountId}] userId取得不可 (cookie keys: ${Object.keys(sess.cookies_json).join(', ')})`);
    return 'auth_failed';
  }

  // 認証判定: stripchat_com_userId cookie または isLogged=1 + 有効なsessionId
  const hasUserIdCookie = !!sess.cookies_json?.['stripchat_com_userId'];
  const hasLoggedFlag = sess.cookies_json?.['isLogged'] === '1';
  const hasSessionId = !!sess.cookies_json?.['stripchat_com_sessionId'];
  const isAuthenticated = hasUserIdCookie || (hasLoggedFlag && hasSessionId);

  if (!isAuthenticated) {
    log.warn(`[${accountId}] ゲストcookieのみ（isLogged=${sess.cookies_json?.['isLogged']}, sessionId=${hasSessionId}）— Earnings API呼び出しをスキップ`);
    return 'auth_failed';
  }

  log.info(`[${accountId}] 認証済み (userId=${userId}, isLogged=${hasLoggedFlag}, userIdCookie=${hasUserIdCookie})`);
  const result = await syncAccountCasts(sb, accountId, accountCasts, userId, cookieHeader, isAuthenticated);

  // API成功 → is_valid=false だった場合は true に復元
  if (result === 'ok' && !sess.is_valid) {
    log.info(`[${accountId}] セッション有効確認 → is_valid=true に復元`);
    await sb
      .from('stripchat_sessions')
      .update({ is_valid: true, updated_at: new Date().toISOString() })
      .eq('account_id', accountId);
  }

  return result;
}

/**
 * アカウント内の全キャストを同期
 */
async function syncAccountCasts(
  sb: ReturnType<typeof getSupabase>,
  accountId: string,
  accountCasts: RegisteredCast[],
  userId: string,
  cookieHeader: string,
  isAuthenticated: boolean,
): Promise<'ok' | 'auth_failed' | 'skipped'> {
  let authFailed = false;

  for (const cast of accountCasts) {
    try {
      const result = await syncCastCoins(accountId, cast.cast_name, userId, cookieHeader, isAuthenticated);
      if (result === 'auth_failed') authFailed = true;
    } catch (err) {
      log.error(`[${cast.cast_name}] コイン同期失敗`, err);
    }
  }

  return authFailed ? 'auth_failed' : 'ok';
}

/**
 * 1キャストのコイン同期
 */
async function syncCastCoins(
  accountId: string,
  castName: string,
  userId: string,
  cookieHeader: string,
  isAuthenticated = true,
): Promise<'ok' | 'auth_failed'> {
  const sb = getSupabase();

  // 最終同期日を取得（差分同期用）
  const { data: lastTx } = await sb
    .from('coin_transactions')
    .select('synced_at')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .order('synced_at', { ascending: false })
    .limit(1);

  const lastSyncedAt = lastTx?.[0]?.synced_at;
  // 差分: 最終同期から1日バッファ引き
  const sinceDate = lastSyncedAt
    ? new Date(new Date(lastSyncedAt).getTime() - 24 * 60 * 60 * 1000)
    : null;

  log.info(
    `[${castName}] 差分同期開始 (since=${sinceDate?.toISOString() || 'フル同期'})`,
  );

  // Earnings API呼び出し
  const allTx: Transaction[] = [];
  let page = 1;
  let hitOldData = false;

  while (page <= MAX_PAGES && !hitOldData) {
    const url = `${EARNINGS_API}/${userId}/transactions?page=${page}&limit=${PAGE_SIZE}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          Cookie: cookieHeader,
          Accept: 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
    } catch (err) {
      log.error(`[${castName}] API接続エラー page=${page}`, err);
      break;
    }

    if (resp.status === 401 || resp.status === 403) {
      log.warn(`[${castName}] 認証エラー ${resp.status} — cookieが期限切れの可能性`);
      if (isAuthenticated) {
        await sb
          .from('stripchat_sessions')
          .update({ is_valid: false })
          .eq('account_id', accountId);
      }
      return 'auth_failed';
    }

    if (resp.status === 429) {
      log.warn(`[${castName}] レート制限 — 10秒待機`);
      await sleep(10000);
      continue; // 同じページをリトライ
    }

    if (!resp.ok) {
      log.error(`[${castName}] API ${resp.status} page=${page}`);
      break;
    }

    let data: { transactions?: Transaction[]; items?: Transaction[]; data?: Transaction[] };
    try {
      data = (await resp.json()) as typeof data;
    } catch {
      log.error(`[${castName}] JSONパース失敗 page=${page}`);
      break;
    }

    const items = data.transactions || data.items || data.data || [];
    if (items.length === 0) break;

    // 差分チェック: sinceDate以前のデータが出たら停止
    for (const tx of items) {
      const txDate = tx.date || tx.createdAt || tx.created_at;
      if (sinceDate && txDate && new Date(txDate) < sinceDate) {
        hitOldData = true;
        break;
      }
      allTx.push(tx);
    }

    if (items.length < PAGE_SIZE) break;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  if (allTx.length === 0) {
    log.info(`[${castName}] 新規トランザクションなし`);
    return 'ok';
  }

  // coin_transactions行を構築
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const tx of allTx) {
    const userName =
      tx.userName || tx.user_name || tx.username || '';
    const tokens = Math.max(0, parseInt(String(tx.tokens || tx.amount || 0), 10));
    const txType = tx.type || tx.source || 'unknown';
    const txDate = tx.date || tx.createdAt || tx.created_at || now;

    if (!userName || tokens <= 0) continue;

    rows.push({
      account_id: accountId,
      cast_name: castName,
      stripchat_tx_id: tx.id ? String(tx.id) : null,
      user_name: userName,
      user_id: tx.userId ? String(tx.userId) : null,
      tokens,
      type: txType,
      date: txDate,
      source_detail: tx.description || tx.sourceDetail || '',
      is_anonymous: tx.isAnonymous === true || tx.isAnonymous === 1,
      synced_at: now,
    });
  }

  // バッチUPSERT
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from('coin_transactions')
      .upsert(batch, {
        onConflict: 'account_id,user_name,cast_name,tokens,date',
        ignoreDuplicates: true,
      });

    if (error) {
      log.error(`[${castName}] UPSERT失敗 (${batch.length}件)`, error);
    }
  }

  log.info(`[${castName}] ${rows.length}件同期完了 (${page - 1}ページ取得)`);
  return 'ok';
}
