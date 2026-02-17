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
const pendingDMResults = new Map(); // taskId → { resolve, timeoutId }

// A.2: Heartbeat tracking
let lastHeartbeat = 0;
let heartbeatAlerted = false;

// Badge: SPY稼働インジケーター
function updateBadge() {
  if (spyEnabled) {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// STT (Speech-to-Text) state
let sttEnabled = false;
let sttChunkQueue = [];
let sttProcessing = 0;               // 同時処理数カウンター
const STT_MAX_CONCURRENT = 2;        // 最大同時transcribe数
const sttTabStates = {};              // tabId → { castName, lastChunkAt, chunkCount }

const BUFFER_STORAGE_KEY = 'spy_message_buffer';
const VIEWER_BUFFER_KEY = 'spy_viewer_buffer';
const BUFFER_MAX = 1000;

// 自社キャスト名キャッシュ（STTフィルタ用）
let registeredCastNames = new Set();

// ============================================================
// A.1: Service Worker Keepalive via chrome.alarms
// ============================================================
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    flushMessageBuffer();
    flushViewerStats();
    checkHeartbeatTimeout();
    cleanupStaleSTTTabs();
  }
});

// STTタブの古いエントリをクリーンアップ（60秒以上チャンクなし）
function cleanupStaleSTTTabs() {
  const now = Date.now();
  for (const tabId of Object.keys(sttTabStates)) {
    if (now - sttTabStates[tabId].lastChunkAt > 60000) {
      console.log('[LS-BG] STTタブ削除（stale）: tab=', tabId, 'cast=', sttTabStates[tabId].castName);
      delete sttTabStates[tabId];
    }
  }
}

// タブが閉じられたらSTT状態をクリーンアップ
chrome.tabs.onRemoved.addListener((tabId) => {
  if (sttTabStates[tabId]) {
    console.log('[LS-BG] STTタブ削除（closed）: tab=', tabId, 'cast=', sttTabStates[tabId].castName);
    delete sttTabStates[tabId];
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
    'access_token', 'account_id', 'api_base_url', 'spy_enabled', 'stt_enabled',
  ]);
  accessToken = data.access_token || null;
  accountId = data.account_id || null;
  spyEnabled = data.spy_enabled === true;
  sttEnabled = data.stt_enabled === true;
  if (data.api_base_url) {
    CONFIG.API_BASE_URL = data.api_base_url;
  }
  return { accessToken, accountId, spyEnabled, sttEnabled };
}

/**
 * 自社キャスト名をSupabaseから取得してキャッシュ（STTフィルタ用）
 */
async function loadRegisteredCasts() {
  if (!accessToken || !accountId) return;
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&is_active=eq.true&select=cast_name`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );
    if (res.ok) {
      const data = await res.json();
      registeredCastNames = new Set(data.map(r => r.cast_name));
      console.log('[LS-BG] 自社キャスト名キャッシュ更新:', [...registeredCastNames]);
    }
  } catch (err) {
    console.warn('[LS-BG] 自社キャスト名取得失敗:', err.message);
  }
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
const VALID_MSG_TYPES = ['chat', 'tip', 'gift', 'goal', 'enter', 'leave', 'system', 'viewer_count', 'speech'];

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

  // --- STT: Audio chunk from content_stt_relay.js ---
  if (msg.type === 'AUDIO_CHUNK') {
    if (!sttEnabled) {
      sendResponse({ ok: false, error: 'STT not enabled' });
      return false;
    }
    const tabId = sender.tab?.id || 0;
    const castName = msg.castName || 'unknown';

    // STTは自社キャスト（registered_casts）のみ処理
    if (registeredCastNames.size > 0 && !registeredCastNames.has(castName)) {
      console.log('[LS-BG] STTスキップ: 他社キャスト cast=', castName);
      sendResponse({ ok: false, error: '他社キャストはSTT対象外' });
      return false;
    }

    // タブ別状態を更新
    if (!sttTabStates[tabId]) {
      sttTabStates[tabId] = { castName, lastChunkAt: Date.now(), chunkCount: 0 };
      console.log('[LS-BG] STT新タブ検出: tab=', tabId, 'cast=', castName,
        'アクティブタブ数:', Object.keys(sttTabStates).length);
    }
    sttTabStates[tabId].lastChunkAt = Date.now();
    sttTabStates[tabId].chunkCount++;
    sttTabStates[tabId].castName = castName;

    // キューに追加（上限超過時は古いものを破棄）
    sttChunkQueue.push({
      data: msg.data,
      castName: castName,
      tabId: tabId,
      timestamp: msg.timestamp,
    });
    if (sttChunkQueue.length > (CONFIG.STT_MAX_QUEUE_SIZE || 20)) {
      const dropped = sttChunkQueue.shift();
      console.warn('[LS-BG] STTキュー溢れ: 古いチャンク破棄 cast=', dropped.castName, 'tab=', dropped.tabId);
    }
    processSTTQueue();
    sendResponse({ ok: true, queued: sttChunkQueue.length });
    return false;
  }

  // --- STT: Status from content_stt_relay.js ---
  if (msg.type === 'STT_STATUS') {
    const tabId = sender.tab?.id || 0;
    console.log('[LS-BG] STTステータス: tab=', tabId, msg.status, 'cast=', msg.castName, msg.message || '');
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
    console.log('[LS-BG] DM_SEND_RESULT受信: taskId=', msg.taskId, 'success=', msg.success, 'error=', msg.error);
    const entry = pendingDMResults.get(msg.taskId);
    if (entry) {
      clearTimeout(entry.timeoutId);
      pendingDMResults.delete(msg.taskId);
      entry.resolve({ success: msg.success, error: msg.error || null });
      console.log('[LS-BG] DM結果をPromiseに反映済み: taskId=', msg.taskId, 'success=', msg.success);
    } else {
      // タイムアウト済み — 遅延到着した成功結果でステータスを上書き
      console.warn('[LS-BG] DM_SEND_RESULT: タイムアウト済み（遅延到着） taskId=', msg.taskId, 'success=', msg.success);
      if (msg.success) {
        console.log('[LS-BG] 遅延成功 → error→successに上書き: taskId=', msg.taskId);
        updateDMTaskStatus(msg.taskId, 'success', null);
      }
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

  // --- Popup: Coin Sync trigger ---
  if (msg.type === 'SYNC_COINS') {
    console.log('[LS-BG] SYNC_COINS リクエスト受信');
    handleCoinSync().then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // async
  }

  // --- Popup: Get extension status ---
  if (msg.type === 'GET_STATUS') {
    loadAuth().then(async (auth) => {
      const syncData = await chrome.storage.local.get(['last_coin_sync', 'coin_sync_count']);
      // STTタブ情報を収集
      const sttTabs = Object.entries(sttTabStates).map(([tid, s]) => ({
        tabId: parseInt(tid),
        castName: s.castName,
        chunkCount: s.chunkCount,
        lastChunkAt: s.lastChunkAt,
      }));

      const status = {
        ok: true,
        authenticated: !!auth.accessToken,
        accountId: auth.accountId,
        spyEnabled: auth.spyEnabled,
        sttEnabled: sttEnabled,
        sttTabs: sttTabs,
        polling: !!dmPollingTimer,
        spyMsgCount,
        lastHeartbeat: lastHeartbeat || null,
        bufferSize: messageBuffer.length,
        lastCoinSync: syncData.last_coin_sync || null,
        coinSyncCount: syncData.coin_sync_count || 0,
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
    updateBadge();
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

  // --- Popup: Toggle STT ---
  if (msg.type === 'TOGGLE_STT') {
    sttEnabled = msg.enabled;
    chrome.storage.local.set({ stt_enabled: sttEnabled });
    console.log('[LS-BG] STT切替: enabled=', sttEnabled);

    // Stripchatタブに通知
    chrome.tabs.query(
      { url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] },
      (tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'STT_STATE',
            enabled: sttEnabled,
          }).catch(() => {});
        });
      }
    );
    sendResponse({ ok: true, sttEnabled });
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
// STT Queue Processing — 音声チャンクをFastAPIに送信（並行処理対応）
// 最大STT_MAX_CONCURRENT件を同時にtranscribe
// ============================================================
async function processSTTQueue() {
  if (sttChunkQueue.length === 0) return;
  if (sttProcessing >= STT_MAX_CONCURRENT) return;

  // 処理できる分だけ取り出す
  while (sttChunkQueue.length > 0 && sttProcessing < STT_MAX_CONCURRENT) {
    const chunk = sttChunkQueue.shift();
    sttProcessing++;
    processOneSTTChunk(chunk).finally(() => {
      sttProcessing--;
      // 残りがあれば続行
      if (sttChunkQueue.length > 0) processSTTQueue();
    });
  }
}

async function processOneSTTChunk(chunk) {
  await loadAuth();
  if (!accountId || !accessToken) {
    console.warn('[LS-BG] STT: 認証未完了 チャンク破棄 cast=', chunk.castName);
    return;
  }

  try {
    const endpoint = CONFIG.STT_API_ENDPOINT || '/api/stt/transcribe';
    let res = await fetch(`${CONFIG.API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        account_id: accountId,
        cast_name: chunk.castName,
        audio_base64: chunk.data,
        timestamp: chunk.timestamp,
      }),
    });

    // 401 → トークンリフレッシュ後リトライ
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        res = await fetch(`${CONFIG.API_BASE_URL}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            account_id: accountId,
            cast_name: chunk.castName,
            audio_base64: chunk.data,
            timestamp: chunk.timestamp,
          }),
        });
      }
    }

    if (res.ok) {
      const data = await res.json();
      if (data.text) {
        console.log('[LS-BG] STT結果: tab=', chunk.tabId, 'cast=', chunk.castName,
          'text=', data.text.substring(0, 80), 'conf=', data.confidence);
      }
    } else {
      console.warn('[LS-BG] STT API error: tab=', chunk.tabId, 'cast=', chunk.castName, 'status=', res.status);
    }
  } catch (err) {
    console.warn('[LS-BG] STT処理エラー: tab=', chunk.tabId, 'cast=', chunk.castName, err.message);
  }
}

// ============================================================
// Coin Sync — Stripchat Earnings API → Supabase直接INSERT
// ============================================================

/**
 * コイン同期メインフロー
 * 1. Stripchatタブを検索
 * 2. content_coin_sync.jsにFETCH_COINS送信
 * 3. 取得データをSupabaseに保存
 */
async function handleCoinSync() {
  await loadAuth();
  if (!accountId || !accessToken) {
    return { ok: false, error: 'ログインしてアカウントを選択してください' };
  }

  // Stripchatタブを検索
  const tabs = await chrome.tabs.query({
    url: ['*://stripchat.com/*', '*://*.stripchat.com/*'],
  });

  if (tabs.length === 0) {
    return { ok: false, error: 'Stripchatタブを開いてログインしてください' };
  }

  const targetTab = tabs[0];
  console.log('[LS-BG] Coin同期: Stripchatタブ=', targetTab.id, targetTab.url);

  // content_coin_sync.jsを動的注入（既にロード済みでも再注入は安全）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      files: ['content_coin_sync.js'],
    });
    console.log('[LS-BG] content_coin_sync.js 動的注入成功: tab=', targetTab.id);
    // スクリプト初期化を待つ
    await sleep_bg(500);
  } catch (injectErr) {
    console.error('[LS-BG] content_coin_sync.js 注入失敗:', injectErr.message);
    return { ok: false, error: 'Content script注入失敗: ' + injectErr.message };
  }

  // content scriptにFETCH_COINS送信
  let fetchResult;
  try {
    fetchResult = await chrome.tabs.sendMessage(targetTab.id, {
      type: 'FETCH_COINS',
      options: { maxPages: 10, limit: 100 },
    });
  } catch (err) {
    console.error('[LS-BG] FETCH_COINS送信失敗:', err.message);
    return { ok: false, error: 'Content script通信失敗: ' + err.message };
  }

  if (!fetchResult || fetchResult.error) {
    const errMsg = fetchResult?.message || fetchResult?.error || '不明なエラー';
    console.warn('[LS-BG] Coin取得エラー:', errMsg);
    return { ok: false, error: errMsg };
  }

  const transactions = fetchResult.transactions || [];
  const payingUsers = fetchResult.payingUsers || [];

  if (transactions.length === 0 && payingUsers.length === 0) {
    return { ok: true, synced: 0, message: 'トランザクションが見つかりませんでした' };
  }

  console.log('[LS-BG] COIN_SYNC_DATA:', transactions.length, '件受信, 有料ユーザー:', payingUsers.length, '名');

  // Supabaseに保存
  const result = await processCoinSyncData(transactions);

  // 有料ユーザー一覧をpaid_usersにUPSERT（transactions APIとは別に）
  if (payingUsers.length > 0) {
    await processPayingUsersData(payingUsers);
    result.payingUsers = payingUsers.length;
    result.message = `${result.synced || 0}件のトランザクション、${payingUsers.length}名の有料ユーザーを同期しました`;
  }

  return result;
}

/**
 * コイントランザクションデータをSupabase REST APIで直接保存
 * 1. coin_transactions INSERT
 * 2. paid_users UPSERT（ユーザー別集計）
 * 3. refresh_paying_users RPC（マテビュー更新）
 */
async function processCoinSyncData(transactions) {
  await loadAuth();
  if (!accountId || !accessToken) {
    return { ok: false, error: '認証エラー' };
  }

  // フィールドマッピング（Stripchat API → coin_transactions）
  const txRows = [];
  for (const tx of transactions) {
    const userName = tx.userName || tx.user_name || tx.username || '';
    const tokens = parseInt(tx.tokens || tx.amount || 0, 10);
    const txType = tx.type || tx.source || 'unknown';
    const txDate = tx.date || tx.createdAt || tx.created_at || new Date().toISOString();
    const sourceDetail = tx.description || tx.sourceDetail || '';

    if (!userName) continue;

    txRows.push({
      account_id: accountId,
      user_name: userName,
      tokens: tokens,
      type: txType,
      date: txDate,
      source_detail: sourceDetail,
    });
  }

  if (txRows.length === 0) {
    return { ok: true, synced: 0, message: '有効なトランザクションがありません' };
  }

  // 1. coin_transactions INSERT
  let insertedTx = 0;
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/coin_transactions`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(txRows),
    });

    if (res.ok || res.status === 201) {
      insertedTx = txRows.length;
      console.log('[LS-BG] coin_transactions INSERT成功:', insertedTx, '件');
    } else {
      const errText = await res.text().catch(() => '');
      console.warn('[LS-BG] coin_transactions INSERT失敗:', res.status, errText);
      // 重複エラー(409)の場合は続行
      if (res.status !== 409) {
        return { ok: false, error: `DB挿入エラー: HTTP ${res.status}` };
      }
      console.log('[LS-BG] 一部重複あり — paid_users更新を続行');
    }
  } catch (err) {
    console.error('[LS-BG] coin_transactions INSERT例外:', err.message);
    return { ok: false, error: 'DB接続エラー: ' + err.message };
  }

  // 2. paid_users UPSERT（ユーザー別集計）
  const userAgg = {};
  for (const row of txRows) {
    const un = row.user_name;
    if (!userAgg[un]) {
      userAgg[un] = { total_coins: 0, last_payment_date: null };
    }
    userAgg[un].total_coins += row.tokens;
    if (!userAgg[un].last_payment_date || row.date > userAgg[un].last_payment_date) {
      userAgg[un].last_payment_date = row.date;
    }
  }

  const userRows = Object.entries(userAgg).map(([un, agg]) => ({
    account_id: accountId,
    user_name: un,
    total_coins: agg.total_coins,
    last_payment_date: agg.last_payment_date,
  }));

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/paid_users`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(userRows),
    });

    if (res.ok || res.status === 201) {
      console.log('[LS-BG] paid_users UPSERT成功:', userRows.length, '件');
    } else {
      console.warn('[LS-BG] paid_users UPSERT失敗:', res.status);
    }
  } catch (err) {
    console.warn('[LS-BG] paid_users UPSERT例外:', err.message);
  }

  // 3. refresh_paying_users RPC（マテビュー更新）
  try {
    await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/refresh_paying_users`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    console.log('[LS-BG] paying_usersマテビュー更新完了');
  } catch (err) {
    console.warn('[LS-BG] マテビュー更新失敗（非致命的）:', err.message);
  }

  // 同期ステータス保存
  await chrome.storage.local.set({
    last_coin_sync: new Date().toISOString(),
    coin_sync_count: insertedTx,
  });

  console.log('[LS-BG] ========== Coin同期完了 ==========');
  console.log('[LS-BG] トランザクション:', insertedTx, '件 / ユーザー:', userRows.length, '名');

  return {
    ok: true,
    synced: insertedTx,
    users: userRows.length,
    message: `${insertedTx}件のトランザクション、${userRows.length}名のユーザーを同期しました`,
  };
}

/**
 * 有料ユーザー一覧データ（/transactions/users API）をpaid_usersにUPSERT
 */
async function processPayingUsersData(payingUsers) {
  await loadAuth();
  if (!accountId || !accessToken) return;

  const rows = payingUsers
    .filter(u => u.userName)
    .map(u => ({
      account_id: accountId,
      user_name: u.userName,
      total_coins: u.totalTokens || 0,
      last_payment_date: u.lastPaid || null,
    }));

  if (rows.length === 0) return;

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/paid_users`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (res.ok || res.status === 201) {
      console.log('[LS-BG] paid_users UPSERT成功（有料ユーザー一覧API）:', rows.length, '名');
    } else {
      console.warn('[LS-BG] paid_users UPSERT失敗:', res.status);
    }
  } catch (err) {
    console.warn('[LS-BG] paid_users UPSERT例外:', err.message);
  }
}

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
 * Supabase REST APIでDMキューから複数件取得（パイプライン用）
 */
async function fetchDMBatch(limit = 50) {
  await loadAuth();
  if (!accountId || !accessToken) return [];

  const url = `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`
    + `?account_id=eq.${accountId}&status=eq.queued`
    + `&order=created_at.asc&limit=${limit}`
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
      if (!refreshed) return [];
      return fetchDMBatch(limit);
    }
    return [];
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * キャンペーン文字列から送信モード設定をパース
 * Format: "pipe{N}_{batchId}" → pipeline, N tabs
 *         "seq_{batchId}" → sequential
 *         other → sequential (旧フォーマット互換)
 */
function parseBatchConfig(campaign) {
  if (!campaign) return { mode: 'sequential', tabCount: 1 };
  const pipeMatch = campaign.match(/^pipe(\d+)_/);
  if (pipeMatch) {
    return { mode: 'pipeline', tabCount: Math.min(parseInt(pipeMatch[1], 10), 5) };
  }
  if (campaign.startsWith('seq_')) {
    return { mode: 'sequential', tabCount: 1 };
  }
  return { mode: 'sequential', tabCount: 1 };
}

/**
 * DM送信ログのステータスをSupabase直接更新
 */
async function updateDMTaskStatus(taskId, status, error) {
  await loadAuth();
  if (!accessToken) {
    console.warn('[LS-BG] DMステータス更新スキップ: accessToken未設定 taskId=', taskId);
    return;
  }

  const body = { status };
  if (error) body.error = error;
  if (status === 'success') body.sent_at = new Date().toISOString();

  console.log('[LS-BG] DMステータス更新: taskId=', taskId, 'status=', status);

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log?id=eq.${taskId}`, {
      method: 'PATCH',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[LS-BG] DMステータス更新失敗: HTTP', res.status, errText, 'taskId=', taskId, 'status=', status);

      // 401の場合はトークンリフレッシュしてリトライ
      if (res.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          console.log('[LS-BG] DMステータス更新リトライ: taskId=', taskId);
          const retryRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log?id=eq.${taskId}`, {
            method: 'PATCH',
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify(body),
          });
          if (retryRes.ok) {
            console.log('[LS-BG] DMステータス更新成功(リトライ): taskId=', taskId, 'status=', status);
          } else {
            console.error('[LS-BG] DMステータス更新リトライ失敗:', retryRes.status);
          }
        }
      }
    } else {
      console.log('[LS-BG] DMステータス更新成功: taskId=', taskId, 'status=', status);
    }
  } catch (err) {
    console.error('[LS-BG] DMステータス更新例外:', err.message, 'taskId=', taskId);
  }
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
 * dm_executor.js からの結果を待つ（Map管理、複数タブ同時対応）
 * タイムアウトはDM_SEND_RESULT受信時にクリアされる
 */
function waitForDMResult(taskId, timeout = 15000) {
  return new Promise((resolve) => {
    // 既存のエントリがあればクリア
    const existing = pendingDMResults.get(taskId);
    if (existing) clearTimeout(existing.timeoutId);

    const timeoutId = setTimeout(() => {
      if (pendingDMResults.has(taskId)) {
        console.warn('[LS-BG] DM結果タイムアウト: taskId=', taskId, timeout + 'ms経過');
        pendingDMResults.delete(taskId);
        resolve({ success: false, error: `タイムアウト (${timeout / 1000}秒)` });
      }
    }, timeout);

    pendingDMResults.set(taskId, { resolve, timeoutId });
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

    // ページロード後の描画安定待ち（dm_executor側でもwaitForElementで待機する）
    await sleep_bg(1500);

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
 * DMキューを順次処理（1件ずつ取得→処理→次へ）
 */
async function processSequentialDMQueue() {
  try {
    while (true) {
      const task = await fetchNextDMTask();
      if (!task) break;

      await processSingleDMTask(task);

      const delay = 2000 + Math.random() * 2000;
      console.log('[LS-BG] DM次タスクまで', Math.round(delay / 1000), '秒待機');
      await sleep_bg(delay);
    }
  } catch (e) {
    console.warn('[LS-BG] DMキュー処理エラー:', e.message);
  }
}

// ============================================================
// Pipeline DM Mode — ステージずらし方式（Morning Hook CRM準拠）
//
// 同時にStripchatにリクエストを送るのは最大1タブ。
// ページ遷移（URLの変更）は1タブずつ、最低2秒間隔。
// DM操作（PMボタン→入力→送信）は並行OK。
//
// 時間 →
// タブ1: [ページ読込] → [PM→入力→送信] → [次ページ読込] → ...
// タブ2:              → [ページ読込]     → [PM→入力→送信] → ...
// タブ3:                                → [ページ読込]     → ...
// ============================================================

// --- Navigation Lock: ページ遷移を1タブずつ制御 ---
let navLockBusy = false;
let lastNavTime = 0;
const NAV_MIN_INTERVAL = 2000; // ページ遷移の最低間隔（Bot検知回避）

async function acquireNavLock() {
  // 他のタブが遷移中なら待つ
  while (navLockBusy) {
    await sleep_bg(300);
  }
  navLockBusy = true;

  // 前回の遷移から最低2秒空ける
  const elapsed = Date.now() - lastNavTime;
  if (elapsed < NAV_MIN_INTERVAL) {
    await sleep_bg(NAV_MIN_INTERVAL - elapsed);
  }
}

function releaseNavLock() {
  lastNavTime = Date.now();
  navLockBusy = false;
}

/**
 * パイプライン タブワーカー:
 * 共有キューからタスクを取り出し処理。ページ遷移はロックで1つずつ制御、
 * DM操作（PMボタン→入力→送信）はロック解放後に並行実行。
 */
async function pipelineTabWorker(tabId, queue, workerIdx) {
  console.log('[LS-BG] Pipeline Worker', workerIdx, '開始 tab=', tabId);

  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) break;

    console.log('[LS-BG] Pipeline W', workerIdx, ': id=', task.id, 'user=', task.user_name);

    // === Stage 1: ページ遷移（ナビロック: 同時遷移は1タブまで） ===
    let navOk = false;
    await acquireNavLock();
    try {
      const profileUrl = task.profile_url
        || `https://stripchat.com/user/${task.user_name}`;
      console.log('[LS-BG] Pipeline W', workerIdx, 'ナビ開始:', task.user_name);

      await updateDMTaskStatus(task.id, 'sending', null);
      await chrome.tabs.update(tabId, { url: profileUrl });

      const loaded = await waitForTabComplete(tabId, 15000);
      if (!loaded) throw new Error('ページロードタイムアウト');

      // DOM安定待ち（この間は他タブの遷移をブロック）
      await sleep_bg(1500);
      navOk = true;
    } catch (err) {
      console.error('[LS-BG] Pipeline W', workerIdx, 'ナビ失敗:', err.message);
      await updateDMTaskStatus(task.id, 'error', err.message);
    } finally {
      // ロック解放 → 次のタブがページ遷移を開始できる
      releaseNavLock();
      console.log('[LS-BG] Pipeline W', workerIdx, 'ナビロック解放');
    }

    if (!navOk) continue; // ナビ失敗 → 次のタスクへ

    // === Stage 2-4: PMボタン→入力→送信（ロック不要、並行可能） ===
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SEND_DM',
        taskId: task.id,
        username: task.user_name,
        message: task.message,
      });

      const result = await waitForDMResult(task.id, CONFIG.DM_SEND_TIMEOUT);

      if (result.success) {
        await updateDMTaskStatus(task.id, 'success', null);
        console.log('[LS-BG] Pipeline W', workerIdx, 'DM成功:', task.user_name);
      } else {
        await updateDMTaskStatus(task.id, 'error', result.error);
        console.warn('[LS-BG] Pipeline W', workerIdx, 'DM失敗:', task.user_name, result.error);
      }
    } catch (err) {
      console.error('[LS-BG] Pipeline W', workerIdx, 'DM例外:', err.message);
      await updateDMTaskStatus(task.id, 'error', err.message);
    }

    // 次のタスク前に短い待機
    if (queue.length > 0) {
      await sleep_bg(500);
    }
  }

  console.log('[LS-BG] Pipeline Worker', workerIdx, '完了');
}

/**
 * パイプラインDM処理メイン（ステージずらし方式）
 * 複数タブを使うが、ページ遷移は1タブずつ順番に行い、
 * DM操作は並行して実行する。
 */
async function processDMPipeline(tabCount) {
  const allTasks = await fetchDMBatch(50);
  if (allTasks.length === 0) return;

  const actualTabCount = Math.min(tabCount, allTasks.length, 5);
  console.log('[LS-BG] ========== パイプラインDM開始（ステージずらし） ==========');
  console.log('[LS-BG] タスク数:', allTasks.length, 'タブ数:', actualTabCount);

  // タブを作成（about:blankで待機）
  const tabIds = [];
  for (let i = 0; i < actualTabCount; i++) {
    try {
      const tab = await chrome.tabs.create({
        url: 'about:blank',
        active: false,
      });
      tabIds.push(tab.id);
      console.log('[LS-BG] Pipeline タブ作成:', tab.id, '(', i + 1, '/', actualTabCount, ')');
    } catch (err) {
      console.warn('[LS-BG] Pipeline タブ作成失敗:', err.message);
    }
  }

  if (tabIds.length === 0) {
    console.error('[LS-BG] Pipeline: タブが1つも作成できませんでした');
    return;
  }

  // ナビロック状態をリセット
  navLockBusy = false;
  lastNavTime = 0;

  // 共有キュー — 各ワーカーが.shift()で取り出す
  const queue = [...allTasks];

  // 全タブワーカーを並列起動（ただしページ遷移はナビロックで制御）
  await Promise.all(
    tabIds.map((tabId, idx) => pipelineTabWorker(tabId, queue, idx))
  );

  // タブをクリーンアップ
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      // タブが既に閉じられている場合
    }
  }

  console.log('[LS-BG] ========== パイプラインDM完了 ==========');
}

/**
 * DMキュー処理メイン — モード自動判定
 * campaignフィールドから送信モード（sequential/pipeline）を検出して処理を振り分け
 */
async function processDMQueue() {
  if (dmProcessing) return;
  dmProcessing = true;

  try {
    // 最初の1件を見てモードを判定
    const peekTask = await fetchNextDMTask();
    if (!peekTask) return;

    // Safety: userInitiatedチェック — campaign接頭辞が正規UIフロー経由であることを確認
    // フロントエンドの3段階確認を経たDMのみ処理（pipe{N}_ または seq_ 接頭辞が必須）
    if (!peekTask.campaign || (!peekTask.campaign.startsWith('pipe') && !peekTask.campaign.startsWith('seq'))) {
      console.warn('[LS-BG] DM安全ブロック: 不正なcampaign形式 — UI経由でない可能性 campaign=', peekTask.campaign, 'id=', peekTask.id);
      await updateDMTaskStatus(peekTask.id, 'error', 'DM安全ブロック: 正規UIフロー以外からのDM送信は拒否されました');
      return;
    }

    const config = parseBatchConfig(peekTask.campaign);

    if (config.mode === 'pipeline' && config.tabCount > 1) {
      console.log('[LS-BG] DMモード: パイプライン (', config.tabCount, 'タブ)');
      // peekTaskをqueuedに戻す（fetchDMBatchで再取得するため）
      await updateDMTaskStatus(peekTask.id, 'queued', null);
      await processDMPipeline(config.tabCount);
    } else {
      console.log('[LS-BG] DMモード: 順次');
      // peekTaskは既に取得済みなので直接処理
      await processSingleDMTask(peekTask);
      // 残りも順次処理
      await processSequentialDMQueue();
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
  // 起動時にバッジ更新
  updateBadge();
  loadAuth().then(async () => {
    console.log('[LS-BG] 認証状態: token=', !!accessToken, 'account=', accountId, 'spy=', spyEnabled);
    if (accessToken && accountId) {
      startDMPolling();
      startWhisperPolling();
      loadRegisteredCasts();
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
            loadRegisteredCasts();
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
        loadRegisteredCasts();
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
    updateBadge();
    console.log('[LS-BG] spy_enabled変更:', spyEnabled);
  }
  if (changes.stt_enabled) {
    sttEnabled = changes.stt_enabled.newValue === true;
    console.log('[LS-BG] stt_enabled変更:', sttEnabled);
  }
});
