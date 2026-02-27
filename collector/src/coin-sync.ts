/**
 * coin-sync.ts — Collectorからのコイン同期
 *
 * Chrome拡張が停止していても、Stripchat Earnings APIを呼び出し
 * coin_transactionsを更新する。
 *
 * Cookie取得の優先順位:
 *   1. stripchat_sessions（Chrome拡張が保存した認証cookie）
 *   2. Playwrightログイン（STRIPCHAT_USERNAME/PASSWORD設定時）
 *
 * フロー:
 *   1. registered_casts から自社キャスト一覧取得
 *   2. 認証cookie取得（DB → Playwrightフォールバック）
 *   3. Stripchat /api/front/users/{uid}/transactions を呼び出し
 *   4. coin_transactions に UPSERT
 *   5. refresh_paying_users + refresh_segments RPC実行
 */

import { getSupabase, PLAYWRIGHT_CONFIG } from './config.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('coin-sync');

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
 * Playwrightでログインし認証cookieを取得 → stripchat_sessions更新
 * STRIPCHAT_USERNAME + STRIPCHAT_PASSWORD が .env に設定されている場合のみ動作
 */
async function refreshCookiesViaPlaywright(
  accountId: string,
): Promise<{ cookieHeader: string; userId: string } | null> {
  const { username, password } = PLAYWRIGHT_CONFIG;
  if (!username || !password) {
    log.warn('Playwrightログイン不可 — STRIPCHAT_USERNAME/PASSWORDが.envに未設定');
    return null;
  }

  log.info(`[${accountId}] Playwrightで認証cookie取得開始...`);

  let chromium: typeof import('playwright').chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    log.warn('Playwright未インストール — cookie自動取得不可');
    return null;
  }

  let browser: import('playwright').Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'ja-JP',
    });

    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => false });");

    const page = await context.newPage();

    // ログインページ
    await page.goto('https://stripchat.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // 年齢確認突破
    try {
      const ageBtn = await page.$('button:has-text("18")');
      if (ageBtn) await ageBtn.click();
      await page.waitForTimeout(2000);
    } catch { /* no gate */ }

    // ログインフォーム
    for (const sel of ['input[name="login"]', 'input[name="username"]', 'input[type="text"]']) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.fill(username); break; }
    }
    for (const sel of ['input[name="password"]', 'input[type="password"]']) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) { await el.fill(password); break; }
    }

    // 送信
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) await submitBtn.click();

    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    } catch {
      await page.waitForTimeout(5000);
    }

    // Cookie取得
    const cookies = await context.cookies('https://stripchat.com');
    const cookiesJson: Record<string, string> = {};
    for (const c of cookies) {
      cookiesJson[c.name] = c.value;
    }

    const userIdFromCookie = cookiesJson['stripchat_com_userId'];
    if (!userIdFromCookie) {
      log.warn(`[${accountId}] Playwrightログイン後もuserIdなし — ログイン失敗の可能性`);
      try { await page.screenshot({ path: 'docs/playwright-coin-login-fail.png' }); } catch { /* */ }
      return null;
    }

    const cookieHeader = Object.entries(cookiesJson).map(([k, v]) => `${k}=${v}`).join('; ');
    log.info(`[${accountId}] Playwrightログイン成功 (userId=${userIdFromCookie})`);

    // stripchat_sessions更新
    const sb = getSupabase();
    await sb.from('stripchat_sessions').upsert({
      account_id: accountId,
      cookies_json: cookiesJson,
      stripchat_user_id: userIdFromCookie,
      is_valid: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });

    return { cookieHeader, userId: userIdFromCookie };
  } catch (err) {
    log.error(`[${accountId}] Playwrightログイン失敗`, err);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* */ }
    }
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

  for (const [accountId, accountCasts] of byAccount) {
    const result = await syncAccount(sb, accountId, accountCasts);

    // Earnings API 403 → Playwrightでcookieリフレッシュしてリトライ
    if (result === 'auth_failed') {
      log.info(`[${accountId}] Playwrightでcookie自動取得を試行...`);
      const fresh = await refreshCookiesViaPlaywright(accountId);
      if (fresh) {
        await syncAccountCasts(sb, accountId, accountCasts, fresh.userId, fresh.cookieHeader, true);
      }
    }

    // MV + セグメント更新（成否に関わらず実行）
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

  // 5. pipeline_status 更新
  try {
    await sb.from('pipeline_status').upsert(
      {
        pipeline_name: 'CoinSync',
        status: 'auto',
        source: 'Stripchat Earnings API',
        destination: 'coin_transactions',
        detail: `${casts.length}キャスト同期完了`,
        last_run_at: new Date().toISOString(),
        last_success: true,
      },
      { onConflict: 'pipeline_name' },
    );
  } catch {
    log.debug('pipeline_status更新スキップ');
  }

  log.info('コイン同期完了');
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
  // 2. stripchat_sessions から有効なcookieを取得
  const { data: sessions, error: sessErr } = await sb
    .from('stripchat_sessions')
    .select('account_id, cookies_json, stripchat_user_id, is_valid')
    .eq('account_id', accountId)
    .eq('is_valid', true)
    .limit(1);

  if (sessErr || !sessions || sessions.length === 0) {
    log.warn(`[${accountId}] 有効なstripchat_sessionなし`);
    return 'auth_failed'; // Playwrightフォールバック対象
  }

  const sess = sessions[0] as StripchatSession;
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

  const isAuthenticated = !!sess.cookies_json?.['stripchat_com_userId'];
  return syncAccountCasts(sb, accountId, accountCasts, userId, cookieHeader, isAuthenticated);
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
