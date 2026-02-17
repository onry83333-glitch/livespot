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

const LOG = '[LS-COIN]';

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

    // 有料ユーザー一覧も同時取得
    if (result.ok) {
      try {
        const payingUsers = await fetchPayingUsers(baseUrl, userId, { maxPages: 5 });
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
  const maxPages = options.maxPages || 10;
  const limit = options.limit || 100;
  const allTransactions = [];
  let offset = 0;
  let page = 0;

  // 365日分のデータを取得
  const now = new Date();
  const from = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const fromISO = from.toISOString().replace(/\.\d{3}Z/, 'Z');
  const untilISO = now.toISOString().replace(/\.\d{3}Z/, 'Z');

  while (page < maxPages) {
    page++;
    const uniq = Math.random().toString(36).substring(2, 10);
    const url = `${baseUrl}/api/front/users/${userId}/transactions`
      + `?from=${fromISO}&until=${untilISO}`
      + `&offset=${offset}&limit=${limit}`
      + `&uniq=${uniq}`;

    console.log(LOG, `ページ ${page} 取得中... (offset=${offset})`);

    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(LOG, 'Stripchat認証エラー:', res.status);
          if (allTransactions.length > 0) {
            return { ok: true, transactions: allTransactions, pages: page - 1, partial: true };
          }
          return { error: 'auth_expired', message: 'Stripchatにログインしてください' };
        }
        if (res.status === 429) {
          console.warn(LOG, 'レート制限 — 3秒待機後リトライ');
          await sleep(3000);
          page--; // retry same page
          continue;
        }
        return { error: 'api_error', message: `HTTP ${res.status}` };
      }

      const data = await res.json();
      const transactions = data.transactions || [];

      if (transactions.length === 0) {
        console.log(LOG, `ページ ${page}: データなし — 取得完了`);
        break;
      }

      // Morning Hook形式のトランザクションをパース
      for (const tx of transactions) {
        const parsed = parseTransaction(tx);
        if (parsed) allTransactions.push(parsed);
      }

      console.log(LOG, `ページ ${page}: ${transactions.length}件取得 (累計: ${allTransactions.length}件)`);

      if (transactions.length < limit) {
        console.log(LOG, '最終ページ到達');
        break;
      }

      offset += limit;
      await sleep(500); // レート制限対策
    } catch (err) {
      console.error(LOG, `ページ ${page} 取得失敗:`, err.message);
      if (allTransactions.length > 0) {
        return { ok: true, transactions: allTransactions, pages: page - 1, partial: true };
      }
      return { error: 'network_error', message: err.message };
    }
  }

  console.log(LOG, `取得完了: ${allTransactions.length}件 (${page}ページ)`);
  return { ok: true, transactions: allTransactions, pages: page };
}

/**
 * Morning Hook API形式のトランザクションをフラット化
 * { extra: { source: { user: { username } }, tipData: { user: { username } } } }
 */
function parseTransaction(tx) {
  const extra = tx.extra || {};
  const tipData = extra.tipData || {};
  const source = extra.source || {};
  const userInfo = source.user || tipData.user || {};

  const userName = userInfo.username || '';
  if (!userName) return null; // 匿名やシステムトランザクションはスキップ

  return {
    userName: userName,
    tokens: tx.tokens || 0,
    type: tx.type || source.type || 'unknown',
    date: tx.date || '',
    sourceDetail: source.type || tipData.triggerType || '',
    isAnonymous: tipData.isAnonymous || false,
  };
}

// ============================================================
// 方法2: /api/front/users/{uid}/transactions/users（有料ユーザー一覧）
// Morning Hook CRM実証済み — ユーザー別集計を取得
// ============================================================
async function fetchPayingUsers(baseUrl, userId, options = {}) {
  const maxPages = options.maxPages || 10;
  const limit = options.limit || 100;
  const allUsers = [];
  let offset = 0;
  let page = 0;

  while (page < maxPages) {
    page++;
    const uniq = Math.random().toString(36).substring(2, 10);
    const url = `${baseUrl}/api/front/users/${userId}/transactions/users`
      + `?offset=${offset}&limit=${limit}`
      + `&sort=lastPaid&order=desc`
      + `&uniq=${uniq}`;

    console.log(LOG, `[users] ページ ${page} 取得中... (offset=${offset})`);

    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.warn(LOG, '[users] 認証エラー:', res.status);
          break;
        }
        if (res.status === 429) {
          console.warn(LOG, '[users] レート制限 — 3秒待機');
          await sleep(3000);
          page--;
          continue;
        }
        console.warn(LOG, '[users] API error:', res.status);
        break;
      }

      const data = await res.json();
      const users = data.transactions || [];

      if (users.length === 0) {
        console.log(LOG, `[users] ページ ${page}: データなし — 取得完了`);
        break;
      }

      for (const u of users) {
        allUsers.push({
          userName: u.username || '',
          totalTokens: u.totalTokens || 0,
          lastPaid: u.lastPaid || '',
          userId: u.userId || 0,
        });
      }

      console.log(LOG, `[users] ページ ${page}: ${users.length}件取得 (累計: ${allUsers.length}件)`);

      if (users.length < limit) break;
      offset += limit;
      await sleep(500);
    } catch (err) {
      console.error(LOG, `[users] ページ ${page} 取得失敗:`, err.message);
      break;
    }
  }

  console.log(LOG, `[users] 取得完了: ${allUsers.length}名`);
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
