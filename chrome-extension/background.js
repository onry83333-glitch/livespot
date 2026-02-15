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
let whisperPollingTimer = null;
let dmProcessing = false;
let pendingDMResolve = null;
let pendingDMTaskId = null;

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
// SPY データ品質バリデーション
// ============================================================
const VALID_MSG_TYPES = ['chat', 'tip', 'gift', 'goal', 'enter', 'leave', 'system', 'viewer_count'];

function validateSpyMessage(msg) {
  // 1. メッセージ本文が500文字超 → 連結バグの残骸
  if (msg.message && msg.message.length > 500) {
    console.warn('[LS-BG] バリデーション除外: メッセージが500文字超',
      msg.user_name, msg.message.length, '文字');
    return false;
  }

  // 2. ユーザー名に改行・タブが含まれる
  if (msg.user_name && /[\n\r\t]/.test(msg.user_name)) {
    console.warn('[LS-BG] バリデーション除外: ユーザー名不正', msg.user_name);
    return false;
  }

  // 3. msg_typeが想定値以外
  if (msg.msg_type && !VALID_MSG_TYPES.includes(msg.msg_type)) {
    console.warn('[LS-BG] バリデーション除外: 不正なmsg_type', msg.msg_type);
    return false;
  }

  // 4. chatタイプでメッセージがユーザー名と完全一致（旧バグパターン）
  if (msg.msg_type === 'chat' && msg.message && msg.user_name &&
      msg.message.trim() === msg.user_name.trim()) {
    console.warn('[LS-BG] バリデーション除外: メッセージ=ユーザー名', msg.user_name);
    return false;
  }

  return true;
}

function deduplicateBuffer(messages) {
  const seen = new Set();
  return messages.filter(msg => {
    const key = `${msg.message_time}|${msg.user_name}|${msg.message}`;
    if (seen.has(key)) {
      console.log('[LS-BG] 重複除去:', msg.user_name, msg.message?.substring(0, 30));
      return false;
    }
    seen.add(key);
    return true;
  });
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

  // バリデーション + 重複除去
  const validated = batch.filter(validateSpyMessage);
  const deduplicated = deduplicateBuffer(validated);
  const droppedCount = batch.length - deduplicated.length;
  if (droppedCount > 0) {
    console.log('[LS-BG] バリデーション/重複除去で', droppedCount, '件除外');
  }
  if (deduplicated.length === 0) {
    console.log('[LS-BG] 有効なメッセージなし — 送信スキップ');
    return;
  }

  // Supabase REST API用の行データを作成（一括INSERT）
  const rows = deduplicated.map(msg => ({
    account_id: accountId,
    cast_name: msg.cast_name || '',
    message_time: msg.message_time || new Date().toISOString(),
    msg_type: msg.msg_type || 'chat',
    user_name: msg.user_name || '',
    message: msg.message || '',
    tokens: msg.tokens || 0,
    is_vip: false,
    user_color: msg.user_color || null,
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
// Whisper Polling (10秒間隔で未読whisperを取得 → Stripchatタブへ転送)
// ============================================================
async function pollWhispers() {
  try {
    await loadAuth();
    if (!accountId || !accessToken) return;

    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/whispers?account_id=eq.${accountId}&read_at=is.null&order=created_at.asc&limit=5`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );

    if (!res.ok) return;

    const whispers = await res.json();
    if (!Array.isArray(whispers) || whispers.length === 0) return;

    console.log('[LS-BG] 未読Whisper取得:', whispers.length, '件');

    const tabs = await chrome.tabs.query({
      url: ['*://stripchat.com/*', '*://*.stripchat.com/*'],
    });
    if (tabs.length === 0) return;

    for (const whisper of whispers) {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'SHOW_WHISPER',
          whisper_id: whisper.id,
          message: whisper.message,
          cast_name: whisper.cast_name,
          template_name: whisper.template_name,
        }).catch(() => {});
      }
    }
  } catch (e) {
    // silent — polling errors are non-critical
  }
}

function startWhisperPolling() {
  if (whisperPollingTimer) return;
  console.log('[LS-BG] Whisperポーリング開始(10秒間隔)');
  pollWhispers();
  whisperPollingTimer = setInterval(pollWhispers, 10000);
}

function stopWhisperPolling() {
  if (whisperPollingTimer) {
    clearInterval(whisperPollingTimer);
    whisperPollingTimer = null;
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
      user_color: msg.user_color || null,
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

  // --- Whisper: Mark as read (content_whisper.jsから) ---
  if (msg.type === 'WHISPER_READ') {
    loadAuth().then(async () => {
      if (!accessToken) {
        sendResponse({ ok: false });
        return;
      }
      try {
        await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/whispers?id=eq.${msg.whisper_id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ read_at: new Date().toISOString() }),
          }
        );
        console.log('[LS-BG] Whisper既読更新:', msg.whisper_id);
        sendResponse({ ok: true });
      } catch (err) {
        console.warn('[LS-BG] Whisper既読更新失敗:', err.message);
        sendResponse({ ok: false });
      }
    });
    return true;
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

  // --- DM: Result from dm_executor.js (v2: SEND_DM → DM_SEND_RESULT) ---
  if (msg.type === 'DM_SEND_RESULT') {
    console.log('[LS-BG] DM_SEND_RESULT受信: taskId=', msg.taskId, 'success=', msg.success);
    // pendingDMResolve で待機中の Promise を解決
    if (pendingDMResolve && pendingDMTaskId === msg.taskId) {
      pendingDMResolve({ success: msg.success, error: msg.error || null });
      pendingDMResolve = null;
      pendingDMTaskId = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  // --- DM: Legacy DM_RESULT (互換性) ---
  if (msg.type === 'DM_RESULT') {
    console.log('[LS-BG] DM_RESULT (レガシー): dm_id=', msg.dm_id);
    sendResponse({ ok: true });
    return false;
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

  // --- Popup: Get DM queue (Supabase直接) ---
  if (msg.type === 'GET_DM_QUEUE') {
    loadAuth().then(async () => {
      if (!accountId || !accessToken) {
        sendResponse({ ok: true, data: [] });
        return;
      }
      try {
        const url = `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`
          + `?account_id=eq.${accountId}&status=in.(queued,sending)`
          + `&order=created_at.asc&limit=50`
          + `&select=id,user_name,message,status,campaign,created_at`;
        const res = await fetch(url, {
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
          },
        });
        if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
        const data = await res.json();
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
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
// DM Queue — Supabase直接ポーリング + タブ遷移方式
// ============================================================

/**
 * Supabase REST APIでDMキューから1件取得
 */
async function fetchNextDMTask() {
  await loadAuth();
  if (!accountId || !accessToken) return null;

  const url = `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`
    + `?account_id=eq.${accountId}&status=eq.queued`
    + `&order=created_at.asc&limit=1`
    + `&select=id,user_name,profile_url,message,campaign`;

  const res = await fetch(url, {
    headers: {
      'apikey': CONFIG.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) return null;
      return fetchNextDMTask();
    }
    return null;
  }

  const data = await res.json();
  return (Array.isArray(data) && data.length > 0) ? data[0] : null;
}

/**
 * DM送信ログのステータスをSupabase直接更新
 */
async function updateDMTaskStatus(taskId, status, error) {
  await loadAuth();
  if (!accessToken) return;

  const body = { status };
  if (error) body.error = error;
  if (status === 'success') body.sent_at = new Date().toISOString();

  await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log?id=eq.${taskId}`, {
    method: 'PATCH',
    headers: {
      'apikey': CONFIG.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch(err => console.warn('[LS-BG] DMステータス更新失敗:', err.message));
}

/**
 * Stripchatタブを取得または作成
 */
async function getOrCreateStripchatTab() {
  const tabs = await chrome.tabs.query({
    url: ['*://stripchat.com/*', '*://*.stripchat.com/*'],
  });
  if (tabs.length > 0) return tabs[0];

  // 新しいタブを作成
  const newTab = await chrome.tabs.create({
    url: 'https://stripchat.com/',
    active: false,
  });
  // ページロードを待つ
  await waitForTabComplete(newTab.id, 15000);
  return newTab;
}

/**
 * タブのロード完了を待つ
 */
function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);

    // タイムアウト
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    }, timeout);

    // 既にcompleteの場合
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }).catch(() => resolve(false));
  });
}

/**
 * dm_executor.js からの結果を待つ（Promiseベース）
 */
function waitForDMResult(taskId, timeout = 30000) {
  return new Promise((resolve) => {
    pendingDMTaskId = taskId;
    pendingDMResolve = resolve;

    setTimeout(() => {
      if (pendingDMResolve && pendingDMTaskId === taskId) {
        pendingDMResolve = null;
        pendingDMTaskId = null;
        resolve({ success: false, error: 'タイムアウト (30秒)' });
      }
    }, timeout);
  });
}

function sleep_bg(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * DMタスクを1件処理（タブ遷移 → 送信指示 → 結果待ち）
 */
async function processSingleDMTask(task) {
  console.log('[LS-BG] DM処理開始: id=', task.id, 'user=', task.user_name);

  // 1. ステータスを sending に更新
  await updateDMTaskStatus(task.id, 'sending', null);

  try {
    // 2. Stripchatタブを取得
    const tab = await getOrCreateStripchatTab();

    // 3. プロフィールURLに遷移
    const profileUrl = task.profile_url
      || `https://stripchat.com/user/${task.user_name}`;
    console.log('[LS-BG] タブ遷移:', profileUrl);

    await chrome.tabs.update(tab.id, { url: profileUrl });

    // 4. ページロード完了を待つ
    const loaded = await waitForTabComplete(tab.id, 15000);
    if (!loaded) {
      throw new Error('ページロードタイムアウト');
    }

    // ページロード後の描画安定待ち
    await sleep_bg(3000);

    // 5. content script に DM送信を指示
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'SEND_DM',
        taskId: task.id,
        username: task.user_name,
        message: task.message,
      });
    } catch (err) {
      throw new Error('DM executor通信失敗: ' + err.message);
    }

    // 6. 結果を待つ
    const result = await waitForDMResult(task.id, CONFIG.DM_SEND_TIMEOUT);

    // 7. ステータス更新
    if (result.success) {
      await updateDMTaskStatus(task.id, 'success', null);
      console.log('[LS-BG] DM送信成功: user=', task.user_name);
    } else {
      await updateDMTaskStatus(task.id, 'error', result.error);
      console.warn('[LS-BG] DM送信失敗: user=', task.user_name, 'error=', result.error);
    }
  } catch (err) {
    console.error('[LS-BG] DM処理例外: user=', task.user_name, err.message);
    await updateDMTaskStatus(task.id, 'error', err.message);
  }
}

/**
 * DMキューを順次処理（ポーリングで1件ずつ取得→処理→次へ）
 */
async function processDMQueue() {
  if (dmProcessing) return;
  dmProcessing = true;

  try {
    while (true) {
      const task = await fetchNextDMTask();
      if (!task) break; // キューが空

      await processSingleDMTask(task);

      // レート制限: 3-8秒ランダム待機
      const delay = 3000 + Math.random() * 5000;
      console.log('[LS-BG] DM次タスクまで', Math.round(delay / 1000), '秒待機');
      await sleep_bg(delay);
    }
  } catch (e) {
    console.warn('[LS-BG] DMキュー処理エラー:', e.message);
  } finally {
    dmProcessing = false;
  }
}

function startDMPolling() {
  if (dmPollingTimer) return;
  console.log('[LS-BG] DMポーリング開始 (Supabase直接, 10秒間隔)');

  // 即時1回実行
  processDMQueue();

  dmPollingTimer = setInterval(() => {
    processDMQueue();
  }, 10000);
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
      startWhisperPolling();
      console.log('[LS-BG] 初期化完了 DM/Whisperポーリング開始');
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
            startWhisperPolling();
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
        startWhisperPolling();
        // バッファflush試行
        if (messageBuffer.length > 0) {
          console.log('[LS-BG] Storage変更でaccountId取得 → バッファflush試行:', messageBuffer.length, '件');
          flushMessageBuffer();
        }
      } else {
        stopDMPolling();
        stopWhisperPolling();
      }
    });
  }
  if (changes.spy_enabled) {
    spyEnabled = changes.spy_enabled.newValue === true;
    console.log('[LS-BG] spy_enabled変更:', spyEnabled);
  }
});
