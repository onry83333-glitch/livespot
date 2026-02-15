importScripts('config.js');

/**
 * Strip Live Spot - Background Service Worker
 * Auth管理、DMキューポーリング、SPYメッセージリレー
 *
 * 修正: accountId null問題
 * - CHAT_MESSAGEはaccountId不在でも常にバッファ
 * - account_idはflush時にstorageから最新値を付与
 * - accountId未設定ならflushを保留（30秒ごとにリトライ）
 */

let accessToken = null;
let accountId = null;
let dmPollingTimer = null;
let spyEnabled = false;
let messageBuffer = [];
let bufferTimer = null;
let spyMsgCount = 0;
let viewerStatsBuffer = [];
let viewerStatsTimer = null;

// A.2: Heartbeat tracking
let lastHeartbeat = 0;
let heartbeatAlerted = false;

const BUFFER_STORAGE_KEY = 'spy_message_buffer';
const VIEWER_BUFFER_KEY = 'spy_viewer_buffer';
const BUFFER_MAX = 1000;

// ============================================================
// A.1: Service Worker Keepalive via chrome.alarms
// ============================================================
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    flushMessageBuffer();
    flushViewerStats();
    checkHeartbeatTimeout();
  }
});

// ============================================================
// A.2: Heartbeat監視
// ============================================================
function checkHeartbeatTimeout() {
  if (!spyEnabled || !lastHeartbeat) return;

  const elapsed = Date.now() - lastHeartbeat;
  if (elapsed > 120000 && !heartbeatAlerted) {
    heartbeatAlerted = true;
    chrome.notifications.create('spy-heartbeat-lost', {
      type: 'basic',
      iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="24" font-size="24">⚠️</text></svg>',
      title: 'Strip Live Spot - 監視停止の可能性',
      message: `SPY監視からのハートビートが${Math.round(elapsed / 1000)}秒間途絶えています。Stripchatタブを確認してください。`,
      priority: 2,
    });
    console.warn('[LS-BG] ハートビートタイムアウト:', Math.round(elapsed / 1000), '秒');
  }
}

// ============================================================
// Config & Auth
// ============================================================
async function loadAuth() {
  const data = await chrome.storage.local.get([
    'access_token', 'account_id', 'api_base_url', 'spy_enabled',
  ]);
  accessToken = data.access_token || null;
  accountId = data.account_id || null;
  spyEnabled = data.spy_enabled === true;
  if (data.api_base_url) {
    CONFIG.API_BASE_URL = data.api_base_url;
  }
  return { accessToken, accountId, spyEnabled };
}

async function refreshAccessToken() {
  const data = await chrome.storage.local.get(['refresh_token']);
  if (!data.refresh_token) {
    console.log('[LS-BG] トークンリフレッシュ: refresh_tokenなし');
    return false;
  }
  try {
    console.log('[LS-BG] トークンリフレッシュ: 実行中...');
    const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: data.refresh_token }),
    });
    if (!res.ok) {
      console.warn('[LS-BG] トークンリフレッシュ失敗: status=', res.status);
      return false;
    }
    const result = await res.json();
    await chrome.storage.local.set({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    });
    accessToken = result.access_token;
    console.log('[LS-BG] トークンリフレッシュ成功 → loadAuth再実行');
    // リフレッシュ後に最新のauth状態をメモリに反映
    await loadAuth();
    return true;
  } catch (e) {
    console.error('[LS-BG] トークンリフレッシュエラー:', e.message);
    return false;
  }
}

async function apiRequest(path, options = {}) {
  // 毎回storageから最新のaccess_tokenを取得
  await loadAuth();
  if (!accessToken) throw new Error('Not authenticated');

  const makeHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    ...(options.headers || {}),
  });

  const res = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
    ...options,
    headers: makeHeaders(),
  });

  if (res.status === 401) {
    console.warn('[LS-BG] API 401応答 path=', path, '（accessTokenはクリアしない）');
    // 401でもaccessTokenをクリアしない — バックエンドAPIの問題でSPYを止めない
    // DMポーリングだけ停止
    stopDMPolling();
    throw new Error('API 401: ' + path);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `API error: ${res.status}`);
  }
  return res.json();
}

// ============================================================
// A.3: バッファ永続化ヘルパー
// ============================================================
async function persistBuffer() {
  try {
    await chrome.storage.local.set({
      [BUFFER_STORAGE_KEY]: messageBuffer.slice(-BUFFER_MAX),
    });
  } catch (e) {
    console.warn('[LS-BG] バッファ永続化エラー:', e.message);
  }
}

async function persistViewerBuffer() {
  try {
    await chrome.storage.local.set({
      [VIEWER_BUFFER_KEY]: viewerStatsBuffer.slice(-200),
    });
  } catch (e) {
    console.warn('[LS-BG] 視聴者バッファ永続化エラー:', e.message);
  }
}

async function restoreBuffers() {
  try {
    const data = await chrome.storage.local.get([BUFFER_STORAGE_KEY, VIEWER_BUFFER_KEY]);
    if (data[BUFFER_STORAGE_KEY]?.length > 0) {
      messageBuffer = data[BUFFER_STORAGE_KEY];
      console.log('[LS-BG] メッセージバッファ復元:', messageBuffer.length, '件');
    }
    if (data[VIEWER_BUFFER_KEY]?.length > 0) {
      viewerStatsBuffer = data[VIEWER_BUFFER_KEY];
      console.log('[LS-BG] 視聴者バッファ復元:', viewerStatsBuffer.length, '件');
    }
  } catch (e) {
    console.warn('[LS-BG] バッファ復元エラー:', e.message);
  }
}

// ============================================================
// SPY Message Buffer → Supabase REST API 直接POST
// バックエンドを経由せず直接spy_messagesに挿入
// ============================================================
async function flushMessageBuffer() {
  if (messageBuffer.length === 0) return;

  await loadAuth();

  if (!accountId) {
    console.warn('[LS-BG] accountId未設定 バッファ保持中:', messageBuffer.length, '件（次回flush時にリトライ）');
    return;
  }

  if (!accessToken) {
    console.warn('[LS-BG] accessToken未設定 バッファ保持中:', messageBuffer.length, '件');
    return;
  }

  const batch = [...messageBuffer];
  messageBuffer = [];
  persistBuffer();

  // Supabase REST API用の行データを作成（一括INSERT）
  const rows = batch.map(msg => ({
    account_id: accountId,
    cast_name: msg.cast_name || '',
    message_time: msg.message_time || new Date().toISOString(),
    msg_type: msg.msg_type || 'chat',
    user_name: msg.user_name || '',
    message: msg.message || '',
    tokens: msg.tokens || 0,
    is_vip: false,
    metadata: msg.metadata || {},
  }));

  console.log('[LS-BG] SPYメッセージ一括送信:', rows.length, '件 → Supabase REST API');

  try {
    let res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/spy_messages`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    // 401 → トークンリフレッシュ後リトライ
    if (res.status === 401) {
      console.warn('[LS-BG] Supabase 401 → リフレッシュ試行');
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/spy_messages`, {
          method: 'POST',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(rows),
        });
      }
    }

    if (res.ok || res.status === 201) {
      console.log('[LS-BG] SPYメッセージ一括送信成功:', rows.length, '件');
    } else {
      const errText = await res.text().catch(() => '');
      console.warn('[LS-BG] SPYメッセージ送信失敗:', res.status, errText);
      messageBuffer.push(...batch);
      persistBuffer();
    }
  } catch (err) {
    console.warn('[LS-BG] SPYメッセージ送信例外:', err.message);
    messageBuffer.push(...batch);
    persistBuffer();
  }
}

// ============================================================
// Viewer Stats Buffer → Supabase REST API 直接POST
// ============================================================
async function flushViewerStats() {
  if (viewerStatsBuffer.length === 0) return;

  await loadAuth();
  if (!accountId || !accessToken) {
    console.warn('[LS-BG] viewerStats: 認証未完了 バッファ保持');
    return;
  }

  const batch = [...viewerStatsBuffer];
  viewerStatsBuffer = [];
  persistViewerBuffer();

  try {
    const data = await chrome.storage.local.get(['last_cast_name']);
    const castName = data.last_cast_name || 'unknown';

    const rows = batch.map(s => ({
      account_id: accountId,
      cast_name: castName,
      total: s.total,
      coin_users: s.coin_users,
      others: s.others,
      ...(s.recorded_at ? { recorded_at: s.recorded_at } : {}),
    }));

    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/viewer_stats`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (res.ok || res.status === 201) {
      console.log('[LS-BG] 視聴者数バッチ送信成功:', rows.length, '件');
    } else {
      console.warn('[LS-BG] 視聴者数送信失敗:', res.status);
      viewerStatsBuffer.unshift(...batch);
      persistViewerBuffer();
    }
  } catch (err) {
    console.warn('[LS-BG] 視聴者数送信例外:', err.message);
    viewerStatsBuffer.unshift(...batch);
    persistViewerBuffer();
  }
}

// ============================================================
// Message Handlers
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // --- SPY: Chat message from content_spy.js ---
  if (msg.type === 'CHAT_MESSAGE') {
    // spyEnabledのみチェック — accountIdは不要（flush時に付与）
    if (!spyEnabled) {
      sendResponse({ ok: false, error: 'SPY not enabled' });
      return false;
    }

    // account_id は含めない（flush時にstorageから最新値を付与）
    const payload = {
      cast_name: msg.cast_name || '',
      message_time: msg.message_time || new Date().toISOString(),
      msg_type: msg.msg_type || 'chat',
      user_name: msg.user_name || '',
      message: msg.message || '',
      tokens: msg.tokens || 0,
      metadata: msg.metadata || {},
    };

    messageBuffer.push(payload);
    if (messageBuffer.length > BUFFER_MAX) {
      messageBuffer = messageBuffer.slice(-BUFFER_MAX);
    }
    spyMsgCount++;
    persistBuffer();

    if (!bufferTimer) {
      bufferTimer = setTimeout(() => {
        flushMessageBuffer();
        bufferTimer = null;
      }, CONFIG.SPY_BATCH_INTERVAL);
    }

    sendResponse({ ok: true, buffered: true, bufferSize: messageBuffer.length });
    return false;
  }

  // --- SPY: Viewer stats from content_spy.js ---
  if (msg.type === 'VIEWER_STATS') {
    // accountId不在でもバッファ（flush時に付与）
    viewerStatsBuffer.push({
      total: msg.total,
      coin_users: msg.coin_users,
      others: msg.others,
      recorded_at: msg.timestamp || new Date().toISOString(),
    });
    persistViewerBuffer();

    if (msg.cast_name) {
      chrome.storage.local.set({ last_cast_name: msg.cast_name });
    }

    if (!viewerStatsTimer) {
      viewerStatsTimer = setInterval(flushViewerStats, 180000);
    }

    sendResponse({ ok: true, buffered: true });
    return false;
  }

  // --- A.2: Heartbeat from content_spy.js ---
  if (msg.type === 'HEARTBEAT') {
    lastHeartbeat = Date.now();
    heartbeatAlerted = false;
    console.log('[LS-BG] ハートビート受信: cast=', msg.castName, 'observing=', msg.observing, 'msgs=', msg.messageCount);
    sendResponse({ ok: true });
    return false;
  }

  // --- Popup: Auth credentials updated (ログイン直後に即通知) ---
  if (msg.type === 'AUTH_UPDATED') {
    accessToken = msg.access_token || null;
    console.log('[LS-BG] AUTH_UPDATED受信: token=', accessToken ? accessToken.substring(0, 20) + '...' : 'null');
    // storageにも保存（popup側で既に保存済みだが念のため）
    const authData = {};
    if (msg.access_token) authData.access_token = msg.access_token;
    if (msg.refresh_token) authData.refresh_token = msg.refresh_token;
    chrome.storage.local.set(authData);
    // バッファにデータがあれば即座にflush試行
    if (messageBuffer.length > 0 && accountId) {
      console.log('[LS-BG] AUTH_UPDATED → バッファflush試行:', messageBuffer.length, '件');
      flushMessageBuffer();
    }
    sendResponse({ ok: true, authenticated: !!accessToken });
    return false;
  }

  // --- DM: Result from dm_executor.js ---
  if (msg.type === 'DM_RESULT') {
    apiRequest(`/api/dm/queue/${msg.dm_id}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        status: msg.status,
        error: msg.error || null,
        sent_at: new Date().toISOString(),
      }),
    })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // --- Popup: Get extension status ---
  if (msg.type === 'GET_STATUS') {
    loadAuth().then((auth) => {
      const status = {
        ok: true,
        authenticated: !!auth.accessToken,
        accountId: auth.accountId,
        spyEnabled: auth.spyEnabled,
        polling: !!dmPollingTimer,
        spyMsgCount,
        lastHeartbeat: lastHeartbeat || null,
        bufferSize: messageBuffer.length,
      };
      console.log('[LS-BG] GET_STATUS応答:', JSON.stringify(status));
      sendResponse(status);
    });
    return true;
  }

  // --- Popup: Get DM queue ---
  if (msg.type === 'GET_DM_QUEUE') {
    loadAuth().then(() => {
      if (!accountId) {
        sendResponse({ ok: true, data: [] });
        return;
      }
      apiRequest(`/api/dm/queue?account_id=${accountId}&status=queued&limit=50`)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }

  // --- Popup: Toggle SPY ---
  if (msg.type === 'TOGGLE_SPY') {
    spyEnabled = msg.enabled;
    chrome.storage.local.set({ spy_enabled: spyEnabled });
    console.log('[LS-BG] SPY切替: enabled=', spyEnabled, 'accountId=', accountId);
    if (spyEnabled) {
      lastHeartbeat = Date.now();
      heartbeatAlerted = false;
      chrome.storage.local.set({ spy_started_at: new Date().toISOString() });
      // SPY開始時にaccountIdが未設定なら警告
      if (!accountId) {
        console.warn('[LS-BG] 注意: SPY有効化されたがaccountId未設定 メッセージはバッファされflush時に付与');
      }
    } else {
      chrome.storage.local.set({ spy_started_at: null, spy_cast: null });
    }
    chrome.tabs.query(
      { url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] },
      (tabs) => {
        console.log('[LS-BG] Stripchatタブ数:', tabs.length);
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'SPY_STATE',
            enabled: spyEnabled,
          }).then(() => {
            console.log('[LS-BG] SPY_STATE送信成功 tab=', tab.id);
          }).catch((e) => {
            console.warn('[LS-BG] SPY_STATE送信失敗 tab=', tab.id, e.message);
          });
        });
      }
    );
    sendResponse({ ok: true, spyEnabled });
    return false;
  }

  // --- Popup: Get accounts list (Supabase REST API直接) ---
  if (msg.type === 'GET_ACCOUNTS') {
    loadAuth().then(async () => {
      if (!accessToken) {
        sendResponse({ ok: false, error: 'Not authenticated' });
        return;
      }
      try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
          },
        });
        if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
        const data = await res.json();
        // アカウントが1つだけの場合は自動選択
        if (Array.isArray(data) && data.length === 1 && !accountId) {
          accountId = data[0].id;
          chrome.storage.local.set({ account_id: accountId });
          console.log('[LS-BG] アカウント自動選択:', accountId, data[0].account_name);
        }
        sendResponse({ ok: true, data });
      } catch (err) {
        console.warn('[LS-BG] アカウント取得失敗:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true;
  }

  // --- Popup: Set active account ---
  if (msg.type === 'SET_ACCOUNT') {
    accountId = msg.account_id;
    chrome.storage.local.set({ account_id: msg.account_id });
    console.log('[LS-BG] アカウント設定:', msg.account_id);
    // accountIdが設定されたら溜まっているバッファのflushを試行
    if (messageBuffer.length > 0) {
      console.log('[LS-BG] アカウント設定完了 → 溜まっているバッファ', messageBuffer.length, '件のflush試行');
      flushMessageBuffer();
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ============================================================
// DM Queue Polling
// ============================================================
function startDMPolling() {
  if (dmPollingTimer) return;
  console.log('[LS-BG] DMポーリング開始');

  dmPollingTimer = setInterval(async () => {
    try {
      await loadAuth();
      if (!accountId || !accessToken) return;

      const tasks = await apiRequest(
        `/api/dm/queue?account_id=${accountId}&status=queued&limit=5`
      );

      if (!tasks || tasks.length === 0) return;

      const tabs = await chrome.tabs.query({
        url: ['*://stripchat.com/*', '*://*.stripchat.com/*'],
      });

      if (tabs.length === 0) return;

      for (const task of tasks) {
        await apiRequest(`/api/dm/queue/${task.id}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'sending' }),
        }).catch(() => {});
      }

      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'EXECUTE_DM',
        tasks,
      }).catch((err) => {
        console.warn('[LS-BG] DMタスク送信失敗:', err.message);
        tasks.forEach((task) => {
          apiRequest(`/api/dm/queue/${task.id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status: 'queued' }),
          }).catch(() => {});
        });
      });
    } catch (e) {
      console.warn('[LS-BG] DMポーリングエラー:', e.message);
    }
  }, CONFIG.POLL_INTERVAL);
}

function stopDMPolling() {
  if (dmPollingTimer) {
    clearInterval(dmPollingTimer);
    dmPollingTimer = null;
    console.log('[LS-BG] DMポーリング停止');
  }
}

// ============================================================
// Lifecycle
// ============================================================
console.log('[LS-BG] === Service Worker起動 ===');

restoreBuffers().then(() => {
  loadAuth().then(async () => {
    console.log('[LS-BG] 認証状態: token=', !!accessToken, 'account=', accountId, 'spy=', spyEnabled);
    if (accessToken && accountId) {
      startDMPolling();
      console.log('[LS-BG] 初期化完了 DMポーリング開始');
    } else if (accessToken && !accountId) {
      console.log('[LS-BG] 初期化完了 accountId未設定 → Supabase REST APIでアカウント自動取得');
      try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            accountId = data[0].id;
            chrome.storage.local.set({ account_id: accountId });
            console.log('[LS-BG] アカウント自動設定:', accountId, data[0].account_name);
            startDMPolling();
            if (messageBuffer.length > 0) flushMessageBuffer();
          }
        } else {
          console.warn('[LS-BG] Supabase accounts取得失敗:', res.status);
        }
      } catch (err) {
        console.warn('[LS-BG] アカウント自動取得失敗:', err.message);
      }
    } else {
      console.log('[LS-BG] 初期化完了 認証待ち');
    }
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.access_token || changes.account_id) {
    console.log('[LS-BG] Storage変更検出: access_token変更=', !!changes.access_token, 'account_id変更=', !!changes.account_id);
    loadAuth().then(() => {
      console.log('[LS-BG] Storage変更後の状態: token=', !!accessToken, 'account=', accountId);
      if (accessToken && accountId) {
        startDMPolling();
        // バッファflush試行
        if (messageBuffer.length > 0) {
          console.log('[LS-BG] Storage変更でaccountId取得 → バッファflush試行:', messageBuffer.length, '件');
          flushMessageBuffer();
        }
      } else {
        stopDMPolling();
      }
    });
  }
  if (changes.spy_enabled) {
    spyEnabled = changes.spy_enabled.newValue === true;
    console.log('[LS-BG] spy_enabled変更:', spyEnabled);
  }
});
