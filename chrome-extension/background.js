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
let currentSessionId = null; // SPYセッションID（spy_messages.session_id）

// UUID v4 フォーマット検証（session_id の stale値検出用）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let messageBuffer = [];
let bufferTimer = null;
let spyMsgCount = 0;
let viewerStatsBuffer = [];
let viewerStatsTimer = null;
let whisperPollingTimer = null;
let dmProcessing = false;
const pendingDMResults = new Map(); // taskId → { resolve, timeoutId }
const successfulTaskIds = new Set(); // タイムアウト後の成功上書き防止用

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

// Per-cast session tracking (C-1: Session Auto-Creation)
const castSessions = new Map();      // cast_name → session_id
const castLastActivity = new Map();  // cast_name → timestamp (ms)
const castBroadcastTitles = new Map(); // cast_name → broadcast_title
const castSessionStarted = new Map(); // cast_name → ISO string (session start time)

// Persist session state across Service Worker restarts
async function saveSessionState() {
  try {
    const sessions = Object.fromEntries(castSessions);
    const activity = Object.fromEntries(castLastActivity);
    const started = Object.fromEntries(castSessionStarted);
    await chrome.storage.local.set({
      _castSessions: sessions,
      _castLastActivity: activity,
      _castSessionStarted: started,
    });
    console.log('[LS-BG] セッション状態保存:', castSessions.size, '件');
  } catch (e) {
    console.warn('[LS-BG] セッション状態保存失敗:', e.message);
  }
}

async function restoreSessionState() {
  try {
    const { _castSessions, _castLastActivity, _castSessionStarted } = await chrome.storage.local.get([
      '_castSessions', '_castLastActivity', '_castSessionStarted',
    ]);
    if (_castSessions) {
      for (const [k, v] of Object.entries(_castSessions)) castSessions.set(k, v);
    }
    if (_castLastActivity) {
      for (const [k, v] of Object.entries(_castLastActivity)) castLastActivity.set(k, v);
    }
    if (_castSessionStarted) {
      for (const [k, v] of Object.entries(_castSessionStarted)) castSessionStarted.set(k, v);
    }
    console.log('[LS-BG] セッション状態復元:', castSessions.size, '件');
  } catch (e) {
    console.warn('[LS-BG] セッション状態復元失敗:', e.message);
  }
}

// CHAT_MESSAGE高頻度呼び出し対策: 30秒デバウンスでセッション状態を永続化
let _sessionStateSaveTimer = null;
function scheduleSessionStateSave() {
  if (_sessionStateSaveTimer) return; // 既にスケジュール済み
  _sessionStateSaveTimer = setTimeout(() => {
    _sessionStateSaveTimer = null;
    saveSessionState();
  }, 30000); // 30秒後に保存
}

// AutoCoinSync 状態管理
let isCoinSyncing = false;
let coinSyncRetryCount = 0;
const COIN_SYNC_MAX_RETRIES = 3;
const COIN_SYNC_RETRY_DELAY_MS = 30 * 60 * 1000; // 30分

// SPY自動巡回 状態管理
let autoPatrolEnabled = false;          // 自動巡回ON/OFF（storage: auto_patrol_enabled）
let monitoredCastStatus = {};           // { castName: 'public'|'offline'|... } — 前回ステータス
let autoPatrolTabs = {};                // { castName: tabId } — 自動オープンしたタブの追跡

// SPY他社ローテーション 状態管理
let spyRotationEnabled = false;         // 他社ローテーションON/OFF（storage: spy_rotation_enabled）
let spyRotationTabs = {};               // { castName: tabId } — ローテーションで開いたタブ
let ownCastNamesCache = new Set();      // registered_castsのみ（自社キャスト保護用）
let spyCastNamesCache = new Set();      // spy_castsのみ（ローテーション対象）
const MAX_SPY_ROTATION_TABS = 10;       // 同時オープンタブ上限

// スクリーンショット間隔キャッシュ: { castName: intervalMinutes } — 0=OFF
let screenshotIntervalCache = {};
let screenshotLastCapture = {};         // { castName: timestamp(ms) } — 前回撮影時刻

// ============================================================
// A.1: Service Worker Keepalive via chrome.alarms
// ============================================================
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('coinSyncPeriodic', { periodInMinutes: 360 }); // 6時間ごと
chrome.alarms.create('spyAutoPatrol', { periodInMinutes: 3 });      // 3分ごとに配信開始検出
chrome.alarms.create('check-extinct-casts', { periodInMinutes: 1440 }); // 24時間ごと（消滅キャスト検出）
chrome.alarms.create('spyRotation', { periodInMinutes: 3 });          // 3分ごと（他社SPYローテーション）

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    flushMessageBuffer();
    flushViewerStats();
    checkHeartbeatTimeout();
    cleanupStaleSTTTabs();
    checkBroadcastEnd(); // C-2: 配信終了検出（5分タイムアウト）
    // DMスケジュールポーリング（30秒ごとにpending+期限到来をチェック）
    checkDmSchedules().catch(e => {
      console.warn('[LS-BG] DMスケジュールチェック失敗:', e.message);
    });
  }

  // 定期コイン同期（6時間ごと）
  if (alarm.name === 'coinSyncPeriodic') {
    console.log('[LS-BG] AutoCoinSync: 定期同期アラーム発火');
    triggerAutoCoinSync('periodic').catch(e => {
      console.warn('[LS-BG] AutoCoinSync: 定期同期失敗:', e.message);
    });
  }

  // コイン同期リトライ
  if (alarm.name === 'coinSyncRetry') {
    console.log('[LS-BG] AutoCoinSync: リトライ発火 (', coinSyncRetryCount, '/', COIN_SYNC_MAX_RETRIES, ')');
    triggerAutoCoinSync('retry').catch(e => {
      console.warn('[LS-BG] AutoCoinSync: リトライ失敗:', e.message);
    });
  }

  // 配信終了後5分ディレイのコイン同期
  if (alarm.name === 'coinSyncAfterStream') {
    console.log('[LS-BG] AutoCoinSync: 配信終了後同期発火');
    triggerAutoCoinSync('after_stream').catch(e => {
      console.warn('[LS-BG] AutoCoinSync: 配信終了後同期失敗:', e.message);
    });
  }

  // SPY自動巡回（3分ごと）
  if (alarm.name === 'spyAutoPatrol') {
    runAutoPatrol().catch(e => {
      console.warn('[LS-BG] AutoPatrol: 巡回エラー:', e.message);
    });
  }

  // chrome.alarmsベースのDMスケジュール発火（フォールバック）
  if (alarm.name.startsWith('dm_schedule_')) {
    const scheduleId = alarm.name.replace('dm_schedule_', '');
    console.log('[LS-BG] DMスケジュールアラーム発火:', scheduleId);
    executeDmSchedule(scheduleId).catch(e => {
      console.error('[LS-BG] DMスケジュール実行失敗:', e.message);
    });
  }

  // Task K: 消滅キャスト検出（24時間ごと）
  if (alarm.name === 'check-extinct-casts') {
    checkExtinctCasts().catch(e => {
      console.warn('[LS-BG] ExtinctCasts: チェック失敗:', e.message);
    });
  }

  // 他社SPYローテーション（3分ごと）
  if (alarm.name === 'spyRotation') {
    handleSpyRotation().catch(e => {
      console.warn('[LS-BG] SpyRotation: エラー:', e.message);
    });
  }

  // スクリーンショット（5分ごと）
  if (alarm.name === 'spy-screenshot') {
    captureAllSpyTabs().catch(e => {
      console.warn('[LS-BG] Screenshot: キャプチャ失敗:', e.message);
    });
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

// タブが閉じられたらSTT状態 + autoPatrolタブをクリーンアップ
chrome.tabs.onRemoved.addListener((tabId) => {
  if (sttTabStates[tabId]) {
    console.log('[LS-BG] STTタブ削除（closed）: tab=', tabId, 'cast=', sttTabStates[tabId].castName);
    delete sttTabStates[tabId];
  }
  // autoPatrolで開いたタブが閉じられた場合はトラッキングを解除
  for (const [castName, tid] of Object.entries(autoPatrolTabs)) {
    if (tid === tabId) {
      console.log('[LS-BG] AutoPatrol: タブ閉鎖検出 cast=', castName, 'tab=', tabId);
      delete autoPatrolTabs[castName];
      break;
    }
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
    'access_token', 'account_id', 'api_base_url', 'spy_enabled', 'stt_enabled', 'current_session_id',
  ]);
  accessToken = data.access_token || null;
  accountId = data.account_id || null;
  spyEnabled = data.spy_enabled === true;
  sttEnabled = data.stt_enabled === true;
  currentSessionId = data.current_session_id || null;
  // Bug fix: storageに残った旧形式session_id（spy_YYYYMMDD_...）をUUID v4に置換
  if (currentSessionId && !UUID_RE.test(currentSessionId)) {
    console.warn('[LS-BG] 旧形式session_id検出 → UUID再生成:', currentSessionId);
    currentSessionId = crypto.randomUUID();
    chrome.storage.local.set({ current_session_id: currentSessionId });
  }
  if (data.api_base_url) {
    CONFIG.API_BASE_URL = data.api_base_url;
  }
  return { accessToken, accountId, spyEnabled, sttEnabled };
}

/**
 * 自社キャスト名をSupabaseから取得してキャッシュ（STTフィルタ用）
 * リトライ1回付き（ネットワーク一時障害対策）
 */
async function loadRegisteredCasts() {
  if (!accessToken || !accountId) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // registered_casts（自社）+ spy_casts（他社分析）の両方を取得
      const [regRes, spyRes] = await Promise.all([
        fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&is_active=eq.true&select=cast_name,screenshot_interval`,
          {
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        ),
        fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/spy_casts?account_id=eq.${accountId}&is_active=eq.true&select=cast_name,screenshot_interval`,
          {
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        ),
      ]);
      if (regRes.ok) {
        const regData = await regRes.json();
        const spyData = spyRes.ok ? await spyRes.json() : [];
        ownCastNamesCache = new Set(regData.map(r => r.cast_name));
        spyCastNamesCache = new Set(spyData.map(r => r.cast_name));
        registeredCastNames = new Set([
          ...regData.map(r => r.cast_name),
          ...spyData.map(r => r.cast_name),
        ]);
        // スクリーンショット間隔キャッシュ更新
        const newIntervals = {};
        for (const r of regData) newIntervals[r.cast_name] = r.screenshot_interval ?? 5;
        for (const r of spyData) newIntervals[r.cast_name] = r.screenshot_interval ?? 0;
        screenshotIntervalCache = newIntervals;
        console.log('[LS-BG] キャスト名キャッシュ更新 (自社+SPY):', [...registeredCastNames]);
        return;
      }
      console.warn('[LS-BG] キャスト名取得 HTTP', regRes.status, '(attempt', attempt, ')');
    } catch (err) {
      console.warn('[LS-BG] キャスト名取得失敗 (attempt', attempt, '):', err.message);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
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

// Tip safety net — ゴール系メッセージの誤分類を防止
function validateTipBeforeSave(data) {
  // 1. Empty user_name tips are forbidden
  if (data.msg_type === 'tip' && (!data.user_name || data.user_name.trim() === '')) {
    console.warn('[LS-BG] チップ拒否: user_name空', (data.message || '').substring(0, 50));
    data.msg_type = 'system';
    data.tokens = 0;
    return data;
  }

  // 2. Goal keywords in tip messages are forbidden
  const goalPatterns = [/ゴール/, /goal/i, /エピック/, /epic/i, /達成/, /残り.*コイン/, /新しいゴール/, /new goal/i];
  if (data.msg_type === 'tip' && goalPatterns.some(p => p.test(data.message || ''))) {
    console.warn('[LS-BG] チップ拒否: ゴール系メッセージ', (data.message || '').substring(0, 50));
    data.msg_type = 'goal';
    data.tokens = 0;
    return data;
  }

  // 3. Log high-value tips (warning only)
  if (data.msg_type === 'tip' && data.tokens >= 5000) {
    console.warn('[LS-BG] 高額チップ検出:', data.user_name, data.tokens, 'tk');
  }

  return data;
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

  // Bug fix: バッファ内の旧形式session_idも検証・置換
  if (currentSessionId && !UUID_RE.test(currentSessionId)) {
    console.warn('[LS-BG] flushMessageBuffer: 旧形式session_id検出 → UUID再生成:', currentSessionId);
    currentSessionId = crypto.randomUUID();
    chrome.storage.local.set({ current_session_id: currentSessionId });
  }

  // Supabase REST API用の行データを作成（一括INSERT）
  // Final safety: tip classification correction before INSERT
  const rows = deduplicated.map(msg => {
    // バッファ内の各メッセージのsession_idも検証（push時に旧形式が付与された可能性）
    let sid = msg.session_id || null;
    if (sid && !UUID_RE.test(sid)) {
      sid = currentSessionId || null; // 現在の正しいsession_idで上書き
    }

    let msgType = msg.msg_type || 'chat';
    let tokens = msg.tokens || 0;
    const userName = msg.user_name || '';
    const message = msg.message || '';

    // Safety: reject tips without user_name
    if (msgType === 'tip' && !userName.trim()) {
      console.warn('[LS-BG] flush安全弁: tip→system (user_name空)', message.substring(0, 50));
      msgType = 'system';
      tokens = 0;
    }
    // Safety: reject goal messages classified as tips
    const goalPatterns = [/ゴール/, /goal/i, /エピック/, /達成/, /残り.*コイン/];
    if (msgType === 'tip' && goalPatterns.some(p => p.test(message))) {
      console.warn('[LS-BG] flush安全弁: tip→goal (ゴール系)', message.substring(0, 50));
      msgType = 'goal';
      tokens = 0;
    }

    return {
      account_id: accountId,
      cast_name: msg.cast_name || '',
      message_time: msg.message_time || new Date().toISOString(),
      msg_type: msgType,
      user_name: userName,
      message: message,
      tokens: tokens,
      is_vip: false,
      user_color: msg.user_color || null,
      user_league: msg.user_league || null,
      user_level: msg.user_level != null ? msg.user_level : null,
      metadata: msg.metadata || {},
      session_id: sid,
    };
  });

  const hasSessionId = rows.some(r => r.session_id);
  console.log('[LS-BG] SPYメッセージ一括送信:', rows.length, '件 → Supabase REST API', `session_id: ${hasSessionId ? rows[0].session_id : 'NULL'}`);

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
      // 視聴者パネル内訳（029_viewer_stats_breakdown で追加されたカラム）
      ...(s.ultimate_count != null ? { ultimate_count: s.ultimate_count } : {}),
      ...(s.coin_holders != null ? { coin_holders: s.coin_holders } : {}),
      ...(s.others_count != null ? { others_count: s.others_count } : {}),
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
// Session Lifecycle → Supabase REST API
// ============================================================

/**
 * SPY開始時: sessionsテーブルにセッション開始を記録
 * title カラムに cast_name を格納（sessions に cast_name カラムなし）
 */
async function insertSession(sessionId, acctId) {
  if (!accessToken) return;

  const storageData = await chrome.storage.local.get(['last_cast_name']);
  const castName = storageData.last_cast_name || 'unknown';

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/sessions`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        session_id: sessionId,
        account_id: acctId,
        title: castName,
        cast_name: castName,
        started_at: new Date().toISOString(),
      }),
    });

    if (res.ok || res.status === 201) {
      console.log('[LS-BG] sessions開始記録:', sessionId, 'cast=', castName);
    } else {
      const errText = await res.text();
      console.error('[LS-BG] sessions INSERT失敗:', res.status, errText);
    }
  } catch (e) {
    console.error('[LS-BG] sessions INSERT例外:', e.message);
  }
}

/**
 * SPY停止時: sessionsテーブルにセッション終了を記録（集計値付き）
 * 1. RPC update_session_stats → total_messages, total_tokens
 * 2. viewer_stats → peak_viewers
 * 3. PATCH sessions → ended_at, peak_viewers
 */
async function closeSession(sessionId, sessionStartTime) {
  if (!accessToken || !accountId) return;

  // 1. RPC update_session_stats で total_messages, total_tokens を更新
  try {
    const rpcRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/update_session_stats`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_session_id: sessionId }),
    });
    if (rpcRes.ok) {
      console.log('[LS-BG] update_session_stats RPC成功:', sessionId);
    } else {
      console.warn('[LS-BG] update_session_stats RPC失敗:', rpcRes.status);
    }
  } catch (e) {
    console.warn('[LS-BG] update_session_stats RPC例外:', e.message);
  }

  // 2. viewer_statsからピーク視聴者数を取得
  let peakViewers = 0;
  if (sessionStartTime) {
    try {
      const viewerRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/viewer_stats?account_id=eq.${accountId}&recorded_at=gte.${encodeURIComponent(sessionStartTime)}&order=total.desc&limit=1&select=total`,
        {
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );
      if (viewerRes.ok) {
        const viewerData = await viewerRes.json();
        if (viewerData.length > 0 && viewerData[0].total != null) {
          peakViewers = viewerData[0].total;
        }
      }
    } catch (e) {
      console.warn('[LS-BG] viewer_stats取得スキップ:', e.message);
    }
  }

  // 3. ended_at + peak_viewers を更新
  try {
    const updateRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/sessions?session_id=eq.${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          ended_at: new Date().toISOString(),
          peak_viewers: peakViewers,
        }),
      }
    );

    if (updateRes.ok) {
      console.log(`[LS-BG] sessions終了記録: ${sessionId} | peak_viewers=${peakViewers}`);
    } else {
      const errText = await updateRes.text();
      console.error('[LS-BG] sessions UPDATE失敗:', updateRes.status, errText);
    }
  } catch (e) {
    console.error('[LS-BG] sessions UPDATE例外:', e.message);
  }
}

// ============================================================
// C-1: Per-cast Session Auto-Creation
// ============================================================

/**
 * キャストの配信セッションを自動作成/取得
 * CHAT_MESSAGE受信時に呼び出し、キャストごとにセッションを管理
 */
async function ensureSession(castName, acctId) {
  if (castSessions.has(castName)) return castSessions.get(castName);
  if (!accessToken || !acctId) return null;

  const sessionId = crypto.randomUUID();
  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/sessions`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        session_id: sessionId,
        account_id: acctId,
        cast_name: castName,
        title: castName,
        started_at: new Date().toISOString(),
      }),
    });
    if (res.ok || res.status === 201) {
      castSessions.set(castName, sessionId);
      castSessionStarted.set(castName, new Date().toISOString());
      saveSessionState(); // SW再起動対策: 状態永続化
      console.log('[LS-BG] 新セッション作成:', castName, '→', sessionId);
    } else {
      const errText = await res.text();
      console.warn('[LS-BG] セッション作成失敗:', res.status, errText);
    }
  } catch (e) {
    console.warn('[LS-BG] セッション作成例外:', e.message);
  }
  return castSessions.get(castName) || null;
}

/**
 * C-2: キャストの配信セッションを終了（5分タイムアウト時）
 */
async function closeCastSession(castName) {
  const sessionId = castSessions.get(castName);
  if (!sessionId) return;

  const sessionStarted = castSessionStarted.get(castName) || null;

  // RPC update_session_stats で集計
  try {
    const rpcRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/update_session_stats`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_session_id: sessionId }),
    });
    if (rpcRes.ok) {
      console.log('[LS-BG] closeCastSession update_session_stats成功:', sessionId);
    } else {
      console.warn('[LS-BG] closeCastSession update_session_stats失敗:', rpcRes.status);
    }
  } catch (e) {
    console.warn('[LS-BG] closeCastSession RPC例外:', e.message);
  }

  // ended_at を更新
  try {
    await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/sessions?session_id=eq.${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ended_at: new Date().toISOString(),
      }),
    });
    console.log('[LS-BG] セッション終了:', castName, sessionId);
  } catch (e) {
    console.warn('[LS-BG] セッション終了失敗:', e.message);
  }

  // C-3: チケットショー検出（セッション終了時にsession_idでtip/giftメッセージを集計）
  if (sessionId && accessToken) {
    try {
      const tipRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/spy_messages?session_id=eq.${encodeURIComponent(sessionId)}&msg_type=in.(tip,gift)&tokens=gt.0&order=message_time.asc&limit=2000`,
        {
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );
      if (tipRes.ok) {
        const tips = await tipRes.json();
        const ticketShows = detectTicketShowsSimple(tips);
        if (ticketShows.length > 0) {
          const totalTicketRevenue = ticketShows.reduce((s, sh) => s + sh.ticket_revenue, 0);
          const totalTipRevenue = ticketShows.reduce((s, sh) => s + sh.tip_revenue, 0);
          const totalAttendees = ticketShows.reduce((s, sh) => s + sh.attendees, 0);
          await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/sessions?session_id=eq.${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              ticket_shows: ticketShows,
              total_ticket_revenue: totalTicketRevenue,
              total_tip_revenue: totalTipRevenue,
              total_ticket_attendees: totalAttendees,
            }),
          });
          console.log('[LS-BG] チケチャ検出:', castName, ticketShows.length, '回, 参加者計:', totalAttendees, 'tk計:', totalTicketRevenue);
        }
      }
    } catch (e) {
      console.warn('[LS-BG] チケチャ検出失敗:', e.message);
    }
  }

  // お礼DM自動トリガー（セッション終了時 — fire-and-forget）
  triggerThankYouDMs(castName, sessionId).catch(e => {
    console.warn('[LS-BG] お礼DMトリガー失敗:', e.message);
  });

  castSessions.delete(castName);
  castLastActivity.delete(castName);
  castBroadcastTitles.delete(castName);
  castSessionStarted.delete(castName);
  saveSessionState(); // SW再起動対策: 状態永続化
}

/**
 * お礼DM自動トリガー: セッション終了時にtip/giftユーザーにDMを自動キュー登録
 * get_thankyou_dm_candidates RPCで候補取得 → dm_send_logにINSERT (status='pending')
 * 二重送信防止: 24時間以内に同一ユーザーへ auto_thankyou DM済みならスキップ
 */
async function triggerThankYouDMs(castName, sessionId) {
  try {
    await loadAuth();
    if (!accountId || !accessToken) return;

    // 自社キャストのみ（spy_castsは除外）
    if (ownCastNamesCache.size > 0 && !ownCastNamesCache.has(castName)) {
      console.log('[LS-BG] お礼DM: 自社キャストではないためスキップ:', castName);
      return;
    }

    // get_thankyou_dm_candidates RPC呼び出し
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/get_thankyou_dm_candidates`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_account_id: accountId,
        p_cast_name: castName,
        p_session_id: sessionId,
        p_min_tokens: 100,
      }),
    });

    if (!res.ok) {
      console.warn('[LS-BG] お礼DM: RPC失敗 HTTP', res.status);
      return;
    }

    const candidates = await res.json();
    if (!Array.isArray(candidates) || candidates.length === 0) {
      console.log('[LS-BG] お礼DM: 候補なし (cast:', castName, ')');
      return;
    }

    console.log('[LS-BG] お礼DM: 候補', candidates.length, '名 (cast:', castName, ')');

    // 二重送信防止: 24時間以内にauto_thankyou DMを送信済みのユーザーを除外
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const dupRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log?account_id=eq.${accountId}&template_name=eq.auto_thankyou&queued_at=gte.${encodeURIComponent(since24h)}&select=user_name`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );
    const alreadySent = new Set();
    if (dupRes.ok) {
      const dupData = await dupRes.json();
      (dupData || []).forEach(d => alreadySent.add(d.user_name));
    }

    // フィルタ: 二重送信防止 + dm_sent_this_session除外（RPCが既に除外しているが念のため）
    const filtered = candidates.filter(c =>
      !alreadySent.has(c.username) && !c.dm_sent_this_session
    );

    if (filtered.length === 0) {
      console.log('[LS-BG] お礼DM: 全員24h以内にDM済み — スキップ');
      return;
    }

    // dm_send_log にINSERT (status='pending' — フロントで承認後に'queued'に変更)
    const campaign = `auto_thankyou_${Date.now()}`;
    const rows = filtered.map(c => ({
      account_id: accountId,
      user_name: c.username,
      cast_name: castName,
      profile_url: `https://stripchat.com/user/${c.username}`,
      message: c.suggested_template || `${c.username}さん、今日はありがとう😊 また遊びに来てくださいね。`,
      status: 'pending',
      campaign: campaign,
      template_name: 'auto_thankyou',
      queued_at: new Date().toISOString(),
    }));

    const insertRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(rows),
    });

    if (insertRes.ok || insertRes.status === 201) {
      console.log('[LS-BG] お礼DM:', filtered.length, '件をキューに登録 (campaign:', campaign, ')');
    } else {
      console.warn('[LS-BG] お礼DM: INSERT失敗 HTTP', insertRes.status);
    }
  } catch (e) {
    console.warn('[LS-BG] お礼DM: エラー:', e.message);
  }
}

/**
 * 離脱DM自動トリガー: refresh_segments後に離脱リスクユーザーにDMを自動キュー登録
 * detect_churn_risk RPCで候補取得 → dm_send_logにINSERT (status='pending')
 * 二重送信防止: 7日以内に同一ユーザーへ auto_churn DM済みならスキップ
 */
async function triggerChurnRecoveryDMs() {
  try {
    await loadAuth();
    if (!accountId || !accessToken) return;

    // 自社キャストのみ対象
    if (ownCastNamesCache.size === 0) {
      console.log('[LS-BG] 離脱DM: 自社キャスト未キャッシュ — スキップ');
      return;
    }

    // 7日以内のauto_churn DM送信済みユーザーを一括取得（全キャスト共通）
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const globalDupRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log?account_id=eq.${accountId}&template_name=eq.auto_churn&queued_at=gte.${encodeURIComponent(since7d)}&select=user_name`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );
    const globalAlreadySent = new Set();
    if (globalDupRes.ok) {
      const dupData = await globalDupRes.json();
      (dupData || []).forEach(d => globalAlreadySent.add(d.user_name));
    }

    let totalQueued = 0;
    const campaign = `auto_churn_${Date.now()}`;
    const churnTemplate = '{username}さん、最近見かけないので気になっちゃって😊\n元気にしてますか？\nまた気が向いたらふらっと来てくれたら嬉しいです。\nでも無理しないでね、あなたの自由だから😊';

    for (const castName of ownCastNamesCache) {
      const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/detect_churn_risk`, {
        method: 'POST',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_account_id: accountId,
          p_cast_name: castName,
          p_lookback_sessions: 7,
          p_absence_threshold: 2,
        }),
      });

      if (!res.ok) {
        console.warn('[LS-BG] 離脱DM: detect_churn_risk失敗 (', castName, ') HTTP', res.status);
        continue;
      }

      const candidates = await res.json();
      if (!Array.isArray(candidates) || candidates.length === 0) continue;

      // 二重送信防止
      const filtered = candidates.filter(c => !globalAlreadySent.has(c.username));
      if (filtered.length === 0) continue;

      const rows = filtered.map(c => ({
        account_id: accountId,
        user_name: c.username,
        cast_name: castName,
        profile_url: `https://stripchat.com/user/${c.username}`,
        message: churnTemplate.replace('{username}', c.username),
        status: 'pending',
        campaign: campaign,
        template_name: 'auto_churn',
        queued_at: new Date().toISOString(),
      }));

      const insertRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`, {
        method: 'POST',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(rows),
      });

      if (insertRes.ok || insertRes.status === 201) {
        totalQueued += filtered.length;
        // 送信済みセットに追加（次のキャストで重複しないように）
        filtered.forEach(c => globalAlreadySent.add(c.username));
      } else {
        console.warn('[LS-BG] 離脱DM: INSERT失敗 (', castName, ') HTTP', insertRes.status);
      }
    }

    if (totalQueued > 0) {
      console.log('[LS-BG] 離脱DM:', totalQueued, '件をキューに登録 (campaign:', campaign, ')');
    } else {
      console.log('[LS-BG] 離脱DM: 候補なし');
    }
  } catch (e) {
    console.warn('[LS-BG] 離脱DM: エラー:', e.message);
  }
}

/**
 * C-3: チケットショー検出（簡易版）
 * 3件以上の同額チップが30秒以内に集中 → チケットショーと判定
 */
function detectTicketShowsSimple(tips) {
  if (!tips || tips.length < 3) return [];
  const shows = [];
  let i = 0;
  while (i < tips.length) {
    const amount = tips[i].tokens;
    const windowStart = new Date(tips[i].message_time).getTime();
    let cluster = [tips[i]];
    let j = i + 1;
    while (j < tips.length && tips[j].tokens === amount && new Date(tips[j].message_time).getTime() - windowStart <= 30000) {
      cluster.push(tips[j]);
      j++;
    }
    if (cluster.length >= 3) {
      // Extend: collect same-amount tips with 60s gaps
      while (j < tips.length && tips[j].tokens === amount) {
        const gap = new Date(tips[j].message_time).getTime() - new Date(cluster[cluster.length - 1].message_time).getTime();
        if (gap <= 60000) { cluster.push(tips[j]); j++; } else break;
      }
      // Collect non-ticket tips during show period
      const showStart = new Date(cluster[0].message_time).getTime();
      const showEnd = new Date(cluster[cluster.length - 1].message_time).getTime();
      let tipRevenue = 0;
      for (const t of tips) {
        const tt = new Date(t.message_time).getTime();
        if (tt >= showStart && tt <= showEnd && t.tokens !== amount) {
          tipRevenue += t.tokens;
        }
      }
      shows.push({
        started_at: cluster[0].message_time,
        ended_at: cluster[cluster.length - 1].message_time,
        ticket_price: amount,
        ticket_revenue: cluster.length * amount,
        attendees: cluster.length,
        tip_revenue: tipRevenue,
      });
      i = j;
    } else {
      i++;
    }
  }
  return shows;
}

/**
 * C-2: 配信終了検出（5分タイムアウト）
 * keepalive アラーム(30秒ごと)から呼び出し
 */
function checkBroadcastEnd() {
  if (!spyEnabled) return;
  const now = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000; // 5分

  for (const [castName, lastTime] of castLastActivity.entries()) {
    if (now - lastTime > TIMEOUT_MS && castSessions.has(castName)) {
      console.log('[LS-BG] 配信終了検出(5分タイムアウト):', castName);
      closeCastSession(castName).catch(e => {
        console.warn('[LS-BG] closeCastSession失敗:', castName, e.message);
      });
    }
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

    // 未登録キャストのデータは収集しない（registered_casts + spy_casts のみ許可）
    const castName = msg.cast_name || '';
    if (registeredCastNames.size > 0 && castName && !registeredCastNames.has(castName)) {
      console.log('[LS-BG] 未登録キャスト スキップ: cast=', castName);
      sendResponse({ ok: false, error: '未登録キャスト' });
      return false;
    }

    // C-1: Per-cast session auto-creation + C-2: activity tracking
    if (castName) {
      castLastActivity.set(castName, Date.now());
      // SW再起動対策: activity更新を定期的に永続化（30秒デバウンス）
      scheduleSessionStateSave();
      // fire-and-forget: セッション自動作成（accountId不在時は次回flush時にリトライ）
      if (accountId) {
        ensureSession(castName, accountId).catch(e => {
          console.warn('[LS-BG] ensureSession失敗:', e.message);
        });
      }
    }

    // session_id: per-cast session優先、fallback to global currentSessionId
    const perCastSessionId = castName ? (castSessions.get(castName) || null) : null;

    // account_id は含めない（flush時にstorageから最新値を付与）
    const payload = {
      cast_name: msg.cast_name || '',
      message_time: msg.message_time || new Date().toISOString(),
      msg_type: msg.msg_type || 'chat',
      user_name: msg.user_name || '',
      message: msg.message || '',
      tokens: msg.tokens || 0,
      user_color: msg.user_color || null,
      user_league: msg.user_league || null,
      user_level: msg.user_level != null ? msg.user_level : null,
      metadata: msg.metadata || {},
      session_id: perCastSessionId || currentSessionId || null,
    };

    // Safety net: validate tip classification before buffering
    const validated = validateTipBeforeSave(payload);

    messageBuffer.push(validated);
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
    // 未登録キャストのviewer statsは収集しない
    const vsCastName = msg.cast_name || '';
    if (registeredCastNames.size > 0 && vsCastName && !registeredCastNames.has(vsCastName)) {
      console.log('[LS-BG] 未登録キャスト スキップ: cast=', vsCastName, '(viewer_stats)');
      sendResponse({ ok: false, error: '未登録キャスト' });
      return false;
    }

    // accountId不在でもバッファ（flush時に付与）
    viewerStatsBuffer.push({
      total: msg.total,
      coin_users: msg.coin_users,
      others: msg.others,
      ultimate_count: msg.ultimate_count ?? null,
      coin_holders: msg.coin_holders ?? null,
      others_count: msg.others_count ?? null,
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

  // --- M-3: Broadcast Title from content_spy.js ---
  if (msg.type === 'BROADCAST_TITLE') {
    const titleCastName = msg.cast_name || '';
    const broadcastTitle = msg.broadcast_title || '';
    if (titleCastName && broadcastTitle) {
      const prevTitle = castBroadcastTitles.get(titleCastName);
      if (prevTitle !== broadcastTitle) {
        castBroadcastTitles.set(titleCastName, broadcastTitle);
        console.log('[LS-BG] 配信タイトル更新:', titleCastName, '→', broadcastTitle);
        // セッションの broadcast_title を PATCH で更新
        const titleSessionId = castSessions.get(titleCastName);
        if (titleSessionId && accessToken) {
          fetch(`${CONFIG.SUPABASE_URL}/rest/v1/sessions?session_id=eq.${encodeURIComponent(titleSessionId)}`, {
            method: 'PATCH',
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ broadcast_title: broadcastTitle }),
          }).then(res => {
            if (res.ok) {
              console.log('[LS-BG] broadcast_title PATCH成功:', titleSessionId);
            } else {
              console.warn('[LS-BG] broadcast_title PATCH失敗:', res.status);
            }
          }).catch(e => {
            console.warn('[LS-BG] broadcast_title PATCH例外:', e.message);
          });
        }
      }
    }
    sendResponse({ ok: true });
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

  // --- Task B: CAST_PROFILE from content_spy.js ---
  if (msg.type === 'CAST_PROFILE') {
    loadAuth().then(async () => {
      if (!accessToken || !accountId) {
        console.warn('[LS-BG] CAST_PROFILE: 未認証 — スキップ');
        sendResponse({ ok: false, error: 'Not authenticated' });
        return;
      }
      const p = msg.profile || {};
      const row = {
        account_id: accountId,
        cast_name: msg.cast_name || '',
        age: p.age || null,
        origin: p.origin || null,
        body_type: p.body_type || null,
        details: p.details || null,
        ethnicity: p.ethnicity || null,
        hair_color: p.hair_color || null,
        eye_color: p.eye_color || null,
        bio: p.bio || null,
        followers_count: p.followers_count || null,
        tip_menu: p.tip_menu || null,
        epic_goal: p.epic_goal || null,
        profile_data: p.profile_data || {},
        fetched_at: new Date().toISOString(),
      };
      try {
        const res = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/cast_profiles?on_conflict=cast_name,account_id`,
          {
            method: 'POST',
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates',
            },
            body: JSON.stringify(row),
          }
        );
        if (res.ok || res.status === 201) {
          console.log('[LS-BG] CAST_PROFILE UPSERT成功:', msg.cast_name);
          sendResponse({ ok: true });
        } else {
          const errText = await res.text().catch(() => '');
          console.warn('[LS-BG] CAST_PROFILE UPSERT失敗:', res.status, errText);
          sendResponse({ ok: false, error: errText });
        }
      } catch (err) {
        console.warn('[LS-BG] CAST_PROFILE例外:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true; // async
  }

  // --- Task B: CAST_FEED from content_spy.js ---
  if (msg.type === 'CAST_FEED') {
    loadAuth().then(async () => {
      if (!accessToken || !accountId) {
        console.warn('[LS-BG] CAST_FEED: 未認証 — スキップ');
        sendResponse({ ok: false, error: 'Not authenticated' });
        return;
      }
      const posts = msg.posts || [];
      if (posts.length === 0) {
        sendResponse({ ok: true, inserted: 0 });
        return;
      }
      const rows = posts.map(p => ({
        account_id: accountId,
        cast_name: msg.cast_name || '',
        post_text: p.post_text || null,
        post_date: p.post_date || null,
        likes_count: p.likes_count || 0,
        has_image: p.has_image || false,
        fetched_at: new Date().toISOString(),
      }));
      try {
        const res = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/cast_feeds`,
          {
            method: 'POST',
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=ignore-duplicates,return=minimal',
            },
            body: JSON.stringify(rows),
          }
        );
        if (res.ok || res.status === 201) {
          console.log('[LS-BG] CAST_FEED INSERT成功:', msg.cast_name, rows.length, '件');
          sendResponse({ ok: true, inserted: rows.length });
        } else {
          const errText = await res.text().catch(() => '');
          console.warn('[LS-BG] CAST_FEED INSERT失敗:', res.status, errText);
          sendResponse({ ok: false, error: errText });
        }
      } catch (err) {
        console.warn('[LS-BG] CAST_FEED例外:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    });
    return true; // async
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
    // 成功したtaskIdを記録（タイムアウト発火時のerror上書き防止）
    if (msg.success) successfulTaskIds.add(msg.taskId);
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
        autoPatrolEnabled: autoPatrolEnabled,
        spyRotationEnabled: spyRotationEnabled,
        monitoredCasts: Object.entries(monitoredCastStatus).map(([name, st]) => ({ name, status: st })),
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

  // --- OPEN_ALL_SPY_TABS: 全SPY監視タブ一斉オープン ---
  if (msg.type === 'OPEN_ALL_SPY_TABS') {
    (async () => {
      try {
        // フロントエンドからキャスト一覧が渡された場合はそれを使う、なければDB取得
        let castNames;
        if (msg.castNames && Array.isArray(msg.castNames) && msg.castNames.length > 0) {
          castNames = msg.castNames;
        } else {
          await loadRegisteredCasts();
          castNames = [...registeredCastNames];
        }
        if (castNames.length === 0) {
          sendResponse({ ok: true, opened: 0, skipped: 0, total: 0, message: '登録キャストなし' });
          return;
        }

        // 既に開いているStripchatタブのキャスト名を取得
        const existingTabs = await chrome.tabs.query({ url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] });
        const openCasts = new Set();
        for (const tab of existingTabs) {
          if (!tab.url) continue;
          const m = tab.url.match(/stripchat\.com\/([A-Za-z0-9_-]+)/);
          if (m) openCasts.add(m[1]);
        }

        // 未オープンのキャストだけタブを開く
        const toOpen = castNames.filter(name => !openCasts.has(name));
        for (const castName of toOpen) {
          await chrome.tabs.create({
            url: `https://stripchat.com/${castName}`,
            active: false,
          });
          await sleep_bg(500); // ブラウザ負荷軽減
        }

        const result = { ok: true, opened: toOpen.length, skipped: castNames.length - toOpen.length, total: castNames.length };
        console.log('[LS-BG] OPEN_ALL_SPY_TABS:', result);
        sendResponse(result);
      } catch (err) {
        console.error('[LS-BG] OPEN_ALL_SPY_TABS失敗:', err.message);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async
  }

  // --- Frontend: DM Schedule 予約 ---
  if (msg.type === 'SCHEDULE_DM') {
    const { scheduleId, scheduledAt } = msg;
    const delayMs = new Date(scheduledAt).getTime() - Date.now();
    console.log('[LS-BG] SCHEDULE_DM受信: id=', scheduleId, 'at=', scheduledAt, 'delay=', delayMs, 'ms');

    if (delayMs <= 60000) {
      // 1分以内 → 即時実行
      executeDmSchedule(scheduleId).catch(e => {
        console.error('[LS-BG] DMスケジュール即時実行失敗:', e.message);
      });
    } else {
      // chrome.alarmsで予約（分単位、最低1分）
      const delayMinutes = Math.max(1, Math.ceil(delayMs / 60000));
      chrome.alarms.create(`dm_schedule_${scheduleId}`, { delayInMinutes: delayMinutes });
      console.log('[LS-BG] DMスケジュールアラーム設定:', delayMinutes, '分後');
    }
    sendResponse({ ok: true });
    return false;
  }

  // --- Frontend: DM Schedule キャンセル ---
  if (msg.type === 'CANCEL_DM_SCHEDULE') {
    const { scheduleId } = msg;
    chrome.alarms.clear(`dm_schedule_${scheduleId}`);
    console.log('[LS-BG] DMスケジュールアラーム解除:', scheduleId);
    sendResponse({ ok: true });
    return false;
  }

  // --- Popup: Toggle SPY ---
  if (msg.type === 'TOGGLE_SPY') {
    spyEnabled = msg.enabled;
    chrome.storage.local.set({ spy_enabled: spyEnabled });
    updateBadge();
    console.log('[LS-BG] SPY切替: enabled=', spyEnabled, 'accountId=', accountId);
    if (spyEnabled) {
      // セッションID生成: UUID v4（spy_messagesテーブルのsession_id列がUUID型）
      currentSessionId = crypto.randomUUID();
      console.log('[LS-BG] SPYセッション開始: session_id=', currentSessionId);
      lastHeartbeat = Date.now();
      heartbeatAlerted = false;
      chrome.storage.local.set({ spy_started_at: new Date().toISOString(), current_session_id: currentSessionId });
      // sessionsテーブルにセッション開始を記録（fire-and-forget）
      if (accountId) {
        insertSession(currentSessionId, accountId).catch(e => {
          console.error('[LS-BG] sessions開始記録失敗:', e.message);
        });
      }
      // スクリーンショットタイマー開始
      startScreenshotCapture();
      // SPY開始時にaccountIdが未設定なら警告
      if (!accountId) {
        console.warn('[LS-BG] 注意: SPY有効化されたがaccountId未設定 メッセージはバッファされflush時に付与');
      }
    } else {
      // SPY OFF — セッション終了処理（fire-and-forget）
      if (currentSessionId && accountId && accessToken) {
        const closingSessionId = currentSessionId;
        chrome.storage.local.get(['spy_started_at']).then(data => {
          return closeSession(closingSessionId, data.spy_started_at);
        }).catch(e => {
          console.error('[LS-BG] sessions終了処理失敗:', e.message);
        });
      }
      // C-1/C-2: 全キャストのper-castセッションも終了
      for (const cn of [...castSessions.keys()]) {
        closeCastSession(cn).catch(e => {
          console.warn('[LS-BG] SPY OFF closeCastSession失敗:', cn, e.message);
        });
      }
      console.log('[LS-BG] SPYセッション終了: session_id=', currentSessionId);
      currentSessionId = null;
      chrome.storage.local.set({ spy_started_at: null, spy_cast: null, current_session_id: null });

      // スクリーンショットタイマー停止
      stopScreenshotCapture();

      // 配信終了 → 5分後にコイン同期を自動実行
      console.log('[LS-BG] AutoCoinSync: 配信終了検出 → 5分後に同期予約');
      chrome.alarms.create('coinSyncAfterStream', { delayInMinutes: 5 });
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

  // --- Popup: Toggle Auto Patrol ---
  if (msg.type === 'TOGGLE_AUTO_PATROL') {
    autoPatrolEnabled = msg.enabled;
    chrome.storage.local.set({ auto_patrol_enabled: autoPatrolEnabled });
    console.log('[LS-BG] AutoPatrol切替: enabled=', autoPatrolEnabled);
    if (autoPatrolEnabled) {
      // ON時に即時巡回
      runAutoPatrol().catch(e => {
        console.warn('[LS-BG] AutoPatrol: 手動ON後の巡回エラー:', e.message);
      });
    }
    sendResponse({ ok: true, autoPatrolEnabled });
    return false;
  }

  // --- Toggle SPY Rotation ---
  if (msg.type === 'TOGGLE_SPY_ROTATION') {
    spyRotationEnabled = msg.enabled;
    chrome.storage.local.set({ spy_rotation_enabled: spyRotationEnabled });
    console.log('[LS-BG] SpyRotation切替: enabled=', spyRotationEnabled);
    if (spyRotationEnabled) {
      handleSpyRotation().catch(e => {
        console.warn('[LS-BG] SpyRotation: 手動ON後エラー:', e.message);
      });
    }
    sendResponse({ ok: true, spyRotationEnabled });
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
 * coin_transactionsテーブルから直近のcast_nameを取得
 * popup未操作 + SPY未使用時のフォールバック用
 */
async function getLastSyncedCastName() {
  if (!accessToken || !accountId) return null;
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/coin_transactions?account_id=eq.${accountId}&cast_name=neq.unknown&select=cast_name&order=synced_at.desc&limit=1`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.length > 0 && data[0].cast_name) {
        console.log('[LS-BG] CoinSync: 直近同期のcast_nameを取得:', data[0].cast_name);
        return data[0].cast_name;
      }
    }
  } catch (err) {
    console.warn('[LS-BG] CoinSync: 直近cast_name取得失敗:', err.message);
  }
  return null;
}

/**
 * コイン同期メインフロー（coin_api.py準拠）
 * 1. /earnings/tokens-history ページのタブを探す or 遷移
 * 2. content_coin_sync.jsを動的注入
 * 3. FETCH_COINSメッセージ送信（365日分、全ページ取得）
 * 4. 取得データをSupabaseに保存
 */
async function handleCoinSync() {
  await loadAuth();
  if (!accountId || !accessToken) {
    return { ok: false, error: 'ログインしてアカウントを選択してください' };
  }

  // ===== cast_name解決（5段階フォールバック） =====
  // 1. last_sync_cast_name（ポップアップで選択されたキャスト）← 最優先
  // 2. registered_casts（Supabase）から最初のアクティブキャスト（1件のみなら自動保存）
  // 3. last_cast_name（SPY監視時に保存される）
  // 4. coin_transactionsの直近cast_name（過去の同期実績から引き継ぎ）
  // 5. フォールバック: 'unknown'（警告ログ付き）
  const syncCastData = await chrome.storage.local.get(['last_sync_cast_name', 'last_cast_name']);
  let syncCastName = syncCastData.last_sync_cast_name || null;

  if (!syncCastName) {
    await loadRegisteredCasts();
    if (registeredCastNames.size > 0) {
      syncCastName = [...registeredCastNames][0];
      // キャスト1件のみなら次回以降のために保存
      if (registeredCastNames.size === 1) {
        chrome.storage.local.set({ last_sync_cast_name: syncCastName });
      }
    }
  }
  if (!syncCastName) {
    syncCastName = syncCastData.last_cast_name || null;
  }
  if (!syncCastName) {
    syncCastName = await getLastSyncedCastName();
  }
  if (!syncCastName) {
    syncCastName = 'unknown';
    console.warn('[LS-BG] CoinSync: cast_name解決失敗 — 全フォールバック経由で "unknown" を使用');
  }
  console.log('[LS-BG] CoinSync: cast_name =', syncCastName);

  // ===== 差分同期ロジック =====
  const syncStorageKey = `coin_sync_last_${accountId}`;
  const stored = await chrome.storage.local.get(syncStorageKey);
  const lastSyncISO = stored[syncStorageKey] || null;
  const now = new Date();

  const FULL_SYNC_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
  const isFullSync = !lastSyncISO ||
    (now.getTime() - new Date(lastSyncISO).getTime()) > FULL_SYNC_INTERVAL_MS;

  if (isFullSync) {
    console.log('[LS-BG] CoinSync: フル同期モード（全件取得）');
  } else {
    console.log(`[LS-BG] CoinSync: 差分同期モード（${lastSyncISO} 以降）`);
  }
  // ===========================

  // Step 1: earningsページのタブを探す、なければStripchatタブを遷移
  let targetTab;

  // まず /earnings/ 配下のタブがあるか確認
  let earningsTabs = await chrome.tabs.query({
    url: ['*://stripchat.com/earnings/*', '*://*.stripchat.com/earnings/*'],
  });

  if (earningsTabs.length > 0) {
    targetTab = earningsTabs[0];
    console.log('[LS-BG] Coin同期: 既存earningsタブ使用 tab=', targetTab.id, targetTab.url);

    // F5リロード直後はまだロード中の可能性がある — 完了を待つ
    const tabInfo = await chrome.tabs.get(targetTab.id);
    if (tabInfo.status !== 'complete') {
      console.log('[LS-BG] Coin同期: タブがまだロード中 → 完了待ち');
      const loaded = await waitForTabComplete(targetTab.id, 15000);
      if (!loaded) {
        return { ok: false, error: 'earningsページのロードがタイムアウトしました' };
      }
      await sleep_bg(2000);
    }
  } else {
    // Stripchatタブを /earnings/tokens-history に遷移
    const tabs = await chrome.tabs.query({
      url: ['*://stripchat.com/*', '*://*.stripchat.com/*'],
    });

    if (tabs.length === 0) {
      return { ok: false, error: 'Stripchatタブを開いてログインしてください' };
    }

    targetTab = tabs[0];
    console.log('[LS-BG] Coin同期: earningsページへ遷移 tab=', targetTab.id);

    await chrome.tabs.update(targetTab.id, {
      url: 'https://ja.stripchat.com/earnings/tokens-history',
    });

    // ページロード完了待ち
    const loaded = await waitForTabComplete(targetTab.id, 15000);
    if (!loaded) {
      return { ok: false, error: 'earningsページのロードがタイムアウトしました' };
    }
    // DOMとCookie安定待ち（coin_api.pyと同様に十分な時間を確保）
    await sleep_bg(3000);
  }

  // Step 2: content_coin_sync.jsを動的注入 + PING確認（最大2回リトライ）
  const MAX_INJECT_ATTEMPTS = 2;
  let scriptReady = false;

  for (let attempt = 1; attempt <= MAX_INJECT_ATTEMPTS; attempt++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        files: ['content_coin_sync.js'],
      });
      console.log(`[LS-BG] content_coin_sync.js 動的注入成功 (attempt ${attempt}): tab=`, targetTab.id);
      await sleep_bg(500);
    } catch (injectErr) {
      console.error(`[LS-BG] content_coin_sync.js 注入失敗 (attempt ${attempt}):`, injectErr.message);
      if (attempt === MAX_INJECT_ATTEMPTS) {
        return { ok: false, error: 'Content script注入失敗: ' + injectErr.message };
      }
      await sleep_bg(2000);
      continue;
    }

    // PING送信でcontent scriptのlistenerが応答するか確認
    try {
      const pingResult = await Promise.race([
        chrome.tabs.sendMessage(targetTab.id, { type: 'COIN_SYNC_PING' }),
        sleep_bg(3000).then(() => null),
      ]);
      if (pingResult && pingResult.pong) {
        console.log('[LS-BG] COIN_SYNC_PING成功 — content script応答確認');
        scriptReady = true;
        break;
      } else {
        console.warn(`[LS-BG] COIN_SYNC_PING応答なし (attempt ${attempt})`);
      }
    } catch (pingErr) {
      console.warn(`[LS-BG] COIN_SYNC_PING失敗 (attempt ${attempt}):`, pingErr.message);
    }

    if (attempt < MAX_INJECT_ATTEMPTS) {
      // 次の試行前にページが安定するのを待つ
      console.log('[LS-BG] content script再注入を試行します...');
      await sleep_bg(2000);
    }
  }

  if (!scriptReady) {
    return { ok: false, error: 'Content scriptが応答しません。ページをリロードして再試行してください。' };
  }

  // Step 3: FETCH_COINS送信（10分タイムアウト付き）
  const fetchOptions = isFullSync
    ? { maxPages: 600, limit: 100 }
    : { maxPages: 600, limit: 100, sinceISO: lastSyncISO };
  console.log('[LS-BG] FETCH_COINS options:', JSON.stringify(fetchOptions));

  const FETCH_TIMEOUT_MS = 10 * 60 * 1000; // 10分
  let fetchResult;
  try {
    fetchResult = await Promise.race([
      chrome.tabs.sendMessage(targetTab.id, {
        type: 'FETCH_COINS',
        options: fetchOptions,
      }),
      sleep_bg(FETCH_TIMEOUT_MS).then(() => ({ error: 'timeout', message: `${FETCH_TIMEOUT_MS / 60000}分タイムアウト` })),
    ]);
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
  const result = await processCoinSyncData(transactions, syncCastName);

  // 有料ユーザー一覧をpaid_usersにUPSERT（transactions APIとは別に）
  if (payingUsers.length > 0) {
    await processPayingUsersData(payingUsers, syncCastName);
    result.payingUsers = payingUsers.length;
    result.message = `${result.synced || 0}件のトランザクション、${payingUsers.length}名の有料ユーザーを同期しました`;
  }

  // 同期完了日時を保存（差分同期の基準点）
  await chrome.storage.local.set({ [syncStorageKey]: now.toISOString() });
  console.log(`[LS-BG] CoinSync: 同期日時保存 ${now.toISOString()}`);

  return result;
}

/**
 * コイントランザクションデータをSupabase REST APIで直接保存
 * 1. coin_transactions UPSERT（500件バッチ、stripchat_tx_idで重複排除）
 * 2. refresh_paying_users RPC（マテビュー更新）
 * ※ paid_usersはprocessPayingUsersData()が担当（二重書き込み防止）
 */
async function processCoinSyncData(transactions, castName = 'unknown') {
  await loadAuth();
  if (!accountId || !accessToken) {
    return { ok: false, error: '認証エラー' };
  }

  const BATCH_SIZE = 500;
  const now = new Date().toISOString();

  // フィールドマッピング（content_coin_sync.js parseTransaction → coin_transactions）
  const txRows = [];
  for (const tx of transactions) {
    const rawName = tx.userName || tx.user_name || tx.username || '';
    const userName = rawName || (tx.isAnonymous === 1 ? 'anonymous' : 'unknown');
    const tokens = parseInt(tx.tokens ?? 0, 10);
    if (tokens <= 0) {
      console.warn('[LS-BG] tokens <= 0 スキップ:', tokens, 'user=', rawName, 'type=', tx.type);
      continue;
    }
    const txType = tx.type || 'unknown';
    const txDate = tx.date || now;
    const sourceDetail = tx.sourceDetail || tx.sourceType || '';
    const stripchatTxId = tx.id ?? null;

    txRows.push({
      account_id: accountId,
      cast_name: castName,
      stripchat_tx_id: stripchatTxId,
      user_name: userName,
      user_id: tx.userId || null,
      tokens: tokens,
      amount: tx.amount ?? null,
      type: txType,
      date: txDate,
      source_detail: sourceDetail,
      is_anonymous: tx.isAnonymous === 1,
      synced_at: now,
    });
  }

  console.log('[LS-BG] coin_transactions マッピング完了:', txRows.length, '/', transactions.length, '件');

  if (txRows.length === 0) {
    return { ok: true, synced: 0, message: '有効なトランザクションがありません' };
  }

  // 1. coin_transactions UPSERT（500件バッチ、stripchat_tx_idで重複排除）
  let insertedTx = 0;
  let batchErrors = 0;
  const totalBatches = Math.ceil(txRows.length / BATCH_SIZE);
  console.log('[LS-BG] coin_transactions upsert開始:', txRows.length, '件 /', totalBatches, 'バッチ');

  for (let i = 0; i < txRows.length; i += BATCH_SIZE) {
    const batch = txRows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const res = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/coin_transactions?on_conflict=account_id,user_name,cast_name,tokens,date`,
        {
          method: 'POST',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify(batch),
        }
      );

      if (res.ok || res.status === 201) {
        insertedTx += batch.length;
        console.log('[LS-BG] coin_transactions upsert バッチ', batchNum, '/', totalBatches, ':', batch.length, '件成功（累計', insertedTx, '件）');
      } else {
        const errText = await res.text().catch(() => '');
        console.warn('[LS-BG] coin_transactions upsert バッチ', batchNum, '失敗:', res.status, errText.substring(0, 200));
        batchErrors++;
      }
    } catch (err) {
      console.error('[LS-BG] coin_transactions upsert バッチ', batchNum, '例外:', err.message);
      batchErrors++;
    }
  }

  console.log('[LS-BG] coin_transactions upsert完了:', insertedTx, '件成功 / エラーバッチ:', batchErrors);

  // paid_usersへの書き込みはprocessPayingUsersData()が担当（二重書き込み防止）

  // 2. refresh_paying_users RPC（マテビュー更新）
  try {
    const rpcRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/refresh_paying_users`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (rpcRes.ok) {
      console.log('[LS-BG] refresh_paying_users RPC成功');
    } else {
      console.warn('[LS-BG] refresh_paying_users RPC: HTTP', rpcRes.status, '(関数が未作成の可能性 — 非致命的)');
    }
  } catch (err) {
    console.warn('[LS-BG] refresh_paying_users RPC失敗（非致命的）:', err.message);
  }

  // refresh_segments RPC呼び出し（コイン同期後にセグメント自動更新）
  try {
    const segRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/rpc/refresh_segments`,
      {
        method: 'POST',
        headers: { ...CONFIG.SUPABASE_HEADERS, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_account_id: accountId }),
      }
    );
    if (segRes.ok) {
      const count = await segRes.json();
      console.log('[LS-BG] refresh_segments RPC成功:', count, '件更新');
    } else {
      console.warn('[LS-BG] refresh_segments RPC: HTTP', segRes.status, '(関数が未作成の可能性 — 非致命的)');
    }
  } catch (err) {
    console.warn('[LS-BG] refresh_segments RPC失敗（非致命的）:', err.message);
  }

  // 離脱DM自動トリガー（refresh_segments後 — fire-and-forget）
  triggerChurnRecoveryDMs().catch(e => {
    console.warn('[LS-BG] 離脱DMトリガー失敗（非致命的）:', e.message);
  });

  // 同期ステータス保存
  await chrome.storage.local.set({
    last_coin_sync: now,
    coin_sync_count: insertedTx,
  });

  console.log('[LS-BG] ========== Coin同期完了 ==========');
  console.log('[LS-BG] トランザクション:', insertedTx, '件');

  return {
    ok: true,
    synced: insertedTx,
    message: `${insertedTx}件のトランザクションを同期しました`,
  };
}

/**
 * 有料ユーザー一覧データ（/transactions/users API）をpaid_usersにUPSERT
 * 500件バッチ、on_conflict=account_id,user_name で重複排除
 */
async function processPayingUsersData(payingUsers, castName = 'unknown') {
  await loadAuth();
  if (!accountId || !accessToken) return;

  const BATCH_SIZE = 500;
  const rows = payingUsers
    .filter(u => u.userName)
    .map(u => ({
      account_id: accountId,
      user_name: u.userName,
      total_coins: u.totalTokens || 0,
      last_payment_date: u.lastPaid || null,
      user_id_stripchat: u.userId ? String(u.userId) : null,
      cast_name: castName,
    }));

  if (rows.length === 0) return;

  let insertedCount = 0;
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
  console.log('[LS-BG] paid_users upsert開始（有料ユーザーAPI）:', rows.length, '名 /', totalBatches, 'バッチ');

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const res = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/paid_users?on_conflict=account_id,user_name`,
        {
          method: 'POST',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(batch),
        }
      );

      if (res.ok || res.status === 201) {
        insertedCount += batch.length;
        console.log('[LS-BG] paid_users upsert バッチ', batchNum, '/', totalBatches, ':', batch.length, '名成功（累計', insertedCount, '名）');
      } else {
        const errText = await res.text().catch(() => '');
        console.warn('[LS-BG] paid_users upsert バッチ', batchNum, '失敗:', res.status, errText.substring(0, 200));
      }
    } catch (err) {
      console.warn('[LS-BG] paid_users upsert バッチ', batchNum, '例外:', err.message);
    }
  }

  console.log('[LS-BG] paid_users upsert完了（有料ユーザーAPI）:', insertedCount, '/', rows.length, '名');
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
  // bulk_ → デフォルトpipeline 3tab
  if (campaign.startsWith('bulk_')) {
    return { mode: 'pipeline', tabCount: 3 };
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
        // 既に成功済みのtaskIdはerror上書きしない
        if (successfulTaskIds.has(taskId)) {
          console.log('[LS-BG] DM結果タイムアウト発火したが既に成功済み → スキップ: taskId=', taskId);
          pendingDMResults.delete(taskId);
          successfulTaskIds.delete(taskId);
          resolve({ success: true, error: null });
          return;
        }
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
 * DMスケジュールポーリング — pending + scheduled_at <= now のレコードを検出して実行
 * keepaliveアラーム（30秒ごと）から呼ばれる
 */
async function checkDmSchedules() {
  if (!accountId || !accessToken) return;

  const now = new Date().toISOString();
  const res = await fetch(
    `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?account_id=eq.${accountId}&status=eq.pending&scheduled_at=lte.${encodeURIComponent(now)}&order=scheduled_at.asc&limit=3`,
    {
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  );
  if (!res.ok) return;
  const schedules = await res.json();
  if (!Array.isArray(schedules) || schedules.length === 0) return;

  for (const sched of schedules) {
    console.log('[LS-BG] DMスケジュール検出（ポーリング）: id=', sched.id, 'at=', sched.scheduled_at);
    await executeDmSchedule(sched.id);
  }
}

/**
 * DMスケジュール実行
 * dm_schedulesからスケジュール情報を取得し、dm_send_logにキュー登録して既存パイプラインに委譲
 */
async function executeDmSchedule(scheduleId) {
  await loadAuth();
  if (!accountId || !accessToken) {
    console.error('[LS-BG] DMスケジュール実行失敗: 認証情報なし');
    return;
  }

  console.log('[LS-BG] DMスケジュール実行開始:', scheduleId);

  try {
    // 1. スケジュール情報を取得
    const schedRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?id=eq.${scheduleId}&select=*`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
        },
      }
    );
    if (!schedRes.ok) throw new Error(`スケジュール取得失敗: HTTP ${schedRes.status}`);
    const schedArr = await schedRes.json();
    if (!Array.isArray(schedArr) || schedArr.length === 0) {
      console.warn('[LS-BG] DMスケジュール未検出:', scheduleId);
      return;
    }
    const schedule = schedArr[0];

    // pending以外は処理しない
    if (schedule.status !== 'pending') {
      console.log('[LS-BG] DMスケジュールスキップ: status=', schedule.status);
      return;
    }

    // 2. ステータスを 'sending' に更新
    await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?id=eq.${scheduleId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ status: 'sending' }),
      }
    );

    // 3. 送信先ユーザーリストを組み立て
    let usernames = schedule.target_usernames || [];

    if (usernames.length === 0 && schedule.target_segment) {
      // セグメント指定の場合: get_user_segments RPCからユーザー名を抽出
      const segRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/rpc/get_user_segments`,
        {
          method: 'POST',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_account_id: schedule.account_id,
            p_cast_name: schedule.cast_name,
          }),
        }
      );
      if (segRes.ok) {
        const segData = await segRes.json();
        const targetSegs = schedule.target_segment === 'all'
          ? null
          : schedule.target_segment.split(',').map(s => s.trim());

        const segments = Array.isArray(segData) ? segData : [];
        for (const seg of segments) {
          if (targetSegs && !targetSegs.includes(seg.segment_id)) continue;
          if (Array.isArray(seg.users)) {
            for (const u of seg.users) {
              if (u.user_name && !usernames.includes(u.user_name)) {
                usernames.push(u.user_name);
              }
            }
          }
        }
      } else {
        console.error('[LS-BG] セグメントRPC失敗:', segRes.status);
      }
    }

    if (usernames.length === 0) {
      console.warn('[LS-BG] DMスケジュール: 送信先なし');
      await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?id=eq.${scheduleId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ status: 'failed', error_message: '送信先ユーザーが見つかりません' }),
        }
      );
      return;
    }

    // 4. total_count更新
    await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?id=eq.${scheduleId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ total_count: usernames.length }),
      }
    );

    // 5. dm_send_logにキュー登録（既存パイプラインが処理する）
    const sendMode = schedule.send_mode || 'pipeline';
    const tabCount = schedule.tab_count || 3;
    const modePrefix = sendMode === 'pipeline' ? `pipe${tabCount}` : 'seq';
    const campaignTag = schedule.campaign ? `${schedule.campaign}_` : '';
    const batchCampaign = `${modePrefix}_${campaignTag}sched_${scheduleId.substring(0, 8)}`;

    const rows = usernames.map(un => ({
      account_id: schedule.account_id,
      user_name: un,
      profile_url: `https://stripchat.com/${un}`,
      message: schedule.message,
      status: 'queued',
      campaign: batchCampaign,
      cast_name: schedule.cast_name,
    }));

    // バッチINSERT（50件ずつ）
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      console.log('[LS-BG] DMスケジュール: dm_send_log INSERTリクエスト:', JSON.stringify(batch[0], null, 2), `(${batch.length}件)`);
      const insertRes = await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`,
        {
          method: 'POST',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(batch),
        }
      );
      if (!insertRes.ok) {
        const errBody = await insertRes.text().catch(() => '(レスポンス読取失敗)');
        console.error('[LS-BG] DMスケジュール: dm_send_log INSERT失敗:', insertRes.status, errBody);
      }
    }

    console.log('[LS-BG] DMスケジュール: dm_send_logに', usernames.length, '件キュー登録完了 campaign=', batchCampaign);

    // 6. DMポーリングが動いていなければ開始（既存パイプラインが自動的に処理）
    startDMPolling();

    // 7. dm_schedulesのステータスを完了に（送信自体は既存パイプラインに委譲）
    await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?id=eq.${scheduleId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'completed',
          sent_count: usernames.length,
          completed_at: new Date().toISOString(),
        }),
      }
    );

    console.log('[LS-BG] DMスケジュール完了:', scheduleId, usernames.length, '件');
  } catch (e) {
    console.error('[LS-BG] DMスケジュール実行例外:', e.message);
    // エラーステータス更新
    try {
      await fetch(
        `${CONFIG.SUPABASE_URL}/rest/v1/dm_schedules?id=eq.${scheduleId}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ status: 'failed', error_message: e.message }),
        }
      );
    } catch (patchErr) {
      console.error('[LS-BG] DMスケジュールエラー更新失敗:', patchErr.message);
    }
  }
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
    // 許可パターン: pipe{N}_, seq_, bulk_, sched_
    const c = peekTask.campaign || '';
    if (!c || !(c.startsWith('pipe') || c.startsWith('seq') || c.startsWith('bulk') || c.includes('_sched_'))) {
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
// SPY自動巡回 — 自社キャストの配信開始を自動検出してSPY監視を起動
// registered_castsのis_active=trueキャストを3分間隔でポーリング
// ============================================================

/**
 * Stripchat公開APIでキャストのオンライン状態を確認
 * @param {string} castName - キャスト名
 * @returns {Promise<string>} 'public'|'private'|'offline'|'unknown'
 */
async function checkCastOnlineStatus(castName) {
  try {
    const res = await fetch(
      `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(castName)}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) {
      console.warn('[LS-BG] AutoPatrol: API応答エラー cast=', castName, 'status=', res.status);
      return 'unknown';
    }
    const data = await res.json();
    // レスポンス構造: { user: { status: 'public'|'private'|'off'|... } }
    const status = data?.user?.status || 'unknown';
    return status;
  } catch (err) {
    console.warn('[LS-BG] AutoPatrol: APIエラー cast=', castName, err.message);
    return 'unknown';
  }
}

/**
 * キャストがオンライン（配信中）かどうか判定
 */
function isStreamingStatus(status) {
  return status === 'public' || status === 'private' || status === 'p2p';
}

/**
 * 自動巡回メインロジック
 * 1. registered_castsキャッシュから自社キャスト一覧を取得
 * 2. 各キャストのStripchat APIでオンライン状態チェック
 * 3. offline→online変化時: タブ自動オープン + SPY有効化
 */
async function runAutoPatrol() {
  if (!autoPatrolEnabled) return;

  await loadAuth();
  if (!accessToken || !accountId) {
    return;
  }

  // キャッシュが空ならロード
  if (registeredCastNames.size === 0) {
    await loadRegisteredCasts();
  }
  if (registeredCastNames.size === 0) {
    return; // 自社キャスト未登録
  }

  console.log('[LS-BG] AutoPatrol: 巡回開始 キャスト数=', registeredCastNames.size,
    [...registeredCastNames].join(', '));

  for (const castName of registeredCastNames) {
    const status = await checkCastOnlineStatus(castName);
    const prevStatus = monitoredCastStatus[castName] || 'offline';

    // ステータスが不明の場合は状態変更を判定しない
    if (status === 'unknown') {
      continue;
    }

    const wasStreaming = isStreamingStatus(prevStatus);
    const nowStreaming = isStreamingStatus(status);

    monitoredCastStatus[castName] = status;

    // Task K: Survival tracking — update last_seen_online when cast is streaming
    if (nowStreaming) {
      updateCastLastSeen(castName).catch(e => {
        console.warn('[LS-BG] last_seen_online更新失敗:', castName, e.message);
      });
    }

    // offline → online に変化した場合
    if (!wasStreaming && nowStreaming) {
      console.log('[LS-BG] AutoPatrol: 配信開始検出! cast=', castName, 'status=', status);

      // 通知
      chrome.notifications.create(`patrol-online-${castName}`, {
        type: 'basic',
        iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="24" font-size="24">🔴</text></svg>',
        title: 'Strip Live Spot - 配信開始検出',
        message: `${castName} が配信を開始しました（${status}）。SPY監視を自動起動します。`,
        priority: 2,
      });

      // 既にこのキャストのタブが開いているかチェック
      const existingTabId = autoPatrolTabs[castName];
      let tabAlreadyOpen = false;
      if (existingTabId) {
        try {
          await chrome.tabs.get(existingTabId);
          tabAlreadyOpen = true;
          console.log('[LS-BG] AutoPatrol: 既存タブあり cast=', castName, 'tab=', existingTabId);
        } catch (e) {
          // タブが閉じられている
          delete autoPatrolTabs[castName];
        }
      }

      // Stripchatタブ内で既にこのキャストを開いているかもチェック
      if (!tabAlreadyOpen) {
        try {
          const tabs = await chrome.tabs.query({
            url: [`*://stripchat.com/${castName}*`, `*://*.stripchat.com/${castName}*`],
          });
          if (tabs.length > 0) {
            tabAlreadyOpen = true;
            autoPatrolTabs[castName] = tabs[0].id;
            console.log('[LS-BG] AutoPatrol: 既存Stripchatタブ発見 cast=', castName, 'tab=', tabs[0].id);
          }
        } catch (e) {
          // ignore
        }
      }

      // タブが開いていなければ新規作成
      if (!tabAlreadyOpen) {
        try {
          const newTab = await chrome.tabs.create({
            url: `https://stripchat.com/${castName}`,
            active: false,
          });
          autoPatrolTabs[castName] = newTab.id;
          console.log('[LS-BG] AutoPatrol: タブ自動オープン cast=', castName, 'tab=', newTab.id);
        } catch (e) {
          console.error('[LS-BG] AutoPatrol: タブ作成失敗 cast=', castName, e.message);
          continue;
        }
      }

      // SPYがOFFなら自動ONにする（自動巡回有効 = SPY自動監視を望んでいる）
      if (!spyEnabled) {
        console.log('[LS-BG] AutoPatrol: SPY自動ON');
        spyEnabled = true;
        currentSessionId = crypto.randomUUID();
        lastHeartbeat = Date.now();
        heartbeatAlerted = false;
        chrome.storage.local.set({
          spy_enabled: true,
          spy_started_at: new Date().toISOString(),
          current_session_id: currentSessionId,
        });
        updateBadge();

        // sessionsテーブルにセッション開始を記録
        chrome.storage.local.set({ last_cast_name: castName });
        insertSession(currentSessionId, accountId).catch(e => {
          console.error('[LS-BG] AutoPatrol: sessions開始記録失敗:', e.message);
        });

        // スクリーンショットタイマー開始
        startScreenshotCapture();

        // 全Stripchatタブにも通知
        chrome.tabs.query(
          { url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] },
          (tabs) => {
            tabs.forEach((tab) => {
              chrome.tabs.sendMessage(tab.id, {
                type: 'SPY_STATE',
                enabled: true,
              }).catch(() => {});
            });
          }
        );
      }
    }

    // online → offline に変化した場合
    if (wasStreaming && !nowStreaming) {
      console.log('[LS-BG] AutoPatrol: 配信終了検出 cast=', castName, 'status=', status);

      chrome.notifications.create(`patrol-offline-${castName}`, {
        type: 'basic',
        iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="24" font-size="24">⚫</text></svg>',
        title: 'Strip Live Spot - 配信終了検出',
        message: `${castName} の配信が終了しました。`,
        priority: 1,
      });
    }

    // API呼び出し間に小さな間隔を入れる（レート制限回避）
    if (registeredCastNames.size > 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/**
 * 自動巡回の初期化: storageからautoPatrolEnabled状態を復元
 */
async function initAutoPatrol() {
  const data = await chrome.storage.local.get(['auto_patrol_enabled']);
  autoPatrolEnabled = data.auto_patrol_enabled !== false; // デフォルトON
  console.log('[LS-BG] AutoPatrol: 初期化 enabled=', autoPatrolEnabled);
  if (autoPatrolEnabled) {
    // 初回即時巡回（起動直後）
    runAutoPatrol().catch(e => {
      console.warn('[LS-BG] AutoPatrol: 初回巡回エラー:', e.message);
    });
  }
}

// ============================================================
// Task K: Survival Tracking — last_seen_online + extinct detection
// ============================================================

/**
 * updateCastLastSeen(castName)
 * キャストがオンライン検出された時に registered_casts / spy_casts の
 * last_seen_online を更新し、is_extinct を false にリセット
 */
async function updateCastLastSeen(castName) {
  if (!accessToken || !accountId) return;
  const now = new Date().toISOString();
  const patchBody = JSON.stringify({
    last_seen_online: now,
    is_extinct: false,
    extinct_at: null,
  });
  const headers = {
    'apikey': CONFIG.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // Update registered_casts
  try {
    await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&cast_name=eq.${encodeURIComponent(castName)}`,
      { method: 'PATCH', headers, body: patchBody }
    );
  } catch (e) {
    // ignore — cast may not be in registered_casts
  }

  // Update spy_casts
  try {
    await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/spy_casts?account_id=eq.${accountId}&cast_name=eq.${encodeURIComponent(castName)}`,
      { method: 'PATCH', headers, body: patchBody }
    );
  } catch (e) {
    // ignore — cast may not be in spy_casts
  }

  console.log('[LS-BG] Survival: last_seen_online更新:', castName);
}

/**
 * checkExtinctCasts()
 * last_seen_online が30日以上前のキャストを is_extinct = true にマーク
 * 24時間ごとに chrome.alarms 'check-extinct-casts' で実行
 */
async function checkExtinctCasts() {
  await loadAuth();
  if (!accessToken || !accountId) return;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const patchBody = JSON.stringify({
    is_extinct: true,
    extinct_at: now,
  });
  const headers = {
    'apikey': CONFIG.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // PATCH registered_casts where last_seen_online < 30 days ago AND is_extinct = false
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&is_extinct=eq.false&last_seen_online=lt.${encodeURIComponent(thirtyDaysAgo)}`,
      { method: 'PATCH', headers, body: patchBody }
    );
    if (res.ok) {
      console.log('[LS-BG] ExtinctCasts: registered_casts PATCH成功');
    }
  } catch (e) {
    console.warn('[LS-BG] ExtinctCasts: registered_casts PATCH失敗:', e.message);
  }

  // PATCH spy_casts where last_seen_online < 30 days ago AND is_extinct = false
  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/spy_casts?account_id=eq.${accountId}&is_extinct=eq.false&last_seen_online=lt.${encodeURIComponent(thirtyDaysAgo)}`,
      { method: 'PATCH', headers, body: patchBody }
    );
    if (res.ok) {
      console.log('[LS-BG] ExtinctCasts: spy_casts PATCH成功');
    }
  } catch (e) {
    console.warn('[LS-BG] ExtinctCasts: spy_casts PATCH失敗:', e.message);
  }

  console.log('[LS-BG] ExtinctCasts: 消滅チェック完了 (threshold:', thirtyDaysAgo, ')');
}

// ============================================================
// SPY他社ローテーション — spy_castsのキャストを自動巡回・タブ管理
// ============================================================

/**
 * SPYローテーション初期化: storageから状態を復元
 */
async function initSpyRotation() {
  const data = await chrome.storage.local.get(['spy_rotation_enabled']);
  spyRotationEnabled = data.spy_rotation_enabled === true; // デフォルトOFF
  console.log('[LS-BG] SpyRotation: 初期化 enabled=', spyRotationEnabled);
}

/**
 * 他社SPYローテーション メインロジック
 * - spy_castsのキャストのオンライン状態をチェック
 * - オンラインならタブオープン、オフラインならタブクローズ
 * - 自社キャスト（registered_casts）のタブは絶対に閉じない
 * - 同時タブ数上限あり
 */
async function handleSpyRotation() {
  if (!spyRotationEnabled || !spyEnabled) return;

  await loadAuth();
  if (!accessToken || !accountId) return;

  // キャッシュが空ならロード
  if (spyCastNamesCache.size === 0) {
    await loadRegisteredCasts();
  }
  if (spyCastNamesCache.size === 0) return;

  const EXCLUDE_PAGES = ['favorites', 'messages', 'settings', 'feed', 'members', 'login', 'signup', 'new', 'search', 'models', 'categories', '404'];

  // 現在開いているStripchatタブを取得
  const existingTabs = await chrome.tabs.query({ url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] });
  const openCastTabs = new Map(); // castName → tabId
  for (const tab of existingTabs) {
    if (!tab.url || !tab.id) continue;
    const m = tab.url.match(/stripchat\.com\/([A-Za-z0-9_-]+)/);
    if (!m) continue;
    if (EXCLUDE_PAGES.includes(m[1])) continue;
    openCastTabs.set(m[1], tab.id);
  }

  let opened = 0;
  let closed = 0;
  const onlineCount = { total: 0 };

  // 各spy_castのオンライン状態をチェック
  for (const castName of spyCastNamesCache) {
    // 自社キャストはAutoPatrolの管轄なのでスキップ
    if (ownCastNamesCache.has(castName)) continue;

    const status = await checkCastOnlineStatus(castName);
    if (status === 'unknown') continue;

    const nowStreaming = isStreamingStatus(status);
    const prevStatus = monitoredCastStatus[castName] || 'offline';
    monitoredCastStatus[castName] = status;

    // Survival tracking
    if (nowStreaming) {
      onlineCount.total++;
      updateCastLastSeen(castName).catch(() => {});
    }

    // オンラインなのにタブが開いていない → オープン
    if (nowStreaming && !openCastTabs.has(castName)) {
      // タブ数上限チェック
      if (openCastTabs.size + opened - closed >= MAX_SPY_ROTATION_TABS) {
        console.log('[LS-BG] SpyRotation: タブ上限到達 skip=', castName);
        continue;
      }
      try {
        const newTab = await chrome.tabs.create({
          url: `https://stripchat.com/${castName}`,
          active: false,
        });
        spyRotationTabs[castName] = newTab.id;
        opened++;
        console.log('[LS-BG] SpyRotation: タブオープン cast=', castName, 'tab=', newTab.id);
        await sleep_bg(500);
      } catch (e) {
        console.warn('[LS-BG] SpyRotation: タブ作成失敗 cast=', castName, e.message);
      }
    }

    // オフラインでタブが開いている → クローズ（ローテーションで開いたタブのみ）
    if (!nowStreaming && isStreamingStatus(prevStatus)) {
      const tabId = spyRotationTabs[castName];
      if (tabId) {
        // 自社キャスト保護: 絶対に閉じない
        if (ownCastNamesCache.has(castName)) continue;
        try {
          await chrome.tabs.remove(tabId);
          delete spyRotationTabs[castName];
          closed++;
          console.log('[LS-BG] SpyRotation: タブクローズ cast=', castName, 'tab=', tabId);
        } catch {
          delete spyRotationTabs[castName];
        }
      }
    }

    // API レート制限回避
    await sleep_bg(1000);
  }

  const totalTabs = openCastTabs.size + opened - closed;
  console.log(`[LS-BG] SpyRotation: online=${onlineCount.total}, opened=${opened}, closed=${closed}, tabs=${totalTabs}/${MAX_SPY_ROTATION_TABS}`);
}

// ============================================================
// Screenshot Capture — SPY監視中の全タブスクリーンショット（5分間隔）
// ============================================================

function startScreenshotCapture() {
  chrome.alarms.get('spy-screenshot', (existing) => {
    if (!existing) {
      chrome.alarms.create('spy-screenshot', { periodInMinutes: 1 });
    }
  });
  // 即時キャプチャ（初回）
  captureAllSpyTabs().catch(e => console.warn('[LS-BG] Screenshot: 初回キャプチャ失敗:', e.message));
  console.log('[LS-SPY] Screenshot alarm registered (1分間隔, キャスト別判定)');
}

function stopScreenshotCapture() {
  chrome.alarms.clear('spy-screenshot');
  console.log('[LS-SPY] Screenshot alarm cleared');
}

/**
 * SPY監視中の全Stripchatタブを順番に撮影する
 * 方式A: タブ切り替え → captureVisibleTab → 元に戻す
 */
async function captureAllSpyTabs() {
  if (!spyEnabled || !accessToken || !accountId) return;

  // 全Stripchatタブを取得 — 配信ページを開いている全タブが対象（競合監視含む）
  const EXCLUDE_PAGES = ['favorites', 'messages', 'settings', 'feed', 'members', 'login', 'signup', 'new', 'search', 'models', 'categories', '404'];
  const allTabs = await chrome.tabs.query({ url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] });
  const spyTabs = [];
  for (const tab of allTabs) {
    if (!tab.url || !tab.id) continue;
    const m = tab.url.match(/stripchat\.com\/([A-Za-z0-9_-]+)/);
    if (!m) continue;
    const castName = m[1];
    if (EXCLUDE_PAGES.includes(castName)) continue;
    spyTabs.push({ tabId: tab.id, windowId: tab.windowId, castName, active: tab.active });
  }

  if (spyTabs.length === 0) {
    console.log('[LS-SPY] Screenshot: 撮影対象タブなし');
    return;
  }

  // キャスト別間隔チェック: 撮影対象のタブだけに絞る
  const now = Date.now();
  const tabsToCapture = spyTabs.filter(t => {
    const interval = screenshotIntervalCache[t.castName];
    if (interval === undefined || interval === null || interval <= 0) return false; // OFF
    const lastCapture = screenshotLastCapture[t.castName] || 0;
    const elapsedMin = (now - lastCapture) / 60000;
    return elapsedMin >= interval;
  });

  if (tabsToCapture.length === 0) return; // 全キャストまだ撮影不要

  const castNames = tabsToCapture.map(t => `${t.castName}(${screenshotIntervalCache[t.castName]}m)`).join(', ');
  console.log(`[LS-SPY] Capturing screenshots for ${tabsToCapture.length}/${spyTabs.length} tabs: ${castNames}`);

  // 元のアクティブタブを記憶（ウィンドウごと）
  const originalActiveTabs = new Map(); // windowId → tabId
  for (const t of spyTabs) {
    if (t.active && !originalActiveTabs.has(t.windowId)) {
      originalActiveTabs.set(t.windowId, t.tabId);
    }
  }
  // アクティブタブが spyTabs 内にない場合も記憶
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const at of activeTabs) {
      if (!originalActiveTabs.has(at.windowId)) {
        originalActiveTabs.set(at.windowId, at.id);
      }
    }
  } catch { /* ignore */ }

  for (const spy of tabsToCapture) {
    try {
      // タブがまだ存在するか確認
      let tabInfo;
      try {
        tabInfo = await chrome.tabs.get(spy.tabId);
      } catch {
        console.warn('[LS-SPY] Screenshot: タブが閉じられている:', spy.castName);
        continue;
      }

      // タブをアクティブにする（captureVisibleTabの前提条件）
      if (!tabInfo.active) {
        await chrome.tabs.update(spy.tabId, { active: true });
        await sleep_bg(400); // レンダリング完了待ち
      }

      // キャプチャ実行
      const dataUrl = await chrome.tabs.captureVisibleTab(spy.windowId, {
        format: 'jpeg',
        quality: 70,
      });

      if (!dataUrl) {
        console.warn('[LS-SPY] Screenshot: captureVisibleTab returned null:', spy.castName);
        continue;
      }

      // アップロード + メタデータ保存
      await uploadScreenshot(spy.castName, dataUrl);

      // 前回撮影時刻を記録
      screenshotLastCapture[spy.castName] = Date.now();

    } catch (err) {
      console.warn('[LS-SPY] Screenshot failed for', spy.castName, ':', err.message);
      // 1タブ失敗しても他タブは継続
    }
  }

  // 元のアクティブタブに戻す（ユーザー体験復元）
  for (const [windowId, tabId] of originalActiveTabs) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      // タブが閉じられていた場合は無視
    }
  }
}

/**
 * スクリーンショットをSupabase Storageにアップロードし、メタデータをDBに保存
 */
async function uploadScreenshot(castName, dataUrl) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${castName}_${timestamp}.jpg`;

  // dataURL → Blob変換
  const base64Data = dataUrl.split(',')[1];
  const byteChars = atob(base64Data);
  const byteArrays = [];
  for (let offset = 0; offset < byteChars.length; offset += 1024) {
    const slice = byteChars.slice(offset, offset + 1024);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  const blob = new Blob(byteArrays, { type: 'image/jpeg' });

  // Supabase Storage アップロード
  let storagePath = null;
  try {
    const uploadRes = await fetch(
      `${CONFIG.SUPABASE_URL}/storage/v1/object/screenshots/${castName}/${filename}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Content-Type': 'image/jpeg',
        },
        body: blob,
      }
    );
    if (uploadRes.ok) {
      const uploadData = await uploadRes.json();
      storagePath = uploadData.Key || `screenshots/${castName}/${filename}`;
      console.log('[LS-SPY] Screenshot uploaded:', storagePath);
    } else {
      const errText = await uploadRes.text().catch(() => '');
      console.warn('[LS-SPY] Screenshot upload failed:', uploadRes.status, errText);
    }
  } catch (storageErr) {
    console.warn('[LS-SPY] Screenshot storage error:', storageErr.message);
  }

  // screenshots テーブルにメタデータ保存
  const sessionId = castSessions.get(castName) || currentSessionId || null;
  try {
    const metaRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/screenshots`, {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        account_id: accountId,
        cast_name: castName,
        session_id: sessionId,
        filename: filename,
        storage_path: storagePath,
        captured_at: new Date().toISOString(),
      }),
    });
    if (!metaRes.ok) {
      console.warn('[LS-SPY] Screenshot metadata insert failed:', metaRes.status);
    }
  } catch (metaErr) {
    console.warn('[LS-SPY] Screenshot metadata error:', metaErr.message);
  }

  console.log(`[LS-SPY] Screenshot saved: ${castName} ${filename} storage=${!!storagePath}`);
}

// ============================================================
// Lifecycle
// ============================================================
console.log('[LS-BG] === Service Worker起動 ===');

restoreBuffers().then(() => {
  // 起動時にバッジ更新
  updateBadge();
  // SW再起動対策: per-castセッション状態を復元
  restoreSessionState();
  loadAuth().then(async () => {
    console.log('[LS-BG] 認証状態: token=', !!accessToken, 'account=', accountId, 'spy=', spyEnabled);
    if (accessToken && accountId) {
      startDMPolling();
      startWhisperPolling();
      loadRegisteredCasts();
      initAutoPatrol(); // SPY自動巡回の初期化
      initSpyRotation(); // 他社SPYローテーション初期化
      if (spyEnabled) startScreenshotCapture(); // SW再起動時にSPY有効ならスクショ再開
      console.log('[LS-BG] 初期化完了 DM/Whisperポーリング開始');
      // SW再起動時: currentSessionIdが復元されていたらsessionsレコード存在チェック
      if (currentSessionId) {
        try {
          const checkRes = await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/sessions?session_id=eq.${encodeURIComponent(currentSessionId)}&select=session_id`,
            {
              headers: {
                'apikey': CONFIG.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${accessToken}`,
              },
            }
          );
          if (checkRes.ok) {
            const existing = await checkRes.json();
            if (existing.length === 0) {
              await insertSession(currentSessionId, accountId);
              console.log('[LS-BG] sessions復元INSERT:', currentSessionId);
            } else {
              console.log('[LS-BG] sessions既存確認OK:', currentSessionId);
            }
          }
        } catch (e) {
          console.warn('[LS-BG] sessions復元チェック失敗:', e.message);
        }
      }
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
            initAutoPatrol(); // SPY自動巡回の初期化
            initSpyRotation(); // 他社SPYローテーション初期化
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
  if (changes.auto_patrol_enabled) {
    autoPatrolEnabled = changes.auto_patrol_enabled.newValue !== false;
    console.log('[LS-BG] auto_patrol_enabled変更:', autoPatrolEnabled);
  }
  if (changes.spy_rotation_enabled) {
    spyRotationEnabled = changes.spy_rotation_enabled.newValue === true;
    console.log('[LS-BG] spy_rotation_enabled変更:', spyRotationEnabled);
  }
});

// ============================================================
// AutoCoinSync — 自動コイン同期トリガー
// ============================================================

/**
 * 自動コイン同期の統合エントリポイント
 * - 二重実行防止（isSyncing フラグ）
 * - 最終同期からの経過時間チェック
 * - 失敗時リトライ（30分後、最大3回）
 * @param {string} trigger - 発火元 ('periodic'|'after_stream'|'earnings_visit'|'retry')
 */
async function triggerAutoCoinSync(trigger = 'unknown') {
  // 二重実行防止
  if (isCoinSyncing) {
    console.log('[LS-BG] AutoCoinSync: 同期中 — スキップ (trigger:', trigger, ')');
    return;
  }

  // 認証チェック
  await loadAuth();
  if (!accountId || !accessToken) {
    console.log('[LS-BG] AutoCoinSync: 未認証 — スキップ (trigger:', trigger, ')');
    return;
  }

  // 最終同期からの経過時間チェック（1時間未満ならスキップ）
  const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1時間
  const syncStorageKey = `coin_sync_last_${accountId}`;
  const stored = await chrome.storage.local.get([syncStorageKey, 'last_coin_sync']);
  const lastSync = stored[syncStorageKey] || stored.last_coin_sync || null;
  if (lastSync) {
    const elapsed = Date.now() - new Date(lastSync).getTime();
    if (elapsed < MIN_INTERVAL_MS) {
      const minutesAgo = Math.round(elapsed / 60000);
      console.log(`[LS-BG] AutoCoinSync: 最終同期 ${minutesAgo}分前 — スキップ (trigger: ${trigger})`);
      return;
    }
  }

  console.log(`[LS-BG] AutoCoinSync: 実行開始 (trigger: ${trigger})`);
  isCoinSyncing = true;

  try {
    const result = await handleCoinSync();
    isCoinSyncing = false;
    coinSyncRetryCount = 0; // 成功 → リトライカウンタリセット

    if (result.ok) {
      console.log(`[LS-BG] AutoCoinSync: 成功 (trigger: ${trigger})`, result.message || `${result.synced}件`);
    } else {
      console.warn(`[LS-BG] AutoCoinSync: 失敗 (trigger: ${trigger})`, result.error);
      scheduleRetry();
    }
  } catch (err) {
    isCoinSyncing = false;
    console.error(`[LS-BG] AutoCoinSync: 例外 (trigger: ${trigger})`, err.message);
    scheduleRetry();
  }
}

function scheduleRetry() {
  coinSyncRetryCount++;
  if (coinSyncRetryCount <= COIN_SYNC_MAX_RETRIES) {
    const delayMin = COIN_SYNC_RETRY_DELAY_MS / 60000;
    console.log(`[LS-BG] AutoCoinSync: ${delayMin}分後にリトライ予約 (${coinSyncRetryCount}/${COIN_SYNC_MAX_RETRIES})`);
    chrome.alarms.create('coinSyncRetry', { delayInMinutes: delayMin });
  } else {
    console.warn(`[LS-BG] AutoCoinSync: リトライ上限到達 (${COIN_SYNC_MAX_RETRIES}回) — 次の定期同期まで待機`);
    coinSyncRetryCount = 0;
  }
}

// earningsページ訪問検出 → 最終同期から1時間以上なら自動実行
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;
  try {
    const url = new URL(tab.url);
    if (url.hostname.endsWith('stripchat.com') && url.pathname.startsWith('/earnings')) {
      console.log('[LS-BG] AutoCoinSync: earningsページ検出 tab=', tabId);
      triggerAutoCoinSync('earnings_visit').catch(e => {
        console.warn('[LS-BG] AutoCoinSync: earnings訪問トリガー失敗:', e.message);
      });
    }
  } catch (_) {
    // invalid URL — ignore
  }
});
