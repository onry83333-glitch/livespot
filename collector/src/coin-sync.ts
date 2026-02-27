/**
 * coin-sync.ts — Collectorからのコイン同期
 *
 * Chrome拡張が停止していても、stripchat_sessionsに保存済みのcookieを使って
 * Stripchat Earnings APIを呼び出しcoin_transactionsを更新する。
 *
 * フロー:
 *   1. registered_casts から自社キャスト一覧取得
 *   2. stripchat_sessions から有効なcookies_json取得
 *   3. Stripchat /api/front/users/{uid}/transactions を呼び出し
 *   4. coin_transactions に UPSERT
 *   5. refresh_paying_users + refresh_segments RPC実行
 */

import { getSupabase } from './config.js';
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
    // 2. stripchat_sessions から有効なcookieを取得
    const { data: sessions, error: sessErr } = await sb
      .from('stripchat_sessions')
      .select('account_id, cookies_json, stripchat_user_id, is_valid')
      .eq('account_id', accountId)
      .eq('is_valid', true)
      .limit(1);

    if (sessErr || !sessions || sessions.length === 0) {
      log.warn(`[${accountId}] 有効なstripchat_sessionなし — スキップ`);
      continue;
    }

    const sess = sessions[0] as StripchatSession;
    if (!sess.cookies_json || Object.keys(sess.cookies_json).length === 0) {
      log.warn(`[${accountId}] cookies_jsonが空 — スキップ`);
      continue;
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
        // DBにも保存（次回以降はDBから取得）
        await sb
          .from('stripchat_sessions')
          .update({ stripchat_user_id: userId })
          .eq('account_id', accountId)
          .eq('is_valid', true);
      }
    }

    // それでも取得できない場合、API /user/me で自動検出
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
          } else {
            log.warn(`[${accountId}] /user/me レスポンスにuserIdなし`);
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
      continue;
    }

    // userIdがsession由来かフォールバック由来かを記録
    const userIdFromSession = !!sess.stripchat_user_id;

    // 3. 各キャストの最終同期日を取得して差分同期
    for (const cast of accountCasts) {
      try {
        await syncCastCoins(accountId, cast.cast_name, userId, cookieHeader, userIdFromSession);
      } catch (err) {
        log.error(`[${cast.cast_name}] コイン同期失敗`, err);
      }
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
 * 1キャストのコイン同期
 */
async function syncCastCoins(
  accountId: string,
  castName: string,
  userId: string,
  cookieHeader: string,
  userIdFromSession = true,
): Promise<void> {
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
      // session由来のuserIdの場合のみ session を無効化
      // フォールバック(model_id等)の場合はcookieの問題ではなくuserId不一致の可能性
      if (userIdFromSession) {
        await sb
          .from('stripchat_sessions')
          .update({ is_valid: false })
          .eq('account_id', accountId);
      }
      break;
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
    return;
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
}
