/**
 * coin-sync-service.ts — コイン同期スタンドアロンサービス
 *
 * Chrome拡張なしでStripchat Earnings APIからcoin_transactionsを同期する。
 * Cookieはstripchat_sessionsテーブルからのみ取得。
 * Cookie期限切れ時はエラーログを出してリトライしない
 * （Chrome拡張がCookie更新するまで待つ）。
 *
 * Usage:
 *   npx tsx src/coin-sync-service.ts          # 即時実行 + 1時間間隔で永続
 *   pm2 start ecosystem.config.cjs            # coin-syncプロセスとして起動
 */

import 'dotenv/config';
import { getSupabase } from './config.js';
import { createLogger, setLogLevel } from './utils/logger.js';

const log = createLogger('coin-sync-svc');
const envLevel = process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined;
if (envLevel) setLogLevel(envLevel);

// ----- Constants -----

const EARNINGS_API = 'https://stripchat.com/api/front/users';
const PAYING_USERS_API = 'https://stripchat.com/api/front/users';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SYNC_INTERVAL_MS = parseInt(process.env.COIN_SYNC_INTERVAL || '3600000', 10); // 1h
const MAX_TX_PAGES = 50;       // transactions: 最大50ページ = 5,000件
const MAX_USERS_PAGES = 100;   // paying users: 最大100ページ = 10,000人
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 800;  // ページ間ディレイ
const BATCH_SIZE = 500;        // UPSERTバッチサイズ

// ----- Types -----

interface StripchatSession {
  account_id: string;
  cookies_json: Record<string, string> | null;
  stripchat_user_id: string | null;
  is_valid: boolean;
}

interface RegisteredCast {
  account_id: string;
  cast_name: string;
  stripchat_user_id: string | null;
  stripchat_model_id: string | null;
}

interface RawTransaction {
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

interface RawPayingUser {
  userId?: number;
  username?: string;
  userName?: string;
  totalTokens?: number;
  lastPaid?: string;
  publicTip?: number;
  privateTip?: number;
  ticketShow?: number;
  groupShow?: number;
  content?: number;
  cam2cam?: number;
  fanClub?: number;
  spy?: number;
  private?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- Cookie取得（DB only） -----

async function getSessionFromDB(
  accountId: string,
  casts: RegisteredCast[],
): Promise<{
  cookieHeader: string;
  userId: string;
  session: StripchatSession;
} | null> {
  const sb = getSupabase();

  const { data, error } = await sb
    .from('stripchat_sessions')
    .select('account_id, cookies_json, stripchat_user_id, is_valid')
    .eq('account_id', accountId)
    .eq('is_valid', true)
    .limit(1)
    .single();

  if (error || !data) {
    log.warn(`[${accountId}] stripchat_sessions: 有効なセッションなし`);
    return null;
  }

  const sess = data as StripchatSession;
  if (!sess.cookies_json || Object.keys(sess.cookies_json).length === 0) {
    log.warn(`[${accountId}] cookies_jsonが空`);
    return null;
  }

  // 認証チェック: isLogged + sessionId or userId cookie
  const hasUserIdCookie = !!sess.cookies_json['stripchat_com_userId'];
  const hasLoggedFlag = sess.cookies_json['isLogged'] === '1';
  const hasSessionId = !!sess.cookies_json['stripchat_com_sessionId'];

  if (!hasUserIdCookie && !(hasLoggedFlag && hasSessionId)) {
    log.warn(`[${accountId}] ゲストcookieのみ — 認証済みセッションが必要`);
    return null;
  }

  // userId解決（3段フォールバック）
  let userId = sess.stripchat_user_id
    ? String(sess.stripchat_user_id)
    : sess.cookies_json['stripchat_com_userId'] || '';

  // フォールバック: registered_casts.stripchat_user_id
  if (!userId) {
    const fallbackId = casts[0]?.stripchat_user_id || casts[0]?.stripchat_model_id;
    if (fallbackId) {
      userId = String(fallbackId);
      log.info(`[${accountId}] registered_castsからuserId取得: ${userId}`);
      // DBにも保存
      await sb.from('stripchat_sessions')
        .update({ stripchat_user_id: userId })
        .eq('account_id', accountId);
    }
  }

  if (!userId) {
    log.warn(`[${accountId}] userId解決不可`);
    return null;
  }

  const cookieHeader = Object.entries(sess.cookies_json)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  return { cookieHeader, userId, session: sess };
}

// ----- Earnings API: Transactions (個別トランザクション → coin_transactions) -----

async function fetchTransactions(
  userId: string,
  cookieHeader: string,
  sinceDate: Date | null,
): Promise<{ transactions: RawTransaction[]; authFailed: boolean }> {
  const allTx: RawTransaction[] = [];
  let page = 1;
  let hitOldData = false;

  while (page <= MAX_TX_PAGES && !hitOldData) {
    const url = `${EARNINGS_API}/${userId}/transactions?page=${page}&limit=${PAGE_SIZE}`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Cookie: cookieHeader, Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      log.error(`Transactions API接続エラー page=${page}: ${err}`);
      break;
    }

    if (resp.status === 401 || resp.status === 403) {
      log.warn(`Transactions API ${resp.status} — Cookie期限切れ`);
      return { transactions: allTx, authFailed: true };
    }

    if (resp.status === 429) {
      log.warn('レート制限 — 15秒待機');
      await sleep(15000);
      continue;
    }

    if (!resp.ok) {
      log.error(`Transactions API ${resp.status} page=${page}`);
      break;
    }

    let data: { transactions?: RawTransaction[]; items?: RawTransaction[]; numberOfTransactions?: number };
    try {
      data = await resp.json() as typeof data;
    } catch {
      log.error(`JSONパース失敗 page=${page}`);
      break;
    }

    const items = data.transactions || data.items || [];
    if (items.length === 0) break;

    if (page === 1 && data.numberOfTransactions) {
      log.info(`総トランザクション数: ${data.numberOfTransactions}`);
    }

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

  log.info(`Transactions: ${allTx.length}件取得 (${page - 1}ページ)`);
  return { transactions: allTx, authFailed: false };
}

// ----- Earnings API: Paying Users (ユーザー集計 → paid_users) -----

async function fetchPayingUsers(
  userId: string,
  cookieHeader: string,
): Promise<{ users: RawPayingUser[]; authFailed: boolean }> {
  const allUsers: RawPayingUser[] = [];
  let offset = 0;

  while (offset < MAX_USERS_PAGES * PAGE_SIZE) {
    const url = `${PAYING_USERS_API}/${userId}/transactions/users?offset=${offset}&limit=${PAGE_SIZE}&sort=lastPaid&order=desc`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Cookie: cookieHeader, Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      log.error(`PayingUsers API接続エラー offset=${offset}: ${err}`);
      break;
    }

    if (resp.status === 401 || resp.status === 403) {
      log.warn(`PayingUsers API ${resp.status} — Cookie期限切れ`);
      return { users: allUsers, authFailed: true };
    }

    if (resp.status === 429) {
      log.warn('レート制限 — 15秒待機');
      await sleep(15000);
      continue;
    }

    if (!resp.ok) {
      log.error(`PayingUsers API ${resp.status} offset=${offset}`);
      break;
    }

    let data: { transactions?: RawPayingUser[]; totalCount?: number };
    try {
      data = await resp.json() as typeof data;
    } catch {
      log.error(`JSONパース失敗 offset=${offset}`);
      break;
    }

    const items = data.transactions || [];
    if (items.length === 0) break;

    if (offset === 0 && data.totalCount) {
      log.info(`総課金ユーザー数: ${data.totalCount}`);
    }

    allUsers.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(REQUEST_DELAY_MS);
  }

  log.info(`PayingUsers: ${allUsers.length}人取得`);
  return { users: allUsers, authFailed: false };
}

// ----- UPSERT: coin_transactions -----

async function upsertTransactions(
  accountId: string,
  castName: string,
  transactions: RawTransaction[],
): Promise<number> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const tx of transactions) {
    const userName = tx.userName || tx.user_name || tx.username || '';
    const tokens = Math.max(0, parseInt(String(tx.tokens || tx.amount || 0), 10));
    const txDate = tx.date || tx.createdAt || tx.created_at || now;

    if (!userName || tokens <= 0) continue;

    rows.push({
      account_id: accountId,
      cast_name: castName,
      stripchat_tx_id: tx.id ? String(tx.id) : null,
      user_name: userName,
      user_id: tx.userId ? String(tx.userId) : null,
      tokens,
      type: tx.type || tx.source || 'unknown',
      date: txDate,
      source_detail: tx.description || tx.sourceDetail || '',
      is_anonymous: tx.isAnonymous === true || tx.isAnonymous === 1,
      synced_at: now,
    });
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from('coin_transactions')
      .upsert(batch, {
        onConflict: 'account_id,user_name,cast_name,tokens,date',
        ignoreDuplicates: true,
      });
    if (error) {
      log.error(`coin_transactions UPSERT失敗 (${batch.length}件): ${error.message}`);
    } else {
      upserted += batch.length;
    }
  }

  return upserted;
}

// ----- UPSERT: paid_users -----

async function upsertPayingUsers(
  accountId: string,
  castName: string,
  users: RawPayingUser[],
): Promise<number> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const u of users) {
    const userName = u.username || u.userName || '';
    const totalTokens = u.totalTokens || 0;
    if (!userName || !u.userId) continue;

    rows.push({
      account_id: accountId,
      user_name: userName,
      cast_name: castName,
      total_coins: totalTokens,
      last_payment_date: u.lastPaid || null,
      user_id_stripchat: String(u.userId),
      profile_url: `https://stripchat.com/user/${userName}`,
      updated_at: now,
    });
  }

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await sb
      .from('paid_users')
      .upsert(batch, {
        onConflict: 'account_id,user_name',
        ignoreDuplicates: false, // 更新する（total_coinsを最新化）
      });
    if (error) {
      log.error(`paid_users UPSERT失敗 (${batch.length}件): ${error.message}`);
    } else {
      upserted += batch.length;
    }
  }

  return upserted;
}

// ----- 1アカウント分の同期 -----

async function syncAccount(
  accountId: string,
  casts: RegisteredCast[],
): Promise<'ok' | 'auth_failed' | 'no_session'> {
  // 1. Cookie取得（DBのみ）
  const auth = await getSessionFromDB(accountId, casts);
  if (!auth) return 'no_session';

  log.info(`[${accountId}] 認証OK (userId=${auth.userId})`);

  const sb = getSupabase();

  // 2. 各キャストのトランザクション同期
  let totalTx = 0;
  let authFailed = false;

  for (const cast of casts) {
    // 差分同期: 最終synced_atから24hバッファ
    const { data: lastTx } = await sb
      .from('coin_transactions')
      .select('synced_at')
      .eq('account_id', accountId)
      .eq('cast_name', cast.cast_name)
      .order('synced_at', { ascending: false })
      .limit(1);

    const lastSyncedAt = lastTx?.[0]?.synced_at;
    const sinceDate = lastSyncedAt
      ? new Date(new Date(lastSyncedAt).getTime() - 24 * 60 * 60 * 1000)
      : null;

    log.info(`[${cast.cast_name}] 差分同期 (since=${sinceDate?.toISOString() || 'フル同期'})`);

    const { transactions, authFailed: txAuthFailed } = await fetchTransactions(
      auth.userId, auth.cookieHeader, sinceDate,
    );

    if (txAuthFailed) {
      authFailed = true;
      break;
    }

    if (transactions.length > 0) {
      const count = await upsertTransactions(accountId, cast.cast_name, transactions);
      totalTx += count;
      log.info(`[${cast.cast_name}] ${count}件 coin_transactions 保存`);
    } else {
      log.info(`[${cast.cast_name}] 新規トランザクションなし`);
    }

    await sleep(1000); // キャスト間ディレイ
  }

  if (authFailed) {
    // Cookie期限切れ → is_valid=false にしてChrome拡張の更新を待つ
    await sb
      .from('stripchat_sessions')
      .update({ is_valid: false, updated_at: new Date().toISOString() })
      .eq('account_id', accountId);
    log.error(`[${accountId}] Cookie期限切れ — Chrome拡張がCookie更新するまで待機`);
    return 'auth_failed';
  }

  // 3. 課金ユーザー一覧同期
  const { users, authFailed: usersAuthFailed } = await fetchPayingUsers(
    auth.userId, auth.cookieHeader,
  );

  if (usersAuthFailed) {
    await sb
      .from('stripchat_sessions')
      .update({ is_valid: false, updated_at: new Date().toISOString() })
      .eq('account_id', accountId);
    log.error(`[${accountId}] Cookie期限切れ(PayingUsers) — Chrome拡張がCookie更新するまで待機`);
    return 'auth_failed';
  }

  if (users.length > 0) {
    // cast_name: 最初のキャストに紐づけ（1アカウント1キャストが通常）
    const primaryCast = casts[0]?.cast_name || 'unknown';
    const userCount = await upsertPayingUsers(accountId, primaryCast, users);
    log.info(`[${accountId}] ${userCount}人 paid_users 保存`);
  }

  // 4. MV + セグメント更新
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

  log.info(`[${accountId}] 同期完了: ${totalTx}件TX + ${users.length}人ユーザー`);
  return 'ok';
}

// ----- メイン同期ループ -----

async function runSync(): Promise<void> {
  const sb = getSupabase();

  // 自社キャスト一覧
  const { data: casts, error } = await sb
    .from('registered_casts')
    .select('account_id, cast_name, stripchat_user_id, stripchat_model_id')
    .eq('is_active', true);

  if (error || !casts || casts.length === 0) {
    log.warn('自社キャストなし — スキップ');
    await updatePipelineStatus(false, '自社キャスト0件');
    return;
  }

  log.info(`コイン同期開始: ${casts.length}キャスト`);

  // account_idごとにグループ化
  const byAccount = new Map<string, RegisteredCast[]>();
  for (const c of casts) {
    const list = byAccount.get(c.account_id) || [];
    list.push(c as RegisteredCast);
    byAccount.set(c.account_id, list);
  }

  let overallSuccess = false;
  let failureReason = '';

  for (const [accountId, accountCasts] of byAccount) {
    const result = await syncAccount(accountId, accountCasts);

    if (result === 'ok') {
      overallSuccess = true;
    } else if (result === 'auth_failed') {
      failureReason = 'Cookie期限切れ — Chrome拡張でCookie更新が必要';
    } else if (result === 'no_session') {
      failureReason = 'stripchat_sessionsにセッションなし';
    }
  }

  await updatePipelineStatus(overallSuccess, failureReason);

  if (overallSuccess) {
    log.info('=== コイン同期完了 ===');
  } else {
    log.error(`=== コイン同期失敗: ${failureReason} ===`);
  }
}

async function updatePipelineStatus(success: boolean, failureReason: string): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from('pipeline_status').upsert({
      pipeline_name: 'CoinSync',
      status: 'auto',
      source: 'Stripchat Earnings API',
      destination: 'coin_transactions + paid_users',
      detail: success ? 'サーバーサイド同期完了' : `同期失敗: ${failureReason}`,
      last_run_at: new Date().toISOString(),
      last_success: success,
      error_message: success ? null : failureReason,
    }, { onConflict: 'pipeline_name' });
  } catch {
    // ignore
  }
}

// ----- Entry point -----

async function main(): Promise<void> {
  log.info('========================================');
  log.info('Coin Sync Service started');
  log.info(`Interval: ${SYNC_INTERVAL_MS / 1000 / 60} minutes`);
  log.info('Cookie source: stripchat_sessions (DB only)');
  log.info('========================================');

  // 即時実行
  try {
    await runSync();
  } catch (err) {
    log.error('初回同期失敗:', err);
  }

  // 定期実行
  setInterval(async () => {
    try {
      await runSync();
    } catch (err) {
      log.error('定期同期失敗:', err);
    }
  }, SYNC_INTERVAL_MS);

  log.info(`次回同期: ${new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleString('ja-JP')}`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('SIGINT — 終了');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log.info('SIGTERM — 終了');
  process.exit(0);
});

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
