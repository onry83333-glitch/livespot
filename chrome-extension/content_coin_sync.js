/**
 * Strip Live Spot - Coin History Sync (Content Script)
 * ISOLATED world — stripchat.com上で実行
 *
 * background.jsからの FETCH_COINS 要求に応じて
 * Stripchat Earnings APIを呼び出しコイン履歴を取得する。
 * 同一オリジンなのでセッションcookieが自動付与される。
 *
 * API戦略（2段階フォールバック）:
 *   1. /api/front/users/{uid}/transactions — Morning Hook CRM実証済み
 *   2. /api/front/v2/earnings/coins-history — v2 earnings API
 */

// 二重注入ガード（manifest.json content_scripts + chrome.scripting.executeScript 両方で読み込まれる）
if (window._lsCoinSyncLoaded) {
  console.log('[LS-COIN] 既にロード済み — スキップ');
} else {
window._lsCoinSyncLoaded = true;

var LOG = '[LS-COIN]';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_COINS') {
    console.log(LOG, '名簿同期リクエスト受信');
    fetchCoinHistory(msg.options || {})
      .then(sendResponse)
      .catch(err => {
        console.error(LOG, 'エラー:', err.message);
        sendResponse({ error: 'fetch_error', message: err.message });
      });
    return true; // async response
  }

  if (msg.type === 'FETCH_PAYING_USERS') {
    console.log(LOG, '有料ユーザー一覧リクエスト受信');
    const baseUrl = window.location.origin;
    const userId = getUserId();
    if (!userId) {
      sendResponse({ error: 'no_user_id', message: 'ユーザーIDを取得できません' });
      return true;
    }
    fetchPayingUsers(baseUrl, userId, msg.options || {})
      .then(users => sendResponse({ ok: true, users }))
      .catch(err => sendResponse({ error: 'fetch_error', message: err.message }));
    return true;
  }
});

// ============================================================
// ユーザーID取得（Morning Hook CRM 5段階フォールバック）
// ============================================================
function getUserId() {
  // 方法1: Cookie stripchat_com_userId
  const cookieMatch = document.cookie.match(/stripchat_com_userId=(\d+)/);
  if (cookieMatch) {
    console.log(LOG, 'ユーザーID取得(cookie):', cookieMatch[1]);
    return cookieMatch[1];
  }

  // 方法2: __NEXT_DATA__ グローバル変数
  try {
    const nextData = document.querySelector('#__NEXT_DATA__');
    if (nextData) {
      const data = JSON.parse(nextData.textContent);
      const uid = data?.props?.initialState?.user?.user?.id;
      if (uid) {
        console.log(LOG, 'ユーザーID取得(__NEXT_DATA__):', uid);
        return String(uid);
      }
    }
  } catch (e) {
    // parse error — try next method
  }

  // 方法3: data-user-id DOM属性
  const el = document.querySelector('[data-user-id]');
  if (el) {
    const uid = el.dataset.userId;
    if (uid) {
      console.log(LOG, 'ユーザーID取得(DOM):', uid);
      return uid;
    }
  }

  // 方法4: Performance API URLパターン
  try {
    const entries = performance.getEntriesByType('resource');
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = entries[i].name.match(/\/api\/front\/users\/(\d+)\//);
      if (m) {
        console.log(LOG, 'ユーザーID取得(Performance API):', m[1]);
        return m[1];
      }
    }
  } catch (e) {
    // performance API unavailable
  }

  // 方法5: ページソース正規表現
  const pageMatch = document.documentElement.innerHTML.match(/\/api\/front\/users\/(\d+)\//);
  if (pageMatch) {
    console.log(LOG, 'ユーザーID取得(ページソース):', pageMatch[1]);
    return pageMatch[1];
  }

  console.warn(LOG, 'ユーザーIDを取得できません');
  return null;
}

// ============================================================
// メイン取得関数（2段階フォールバック）
// ============================================================
async function fetchCoinHistory(options = {}) {
  const baseUrl = window.location.origin; // https://ja.stripchat.com
  console.log(LOG, 'Origin:', baseUrl);

  // Step 1: ユーザーID取得 → Morning Hook APIを試行
  const userId = getUserId();
  if (userId) {
    console.log(LOG, 'Morning Hook API使用: userId=', userId);
    const result = await fetchViaUserTransactions(baseUrl, userId, options);

    // 有料ユーザー一覧も同時取得（全ページ: 7568名 ÷ 100 = 76ページ）
    if (result.ok) {
      try {
        const payingUsers = await fetchPayingUsers(baseUrl, userId, { maxPages: 100 });
        result.payingUsers = payingUsers;
        console.log(LOG, '有料ユーザー一覧:', payingUsers.length, '名同時取得');
      } catch (e) {
        console.warn(LOG, '有料ユーザー一覧取得失敗（非致命的）:', e.message);
      }
    }

    if (result.ok && result.transactions.length > 0) {
      return result;
    }
    console.warn(LOG, 'Morning Hook API失敗またはデータなし → v2 earnings APIにフォールバック');
  }

  // Step 2: v2 earnings API（フォールバック）
  console.log(LOG, 'v2 earnings API使用');
  return await fetchViaEarningsAPI(baseUrl, options);
}

// ============================================================
// 方法1: /api/front/users/{uid}/transactions（Morning Hook実証済み）
// ============================================================
async function fetchViaUserTransactions(baseUrl, userId, options = {}) {
  const maxPages = options.maxPages || 600;
  const limit = options.limit || 100;
  const MAX_RETRIES = 3;          // coin_api.py: _MAX_RETRIES = 3
  const RATE_LIMIT_SLEEP = 10000; // coin_api.py: _RATE_LIMIT_SLEEP = 10
  const allTransactions = [];
  let offset = 0;
  let page = 0;
  let retryCount = 0;
  let numberOfTransactions = null; // APIレスポンスの全件数

  // 差分同期: sinceISOが指定されている場合、1日バッファ付きのカットオフ日を設定
  const sinceISO = options.sinceISO || null;
  const cutoffDate = sinceISO
    ? new Date(new Date(sinceISO).getTime() - 24 * 60 * 60 * 1000)
    : null;
  if (cutoffDate) {
    console.log(LOG, `差分同期モード: ${sinceISO} 以降（バッファ: ${cutoffDate.toISOString()}）`);
  }

  // 365日分のデータを取得（coin_api.py: COIN_API_DAYS_BACK = 365）
  const now = new Date();
  const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  from.setHours(0, 0, 0, 0);
  const fromISO = from.toISOString().replace(/\.\d{3}Z/, 'Z');
  const untilISO = now.toISOString().replace(/\.\d{3}Z/, 'Z');

  console.log(LOG, `取得期間: ${from.toISOString().split('T')[0]} 〜 ${now.toISOString().split('T')[0]}（365日間）`);

  while (page < maxPages) {
    page++;
    const uniq = Math.random().toString(36).substring(2, 18);
    const url = `${baseUrl}/api/front/users/${userId}/transactions`
      + `?from=${fromISO}&until=${untilISO}`
      + `&offset=${offset}&limit=${limit}`
      + `&uniq=${uniq}`;

    const totalStr2 = numberOfTransactions !== null ? `, 全${numberOfTransactions.toLocaleString()}件中` : '';
    console.log(LOG, `ページ ${page} 取得中... (offset=${offset}${totalStr2})`);

    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(LOG, `認証エラー（${res.status}）。Stripchatに再ログインしてください。`);
          if (allTransactions.length > 0) {
            return { ok: true, transactions: allTransactions, pages: page - 1, partial: true };
          }
          return { error: 'auth_expired', message: 'Stripchatにログインしてください' };
        }
        if (res.status === 429) {
          retryCount++;
          if (retryCount > MAX_RETRIES) {
            console.warn(LOG, `レート制限超過（${MAX_RETRIES}回リトライ後）。取得済み分を返します。`);
            break;
          }
          console.warn(LOG, `レート制限。${RATE_LIMIT_SLEEP / 1000}秒待機してリトライ（${retryCount}/${MAX_RETRIES}）...`);
          await sleep(RATE_LIMIT_SLEEP);
          page--; // retry same page
          continue;
        }
        return { error: 'api_error', message: `HTTP ${res.status}` };
      }

      retryCount = 0; // 成功したらリトライカウンタリセット
      const data = await res.json();

      // デバッグ: レスポンス構造を確認（最初の2ページのみ）
      if (page <= 2) {
        console.log(LOG, `レスポンスtype: ${typeof data}, isArray: ${Array.isArray(data)}`);
        if (Array.isArray(data)) {
          console.log(LOG, `レスポンス: Array[${data.length}]`);
        } else {
          console.log(LOG, `レスポンスkeys: ${Object.keys(data)}`);
        }
      }

      // 初回でnumberOfTransactionsを取得（全件数の把握）
      if (numberOfTransactions === null && !Array.isArray(data) && data.numberOfTransactions !== undefined) {
        numberOfTransactions = data.numberOfTransactions;
        console.log(LOG, `トランザクション総数: ${numberOfTransactions.toLocaleString()}件`);
      }

      // coin_api.py: data.get("transactions", [])
      // フォールバック: レスポンスが配列の場合、items/data キーも試行
      const transactions = Array.isArray(data) ? data
        : (data.transactions || data.items || data.data || []);

      if (page <= 2 && transactions.length > 0) {
        console.log(LOG, `items[0] keys: ${Object.keys(transactions[0])}`);
        console.log(LOG, `items[0]: ${JSON.stringify(transactions[0]).substring(0, 800)}`);
      }

      if (transactions.length === 0) {
        console.log(LOG, `ページ ${page}: データなし → 取得完了`);
        break;
      }

      // Morning Hook形式のトランザクションをパース（coin_api.py: _parse_transaction準拠）
      let parsedCount = 0;
      for (const tx of transactions) {
        const parsed = parseTransaction(tx);
        if (parsed) {
          allTransactions.push(parsed);
          parsedCount++;
        }
      }

      if (page <= 2) {
        console.log(LOG, `ページ ${page} パース結果: ${parsedCount}/${transactions.length}件成功`);
      }

      console.log(LOG, `ページ ${page}: ${transactions.length}件取得（累計 ${allTransactions.length}件）`);

      // 差分モード: カットオフ日より前のデータが出たら打ち切り
      if (cutoffDate && transactions.length > 0) {
        const lastTx = transactions[transactions.length - 1];
        const lastDate = new Date(lastTx.date || lastTx.created_at || '');
        if (lastDate < cutoffDate) {
          console.log(LOG, `差分取得完了: 最終トランザクション ${lastDate.toISOString()} がカットオフ ${cutoffDate.toISOString()} より前`);
          break;
        }
      }

      if (transactions.length < limit) {
        console.log(LOG, '最終ページ到達 → 取得完了');
        break;
      }

      offset += limit;

      // 10ページごとに追加待機（429レート制限予防）
      if (page % 10 === 0) {
        console.log(LOG, `${page}ページ完了 — 2秒追加待機（429予防）`);
        await sleep(2000);
      } else {
        await sleep(500); // coin_api.py: COIN_API_RATE_LIMIT = 0.5
      }
    } catch (err) {
      console.error(LOG, `ネットワークエラー: ${err.message}`);
      console.log(LOG, '取得済み分を返します。');
      if (allTransactions.length > 0) {
        return { ok: true, transactions: allTransactions, pages: page - 1, partial: true };
      }
      return { error: 'network_error', message: err.message };
    }
  }

  const totalStr = numberOfTransactions !== null ? ` / 全 ${numberOfTransactions.toLocaleString()}件` : '';
  console.log(LOG, `合計 ${allTransactions.length}件${totalStr} のトランザクションを取得`);
  return { ok: true, transactions: allTransactions, pages: page, numberOfTransactions };
}

/**
 * Morning Hook API形式のトランザクションをフラット化
 * coin_api.py: _parse_transaction 準拠
 *
 * 既知のレスポンス構造:
 *   { id, type, date, tokens, amount, extra: { source: { type, user: { id, username } }, tipData: { user: { username }, isAnonymous, triggerType } } }
 *
 * フォールバック: フィールド名が異なる場合にも対応
 */
function parseTransaction(tx) {
  // coin_api.py準拠: extra.source / extra.tipData
  const extra = tx.extra || {};
  const tipData = extra.tipData || {};
  const source = extra.source || {};
  const userInfo = source.user || tipData.user || {};

  // ユーザー名: 複数パスで探索
  const userName = userInfo.username || userInfo.userName || userInfo.name
    || tx.username || tx.userName || tx.user_name || tx.from_user || '';

  // coin_api.py: parsed["id"] is not None でフィルタ（usernameではない）
  const txId = tx.id ?? null;
  if (txId === null) return null;

  return {
    id: txId,
    userName: userName,
    userId: userInfo.id ?? tx.userId ?? tx.user_id ?? 0,
    tokens: tx.tokens ?? 0,
    amount: tx.amount ?? 0,
    type: tx.type || tx.transaction_type || tx.transactionType || tx.category || '',
    date: tx.date || tx.created_at || tx.createdAt || tx.timestamp || '',
    sourceType: source.type || tx.sourceType || tx.source_type || '',
    triggerType: tipData.triggerType || tx.triggerType || tx.trigger_type || '',
    sourceDetail: source.type || tipData.triggerType || '',
    isAnonymous: tx.isAnonymous || tipData.isAnonymous ? 1 : 0,
  };
}

// ============================================================
// 方法2: /api/front/users/{uid}/transactions/users（有料ユーザー一覧）
// Morning Hook CRM実証済み — ユーザー別集計を取得
// ============================================================
async function fetchPayingUsers(baseUrl, userId, options = {}) {
  const maxPages = options.maxPages || 50;
  const limit = options.limit || 100;
  const MAX_RETRIES = 3;
  const RATE_LIMIT_SLEEP = 10000;
  const allUsers = [];
  let offset = 0;
  let page = 0;
  let retryCount = 0;
  let totalCount = null;

  while (page < maxPages) {
    page++;
    const uniq = Math.random().toString(36).substring(2, 18);
    // coin_api.py: /transactions/users?offset=...&limit=...&sort=lastPaid&order=desc
    const url = `${baseUrl}/api/front/users/${userId}/transactions/users`
      + `?offset=${offset}&limit=${limit}`
      + `&sort=lastPaid&order=desc`
      + `&uniq=${uniq}`;

    console.log(LOG, `[users] ページ ${page} 取得中... (offset=${offset})`);

    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(LOG, `[users] 認証エラー（${res.status}）。Stripchatに再ログインしてください。`);
          break;
        }
        if (res.status === 429) {
          retryCount++;
          if (retryCount > MAX_RETRIES) {
            console.warn(LOG, `[users] レート制限超過（${MAX_RETRIES}回リトライ後）。取得済み分を返します。`);
            break;
          }
          console.warn(LOG, `[users] レート制限。${RATE_LIMIT_SLEEP / 1000}秒待機してリトライ（${retryCount}/${MAX_RETRIES}）...`);
          await sleep(RATE_LIMIT_SLEEP);
          page--;
          continue;
        }
        console.warn(LOG, '[users] API error:', res.status);
        break;
      }

      retryCount = 0;
      const data = await res.json();
      const users = data.transactions || [];

      // 初回でtotalCountを取得（coin_api.py準拠）
      if (totalCount === null && data.totalCount !== undefined) {
        totalCount = data.totalCount;
        console.log(LOG, `[users] 有料ユーザー総数: ${totalCount.toLocaleString()}名`);
      }

      if (users.length === 0) {
        console.log(LOG, `[users] ページ ${page}: データなし → 取得完了`);
        break;
      }

      // coin_api.py: _parse_paying_user準拠
      for (const u of users) {
        if (!u.userId) continue;
        allUsers.push({
          userName: u.username || '',
          totalTokens: u.totalTokens || 0,
          lastPaid: u.lastPaid || '',
          userId: u.userId || 0,
          publicTip: u.publicTip || 0,
          privateTip: u.privateTip || 0,
          ticketShow: u.ticketShow || 0,
          groupShow: u.groupShow || 0,
          content: u.content || 0,
          cam2cam: u.cam2cam || 0,
          fanClub: u.fanClub || 0,
          spy: u.spy || 0,
          private: u.private || 0,
        });
      }

      const totalStr = totalCount !== null ? ` / ${totalCount.toLocaleString()}名` : '';
      console.log(LOG, `[users] ページ ${page}: ${users.length}名取得（累計 ${allUsers.length}名${totalStr}）`);

      if (users.length < limit) {
        console.log(LOG, '[users] 最終ページ到達 → 取得完了');
        break;
      }
      offset += limit;

      // 10ページごとに追加待機（429予防）
      if (page % 10 === 0) {
        console.log(LOG, `[users] ${page}ページ完了 — 2秒追加待機（429予防）`);
        await sleep(2000);
      } else {
        await sleep(500);
      }
    } catch (err) {
      console.error(LOG, `[users] ネットワークエラー: ${err.message}`);
      break;
    }
  }

  console.log(LOG, `[users] 合計 ${allUsers.length}名 の有料ユーザーを取得`);
  return allUsers;
}

// ============================================================
// 方法2: /api/front/v2/earnings/coins-history（フォールバック）
// ============================================================
async function fetchViaEarningsAPI(baseUrl, options = {}) {
  const maxPages = options.maxPages || 10;
  const limit = options.limit || 100;
  const allTransactions = [];
  let page = 1;

  while (page <= maxPages) {
    console.log(LOG, `[v2] ページ ${page} 取得中...`);

    try {
      const url = `${baseUrl}/api/front/v2/earnings/coins-history?page=${page}&limit=${limit}`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          if (allTransactions.length > 0) {
            return { ok: true, transactions: allTransactions, pages: page - 1, partial: true };
          }
          return { error: 'auth_expired', message: 'Stripchatにログインしてください' };
        }
        // 404: このAPIは存在しない可能性あり — エラーではなく空を返す
        if (res.status === 404) {
          console.warn(LOG, '[v2] 404 — このAPIは利用不可');
          return { ok: true, transactions: [], pages: 0 };
        }
        return { error: 'api_error', message: `HTTP ${res.status}` };
      }

      const data = await res.json();
      const items = data.transactions || data.items || data.data || [];

      if (!Array.isArray(items) || items.length === 0) {
        console.log(LOG, `[v2] ページ ${page}: データなし — 取得完了`);
        break;
      }

      allTransactions.push(...items);
      console.log(LOG, `[v2] ページ ${page}: ${items.length}件取得 (累計: ${allTransactions.length}件)`);

      if (items.length < limit) break;
      page++;
      await sleep(500);
    } catch (err) {
      console.error(LOG, `[v2] ページ ${page} 取得失敗:`, err.message);
      if (allTransactions.length > 0) {
        return { ok: true, transactions: allTransactions, pages: page - 1, partial: true };
      }
      return { error: 'network_error', message: err.message };
    }
  }

  console.log(LOG, `[v2] 取得完了: ${allTransactions.length}件 (${page}ページ)`);
  return { ok: true, transactions: allTransactions, pages: page };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

console.log(LOG, 'Content script loaded on', window.location.origin);

} // end double-injection guard
