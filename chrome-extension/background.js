importScripts('config.js');

/**
 * Strip Live Spot - Background Service Worker
 * Auth管理、SPYメッセージリレー、認証Cookieエクスポート
 *
 * 修正: accountId null問題
 * - CHAT_MESSAGEはaccountId不在でも常にバッファ
 * - account_idはflush時にstorageから最新値を付与
 * - accountId未設定ならflushを保留（30秒ごとにリトライ）
 */

let accessToken = null;
let accountId = null;
let spyEnabled = false;
let currentSessionId = null; // SPYセッションID（spy_messages.session_id）

// UUID v4 フォーマット検証（session_id の stale値検出用）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let messageBuffer = [];
let bufferTimer = null;
let spyMsgCount = 0;
let viewerStatsBuffer = [];
let viewerStatsTimer = null;


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


// SPY自動巡回 状態管理
let autoPatrolEnabled = false;          // 自動巡回ON/OFF（storage: auto_patrol_enabled）
let monitoredCastStatus = {};           // { castName: 'public'|'offline'|... } — 前回ステータス
let autoPatrolTabs = {};                // { castName: tabId } — 自動オープンしたタブの追跡

// SPY他社ローテーション 状態管理
let spyRotationEnabled = false;         // 他社ローテーションON/OFF（storage: spy_rotation_enabled）
let spyRotationTabs = {};               // { castName: tabId } — ローテーションで開いたタブ
let ownCastNamesCache = new Set();      // registered_castsのみ（自社キャスト保護用）
let spyCastNamesCache = new Set();      // spy_castsのみ（ローテーション対象）
const MAX_SPY_ROTATION_TABS = 40;       // 同時オープンタブ上限

// スクリーンショット間隔キャッシュ: { castName: intervalMinutes } — 0=OFF
let screenshotIntervalCache = {};
let screenshotLastCapture = {};         // { castName: timestamp(ms) } — 前回撮影時刻



// ============================================================
// A.1: Service Worker Keepalive via chrome.alarms
// ============================================================
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('sessionCookieExport', { periodInMinutes: 30 }); // 30分ごと（認証cookie鮮度維持）
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
    // メモリ管理: 無制限オブジェクトの上限チェック
    cleanupUnboundedCollections();
  }



  // 認証cookie定期エクスポート（30分ごと）
  if (alarm.name === 'sessionCookieExport') {
    exportSessionCookie().catch(e => {
      console.warn('[LS-BG] SessionExport定期: 失敗:', e.message);
    });
  }


  // SPY自動巡回（3分ごと）
  if (alarm.name === 'spyAutoPatrol') {
    runAutoPatrol().catch(e => {
      console.warn('[LS-BG] AutoPatrol: 巡回エラー:', e.message);
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


  // スクリーンショット（CDN方式優先、フォールバックでcaptureVisibleTab）
  if (alarm.name === 'spy-screenshot') {
    captureAllThumbnailsCDN().catch(e => {
      console.warn('[LS-SPY] CDN thumbnail failed, falling back to captureVisibleTab:', e.message);
      captureAllSpyTabs().catch(e2 => console.warn('[LS-SPY] Screenshot fallback also failed:', e2.message));
    });
  }


  // Viewer member list polling（1分ごと、SPY有効時のみ）
  if (alarm.name === 'viewerMembers') {
    if (spyEnabled) {
      // 全登録キャスト（自社+SPY）のviewer memberリストを取得
      const castNames = [...registeredCastNames];
      (async () => {
        for (const cn of castNames) {
          await fetchViewerMembers(cn);
          // レート制限: 各キャスト間に2秒待機
          await new Promise(r => setTimeout(r, 2000));
        }
      })().catch(e => {
        console.warn('[LS-BG] viewerMembers alarm error:', e.message);
      });
    }
  }

  // セッション同期（1時間ごと）
  if (alarm.name === 'sessionSync') {
    exportSessionCookie().catch(e => {
      console.warn('[LS-BG] SessionSync: エクスポート失敗:', e.message);
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


// メモリ管理: 無制限オブジェクトのサイズ上限チェック
const COLLECTION_LIMITS = {
  autoPatrolTabs: 100,
  spyRotationTabs: 100,
  monitoredCastStatus: 200,
  screenshotIntervalCache: 200,
  screenshotLastCapture: 200,
};

function cleanupUnboundedCollections() {
  for (const [name, limit] of Object.entries(COLLECTION_LIMITS)) {
    const obj = { autoPatrolTabs, spyRotationTabs, monitoredCastStatus, screenshotIntervalCache, screenshotLastCapture }[name];
    if (!obj) continue;
    const keys = Object.keys(obj);
    if (keys.length > limit) {
      // 古い順に削除（FIFOで先頭から削除）
      const toDelete = keys.slice(0, keys.length - limit);
      for (const k of toDelete) delete obj[k];
      console.log(`[LS-BG] メモリ管理: ${name} ${toDelete.length}件削除 → ${Object.keys(obj).length}件`);
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
          `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&is_active=eq.true&select=cast_name,screenshot_interval,gc_rate_per_minute`,
          {
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        ),
        fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/spy_casts?account_id=eq.${accountId}&is_active=eq.true&select=cast_name,screenshot_interval,gc_rate_per_minute`,
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
        console.log('[LS-BG] キャスト名キャッシュ更新: 自社=', [...ownCastNamesCache],
          'SPY=', [...spyCastNamesCache],
          '合計=', registeredCastNames.size, '件');
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

/**
 * Cookie自動復元: token=falseの場合にVercelアプリドメインのSupabase認証cookieから
 * セッションを復元する。@supabase/ssr が設定する sb-{ref}-auth-token cookie を読み取り、
 * refresh_tokenでアクセストークンを取得してstorageに保存する。
 */
async function tryRecoverSessionFromCookie() {
  const PROJECT_REF = 'ujgbhkllfeacbgpdbjto';
  const COOKIE_PREFIX = `sb-${PROJECT_REF}-auth-token`;
  const APP_DOMAIN = 'livespot-rouge.vercel.app';

  try {
    // 1. まずrefresh_tokenがstorageにあればそちらを試行
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      console.log('[LS-BG] Cookie復元: refresh_tokenで復旧成功');
      return true;
    }

    // 2. Vercelアプリドメインからcookieを取得
    console.log('[LS-BG] Cookie復元: Vercelドメインからcookie取得試行...');
    const allCookies = await chrome.cookies.getAll({ domain: APP_DOMAIN });
    console.log('[LS-BG] Cookie復元: 取得cookie数=', allCookies.length);

    // sb-{ref}-auth-token (単体) or sb-{ref}-auth-token.0, .1, ... (チャンク)
    let authCookieValue = null;

    // 単体cookie
    const single = allCookies.find(c => c.name === COOKIE_PREFIX);
    if (single) {
      authCookieValue = single.value;
    } else {
      // チャンクcookie: .0, .1, .2, ... を結合
      const chunks = allCookies
        .filter(c => c.name.startsWith(COOKIE_PREFIX + '.'))
        .sort((a, b) => {
          const numA = parseInt(a.name.split('.').pop(), 10);
          const numB = parseInt(b.name.split('.').pop(), 10);
          return numA - numB;
        });
      if (chunks.length > 0) {
        authCookieValue = chunks.map(c => c.value).join('');
      }
    }

    if (!authCookieValue) {
      // localhostも試行（開発環境）
      const localCookies = await chrome.cookies.getAll({ domain: 'localhost' });
      const localSingle = localCookies.find(c => c.name === COOKIE_PREFIX);
      if (localSingle) {
        authCookieValue = localSingle.value;
      } else {
        const localChunks = localCookies
          .filter(c => c.name.startsWith(COOKIE_PREFIX + '.'))
          .sort((a, b) => {
            const numA = parseInt(a.name.split('.').pop(), 10);
            const numB = parseInt(b.name.split('.').pop(), 10);
            return numA - numB;
          });
        if (localChunks.length > 0) {
          authCookieValue = localChunks.map(c => c.value).join('');
        }
      }
    }

    if (!authCookieValue) {
      console.log('[LS-BG] Cookie復元: 認証cookieが見つからない');
      return false;
    }

    // 3. cookieをパース（base64 or JSON）
    let sessionData;
    try {
      // URLデコード → JSON
      sessionData = JSON.parse(decodeURIComponent(authCookieValue));
    } catch {
      try {
        // base64デコード → JSON
        sessionData = JSON.parse(atob(authCookieValue));
      } catch {
        try {
          // 直接JSONパース
          sessionData = JSON.parse(authCookieValue);
        } catch {
          console.warn('[LS-BG] Cookie復元: パース失敗');
          return false;
        }
      }
    }

    console.log('[LS-BG] Cookie復元: セッションデータ取得成功 keys=', Object.keys(sessionData));

    // 4. access_token と refresh_token を抽出
    const recoveredAccessToken = sessionData.access_token;
    const recoveredRefreshToken = sessionData.refresh_token;

    if (!recoveredAccessToken) {
      console.warn('[LS-BG] Cookie復元: access_tokenが含まれていない');
      return false;
    }

    // 5. refresh_tokenでフレッシュなトークンを取得（期限切れの可能性があるため）
    if (recoveredRefreshToken) {
      try {
        const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY },
          body: JSON.stringify({ refresh_token: recoveredRefreshToken }),
        });
        if (res.ok) {
          const result = await res.json();
          await chrome.storage.local.set({
            access_token: result.access_token,
            refresh_token: result.refresh_token,
          });
          accessToken = result.access_token;
          console.log('[LS-BG] Cookie復元: refresh_tokenで新トークン取得成功');

          // account_idも自動取得
          const accRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
            headers: {
              'apikey': CONFIG.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${result.access_token}`,
            },
          });
          if (accRes.ok) {
            const accData = await accRes.json();
            if (Array.isArray(accData) && accData.length > 0) {
              accountId = accData[0].id;
              await chrome.storage.local.set({ account_id: accountId });
              console.log('[LS-BG] Cookie復元: アカウント取得成功:', accountId, accData[0].account_name);
            }
          }
          return true;
        }
        console.warn('[LS-BG] Cookie復元: refresh_tokenでのリフレッシュ失敗:', res.status);
      } catch (e) {
        console.warn('[LS-BG] Cookie復元: リフレッシュ例外:', e.message);
      }
    }

    // 6. refresh失敗の場合、access_tokenを直接使用（有効期限内なら動作する）
    await chrome.storage.local.set({ access_token: recoveredAccessToken });
    if (recoveredRefreshToken) {
      await chrome.storage.local.set({ refresh_token: recoveredRefreshToken });
    }
    accessToken = recoveredAccessToken;
    console.log('[LS-BG] Cookie復元: access_tokenを直接復元');

    // account_id取得
    try {
      const accRes = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/accounts?select=id,account_name`, {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${recoveredAccessToken}`,
        },
      });
      if (accRes.ok) {
        const accData = await accRes.json();
        if (Array.isArray(accData) && accData.length > 0) {
          accountId = accData[0].id;
          await chrome.storage.local.set({ account_id: accountId });
          console.log('[LS-BG] Cookie復元: アカウント取得成功:', accountId, accData[0].account_name);
        }
      }
    } catch (e) {
      console.warn('[LS-BG] Cookie復元: アカウント取得失敗:', e.message);
    }

    return !!accessToken;
  } catch (e) {
    console.error('[LS-BG] Cookie復元: 予期しないエラー:', e.message);
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
  // キャスト別件数をログ出力（データフロー診断用）
  const castCounts = {};
  rows.forEach(r => { castCounts[r.cast_name] = (castCounts[r.cast_name] || 0) + 1; });
  console.log('[LS-BG] SPYメッセージ一括送信:', rows.length, '件 → Supabase REST API',
    `session_id: ${hasSessionId ? rows[0].session_id : 'NULL'}`,
    'casts:', JSON.stringify(castCounts));

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
      console.log('[LS-BG] SPYメッセージ一括送信成功:', rows.length, '件',
        'casts:', Object.keys(castCounts).join(','));

    } else {
      const errText = await res.text().catch(() => '');
      console.warn('[LS-BG] SPYメッセージ送信失敗:', res.status, errText,
        'casts:', Object.keys(castCounts).join(','));
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
    // cast_nameが空のレコードは除外（last_cast_nameフォールバックによるキャスト間混在を防止）
    const validBatch = batch.filter(s => s.cast_name && s.cast_name !== '');
    if (validBatch.length < batch.length) {
      console.warn('[LS-BG] viewer_stats: cast_name空のレコードを除外:', batch.length - validBatch.length, '件');
    }
    if (validBatch.length === 0) return;

    const rows = validBatch.map(s => ({
      account_id: accountId,
      cast_name: s.cast_name,
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
async function insertSession(sessionId, acctId, castNameArg) {
  if (!accessToken) return;

  // cast_nameは引数から取得（last_cast_nameフォールバックによる混在を防止）
  const castName = castNameArg || 'unknown';

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


  castSessions.delete(castName);
  castLastActivity.delete(castName);
  castBroadcastTitles.delete(castName);
  castSessionStarted.delete(castName);
  saveSessionState(); // SW再起動対策: 状態永続化
}

/**
 * GC（グループチャット）精算: 指定キャストの全アクティブGCを精算し、coin_transactionsにINSERT
 * castName指定: そのキャストの全GCを精算（group_end or セッション終了時）
 * castName省略: 全GCを精算（安全弁用）
 */


/**
 * C-3: チケットショー検出（簡易版）
 * 3件以上の同額チップが30秒以内に集中 → チケットショーと判定
 */

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
      console.log('[LS-BG] 未登録キャスト スキップ: cast=', castName,
        'registeredCastNames=', [...registeredCastNames].join(','));
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

    // session_id: per-cast sessionのみ使用（currentSessionIdフォールバック禁止 = 他キャスト混在防止）
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
      session_id: perCastSessionId,
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
    // cast_nameをバッファ時点で確定（flush時のlast_cast_nameフォールバックによる混在を防止）
    const bufferCastName = msg.cast_name || '';
    viewerStatsBuffer.push({
      total: msg.total,
      coin_users: msg.coin_users,
      others: msg.others,
      ultimate_count: msg.ultimate_count ?? null,
      coin_holders: msg.coin_holders ?? null,
      others_count: msg.others_count ?? null,
      recorded_at: msg.timestamp || new Date().toISOString(),
      cast_name: bufferCastName,
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





  // --- Popup: Get extension status ---
  if (msg.type === 'GET_STATUS') {
    loadAuth().then(async (auth) => {
      
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
        spyMsgCount,
        lastHeartbeat: lastHeartbeat || null,
        bufferSize: messageBuffer.length,
      };
      console.log('[LS-BG] GET_STATUS応答:', JSON.stringify(status));
      sendResponse(status);
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
        chrome.storage.local.get(['last_cast_name'], (d) => {
          insertSession(currentSessionId, accountId, d.last_cast_name).catch(e => {
            console.error('[LS-BG] sessions開始記録失敗:', e.message);
          });
        });
      }
      // スクリーンショットタイマー開始
      startScreenshotCapture();
      // Viewer member list ポーリング開始（1分ごと）
      chrome.alarms.create('viewerMembers', { periodInMinutes: 1 });
      // SPY開始時にもセッション同期
      exportSessionCookie().catch(e => console.warn('[LS-BG] SessionSync(SPY start):', e.message));
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
      // Viewer member list ポーリング停止
      chrome.alarms.clear('viewerMembers');

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

  // --- JWT captured from content_jwt_capture.js ---
  if (msg.type === 'JWT_CAPTURED') {
    handleJwtCaptured(msg);
    sendResponse({ ok: true });
    return false;
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

  // --- Popup: ログイン中キャスト検出 ---
  if (msg.type === 'GET_LOGGED_IN_CAST') {
    getLoggedInCastFromCookies().then(result => {
      sendResponse({ ok: true, ...result });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true; // async sendResponse
  }

  // --- Popup: AMP cookie クリーンアップ ---
  if (msg.type === 'CLEAR_CAST_COOKIES') {
    clearStripchatIdentityCookies().then(cleared => {
      sendResponse({ ok: true, cleared });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true; // async sendResponse
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
      `https://ja.stripchat.com/api/front/v2/models/username/${encodeURIComponent(castName)}/cam`,
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
        insertSession(currentSessionId, accountId, castName).catch(e => {
          console.error('[LS-BG] AutoPatrol: sessions開始記録失敗:', e.message);
        });

        // スクリーンショットタイマー開始
        startScreenshotCapture();
        // Viewer member list ポーリング開始（1分ごと）
        chrome.alarms.create('viewerMembers', { periodInMinutes: 1 });

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

/**
 * CDN方式: Stripchat公開APIからサムネイルURLを取得
 * captureVisibleTab不要 — タブを開かなくてもOK
 */
async function fetchThumbnail(username) {
  try {
    const res = await fetch(`https://stripchat.com/api/front/v2/models/username/${username}/cam`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const modelId = data?.user?.id;
    const snapshotTimestamp = data?.user?.snapshotTimestamp;
    if (!modelId || !snapshotTimestamp) return null;
    const thumbUrl = `https://img.doppiocdn.org/thumbs/${snapshotTimestamp}/${modelId}_webp`;
    return { thumbUrl, modelId, snapshotTimestamp, status: data?.user?.status || 'unknown' };
  } catch (err) {
    console.warn('[LS-SPY] fetchThumbnail failed:', username, err.message);
    return null;
  }
}

/**
 * CDN方式: 全監視キャストのサムネイルをCDN URLで保存
 * captureVisibleTabの代替 — タブ切り替え不要
 */
async function captureAllThumbnailsCDN() {
  if (!accessToken || !accountId) return;

  // 登録キャスト一覧を収集
  const castNames = [];
  if (registeredCastNames && registeredCastNames.size > 0) {
    for (const name of registeredCastNames) castNames.push(name);
  } else if (ownCastNamesCache && ownCastNamesCache.size > 0) {
    for (const name of ownCastNamesCache) castNames.push(name);
  }

  // SPY監視中のタブからもキャスト名を収集
  const EXCLUDE_PAGES = ['favorites', 'messages', 'settings', 'feed', 'members', 'login', 'signup', 'new', 'search', 'models', 'categories', '404'];
  try {
    const allTabs = await chrome.tabs.query({ url: ['*://stripchat.com/*', '*://*.stripchat.com/*'] });
    for (const tab of allTabs) {
      if (!tab.url) continue;
      const m = tab.url.match(/stripchat\.com\/([A-Za-z0-9_-]+)/);
      if (!m) continue;
      const name = m[1];
      if (!EXCLUDE_PAGES.includes(name) && !castNames.includes(name)) {
        castNames.push(name);
      }
    }
  } catch { /* tabs API not available */ }

  if (castNames.length === 0) return;

  console.log(`[LS-SPY] CDN Thumbnail: ${castNames.length}キャスト対象: ${castNames.join(', ')}`);

  for (const castName of castNames) {
    // キャスト別間隔チェック
    const interval = screenshotIntervalCache[castName];
    if (interval === undefined || interval === null || interval <= 0) continue;
    const lastCapture = screenshotLastCapture[castName] || 0;
    const elapsedMin = (Date.now() - lastCapture) / 60000;
    if (elapsedMin < interval) continue;

    const result = await fetchThumbnail(castName);
    if (!result) {
      console.log(`[LS-SPY] CDN Thumbnail: ${castName} — サムネイル取得失敗（オフライン or API変更）`);
      continue;
    }

    // メタデータをscreenshotsテーブルに保存（CDN URLのみ、Storageアップロード不要）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${castName}_cdn_${timestamp}.webp`;
    const sessionId = castSessions.get(castName) || null; // currentSessionIdフォールバック禁止 = 他キャスト混在防止

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
          storage_path: null,
          thumbnail_url: result.thumbUrl,
          captured_at: new Date().toISOString(),
        }),
      });
      if (metaRes.ok) {
        screenshotLastCapture[castName] = Date.now();
        console.log(`[LS-SPY] CDN Thumbnail saved: ${castName} status=${result.status}`);
      } else {
        console.warn(`[LS-SPY] CDN Thumbnail metadata failed: ${castName}`, metaRes.status);
      }
    } catch (err) {
      console.warn(`[LS-SPY] CDN Thumbnail error: ${castName}`, err.message);
    }

    await sleep_bg(500); // API rate limit
  }
}

function startScreenshotCapture() {
  chrome.alarms.get('spy-screenshot', (existing) => {
    if (!existing) {
      chrome.alarms.create('spy-screenshot', { periodInMinutes: 1 });
    }
  });
  // 即時キャプチャ（CDN方式優先）
  captureAllThumbnailsCDN().catch(e => console.warn('[LS-BG] Screenshot: CDN初回キャプチャ失敗:', e.message));
  console.log('[LS-SPY] Screenshot alarm registered (1分間隔, CDN方式優先)');
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
  const sessionId = castSessions.get(castName) || null; // currentSessionIdフォールバック禁止 = 他キャスト混在防止
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
// JWT Captured Handler — content_jwt_capture.js → content_spy.js → here
// ============================================================

/**
 * JWT取得ハンドラ: MAIN world content_jwt_capture.js → content_spy.js → ここ
 * stripchat_sessions.jwt_token に保存
 */
async function handleJwtCaptured(message) {
  const { jwt } = message;
  if (!jwt || !accountId || !accessToken) {
    console.log('[LS-BG] JWT received but no auth context');
    return;
  }

  try {
    // UPSERT: jwt_token カラムを更新
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?account_id=eq.${accountId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          jwt_token: jwt,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (res.ok) {
      console.log('[LS-BG] JWT saved to stripchat_sessions');
    } else {
      console.warn('[LS-BG] JWT save failed:', res.status);
    }
  } catch (err) {
    console.warn('[LS-BG] JWT save error:', err.message);
  }
}

// ============================================================
// Viewer Member List Polling (spy_viewers)
// ============================================================
let viewerMemberLastPoll = 0;
const VIEWER_MEMBER_INTERVAL = 60000; // 60秒

/**
 * fetchViewerMembers(castName)
 * Stripchat viewer member list APIを呼び出し、spy_viewersにUPSERT
 */
async function fetchViewerMembers(castName) {
  if (!accessToken || !accountId) return;

  try {
    // 1. JWT取得（stripchat_sessions から）
    const sessRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?account_id=eq.${accountId}&is_valid=eq.true&select=jwt_token,session_cookie,cookies_json`,
      {
        headers: {
          apikey: CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    if (!sessRes.ok) return;
    const sessions = await sessRes.json();
    if (!sessions.length) return;
    const sess = sessions[0];

    // 2. Viewer member list API 呼び出し
    const headers = {
      Accept: 'application/json',
    };

    // JWT認証（あれば）
    if (sess.jwt_token) {
      headers['Authorization'] = `Bearer ${sess.jwt_token}`;
    }

    // Cookie認証（フォールバック）
    if (sess.cookies_json && Object.keys(sess.cookies_json).length > 0) {
      headers['Cookie'] = Object.entries(sess.cookies_json)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    } else if (sess.session_cookie) {
      headers['Cookie'] = `stripchat_com_sessionId=${sess.session_cookie}`;
    }

    const membersRes = await fetch(
      `https://stripchat.com/api/front/models/username/${encodeURIComponent(castName)}/groupShow/members`,
      { headers }
    );

    if (!membersRes.ok) {
      if (membersRes.status === 401 || membersRes.status === 403) {
        console.warn('[LS-BG] Viewer members: JWT expired or unauthorized for', castName);
        // JWT無効化
        if (sess.jwt_token) {
          await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?account_id=eq.${accountId}`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                apikey: CONFIG.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${accessToken}`,
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({ jwt_token: null, updated_at: new Date().toISOString() }),
            }
          );
        }
      }
      return;
    }

    const data = await membersRes.json();
    const members = data?.members || data || [];
    if (!Array.isArray(members) || members.length === 0) return;

    // 3. spy_viewers に UPSERT（バッチ）
    const now = new Date().toISOString();
    // session_idはキャスト別キャッシュのみ使用（currentSessionIdフォールバック禁止 = 他キャスト混在防止）
    const perCastSessionId = castSessions.get(castName) || null;
    const rows = members.map(m => {
      // user_name: 複数フィールドを優先順に取得。空文字やnullは除外
      const rawName = m.username || m.userName || m.name || '';
      const userName = typeof rawName === 'string' ? rawName.trim() : String(rawName);
      return {
        account_id: accountId,
        cast_name: castName,
        session_id: perCastSessionId,
        user_name: userName || `anon_${m.id || 'unknown'}`,
        user_id_stripchat: m.id ? String(m.id) : (m.userId ? String(m.userId) : null),
        league: m.league || m.userLeague || null,
        level: m.level || m.userLevel || null,
        is_fan_club: m.isFanClub || m.fanClub || false,
        first_seen_at: now,
        last_seen_at: now,
        visit_count: 1,
      };
    });

    // spy_viewers: 個別 UPSERT（session_id NULLのUNIQUE制約問題を回避）
    let savedCount = 0;
    for (const r of rows) {
      try {
        // 既存レコードを検索（session_id NULL対応）
        const sessionFilter = r.session_id
          ? `session_id=eq.${encodeURIComponent(r.session_id)}`
          : 'session_id=is.null';
        const checkRes = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/spy_viewers?account_id=eq.${accountId}&cast_name=eq.${encodeURIComponent(r.cast_name)}&user_name=eq.${encodeURIComponent(r.user_name)}&${sessionFilter}&select=id,visit_count&limit=1`,
          {
            headers: {
              apikey: CONFIG.SUPABASE_ANON_KEY,
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );
        const existing = checkRes.ok ? await checkRes.json() : [];

        if (existing.length > 0) {
          // UPDATE: last_seen_at と visit_count を更新
          await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/spy_viewers?id=eq.${existing[0].id}`,
            {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                apikey: CONFIG.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${accessToken}`,
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({
                last_seen_at: now,
                visit_count: (existing[0].visit_count || 0) + 1,
                league: r.league,
                level: r.level,
                is_fan_club: r.is_fan_club,
                user_id_stripchat: r.user_id_stripchat || undefined,
              }),
            }
          );
        } else {
          // INSERT
          await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/spy_viewers`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: CONFIG.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${accessToken}`,
                Prefer: 'return=minimal',
              },
              body: JSON.stringify(r),
            }
          );
        }
        savedCount++;
      } catch (e) {
        console.warn('[LS-BG] spy_viewers row error:', r.user_name, e.message);
      }
    }
    console.log(`[LS-BG] spy_viewers: ${savedCount}/${rows.length} members saved for ${castName}`);
  } catch (err) {
    console.warn('[LS-BG] fetchViewerMembers error:', err.message);
  }
}

// ============================================================
// Session Cookie Export — Stripchatセッション情報をSupabaseに同期
// ============================================================

/**
 * Stripchatセッションクッキーと認証情報をSupabaseにエクスポート
 * DM API送信で使用するセッション情報を保存
 */
async function exportSessionCookie() {
  if (!accessToken || !accountId) {
    console.log('[LS-BG] SessionExport: accessToken or accountId missing, skipping');
    return;
  }

  try {
    // 1. Stripchat sessionId クッキー取得
    const sessionCookie = await chrome.cookies.get({
      url: 'https://stripchat.com',
      name: 'stripchat_com_sessionId'
    });
    if (!sessionCookie || !sessionCookie.value) {
      console.warn('[LS-BG] SessionExport: sessionId cookie not found');
      return;
    }

    // 2. userId クッキー取得（Cookie → API /initial-dynamic フォールバック）
    const userIdCookie = await chrome.cookies.get({
      url: 'https://stripchat.com',
      name: 'stripchat_com_userId'
    });
    let stripchatUserId = userIdCookie?.value || null;

    // 3. 全Stripchatクッキーを取得してJSON化
    const allCookies = await chrome.cookies.getAll({ domain: '.stripchat.com' });
    const cookiesJson = {};
    for (const c of allCookies) {
      cookiesJson[c.name] = c.value;
    }

    // 3.5. userId が Cookie から取れなかった場合、API で取得
    if (!stripchatUserId) {
      const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
      try {
        // 方法A: /initial-dynamic API
        const dynRes = await fetch('https://stripchat.com/api/front/v2/initial-dynamic?requestType=initial', {
          headers: {
            'Accept': 'application/json',
            'Cookie': cookieStr,
          },
        });
        if (dynRes.ok) {
          const dynData = await dynRes.json();
          const dynUid = dynData?.initialDynamic?.user?.id || dynData?.user?.id;
          if (dynUid && dynUid > 0) {
            stripchatUserId = String(dynUid);
            console.log('[LS-BG] SessionExport: /initial-dynamic からuserId取得:', stripchatUserId);
          }
        }
      } catch (e) {
        console.warn('[LS-BG] SessionExport: /initial-dynamic 失敗:', e.message);
      }
    }

    // 3.6. Stripchatタブの content script 経由でuserIdを取得（最終フォールバック）
    if (!stripchatUserId) {
      try {
        const tabs = await chrome.tabs.query({ url: '*://*.stripchat.com/*' });
        if (tabs.length > 0) {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: () => {
              try {
                const m = document.cookie.match(/stripchat_com_userId=(\d+)/);
                if (m) return m[1];
                // __NEXT_DATA__ fallback
                const nd = window.__NEXT_DATA__;
                if (nd?.props?.pageProps?.user?.id) return String(nd.props.pageProps.user.id);
              } catch { /* */ }
              return null;
            },
          });
          if (result?.result) {
            stripchatUserId = result.result;
            console.log('[LS-BG] SessionExport: content script からuserId取得:', stripchatUserId);
          }
        }
      } catch (e) {
        console.warn('[LS-BG] SessionExport: content script userId取得失敗:', e.message);
      }
    }

    // 4. csrfToken取得を試行（/api/front/v2/config から）
    let csrfToken = null;
    let csrfTimestamp = null;
    let frontVersion = '11.5.57';
    try {
      const configRes = await fetch('https://ja.stripchat.com/api/front/v2/config', {
        headers: {
          'Accept': 'application/json',
          'Cookie': `stripchat_com_sessionId=${sessionCookie.value}`,
        },
      });
      if (configRes.ok) {
        const configData = await configRes.json();
        csrfToken = configData?.csrfToken || configData?.config?.csrfToken || null;
        csrfTimestamp = configData?.csrfTimestamp || configData?.config?.csrfTimestamp || null;
        frontVersion = configData?.frontVersion || configData?.config?.frontVersion || frontVersion;
        console.log('[LS-BG] SessionExport: config取得成功, csrf:', !!csrfToken, 'frontVersion:', frontVersion);
      }
    } catch (e) {
      console.warn('[LS-BG] SessionExport: config取得失敗:', e.message);
    }

    // 5. Supabaseにupsert
    const expiresAt = sessionCookie.expirationDate
      ? new Date(sessionCookie.expirationDate * 1000).toISOString()
      : null;

    const body = {
      account_id: accountId,
      session_cookie: sessionCookie.value,
      csrf_token: csrfToken,
      csrf_timestamp: csrfTimestamp,
      stripchat_user_id: stripchatUserId,
      front_version: frontVersion,
      cookies_json: cookiesJson,
      is_valid: true,
      last_validated_at: new Date().toISOString(),
      exported_at: new Date().toISOString(),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    };

    const upsertRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?on_conflict=account_id`,
      {
        method: 'POST',
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(body),
      }
    );

    if (upsertRes.ok) {
      console.log('[LS-BG] SessionExport: セッション同期完了',
        `userId=${stripchatUserId}, csrf=${!!csrfToken}, expires=${expiresAt || 'unknown'}`);
    } else {
      const errText = await upsertRes.text().catch(() => '');
      console.warn('[LS-BG] SessionExport: upsert失敗:', upsertRes.status, errText);
    }

    // ── 方式B: Backend API に cookies.json 書き出し ──
    // collector/auth.py が Chrome DBロックなしで読める
    try {
      const cookieSyncRes = await fetch(`${CONFIG.API_BASE_URL}/api/sync/cookies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          account_id: accountId,
          cookies: cookiesJson,
        }),
      });
      if (cookieSyncRes.ok) {
        const result = await cookieSyncRes.json();
        console.log(`[LS-BG] CookieSync: cookies.json 書き出し完了 (${result.cookie_count}件)`);
      } else {
        console.warn('[LS-BG] CookieSync: 書き出し失敗:', cookieSyncRes.status);
      }
    } catch (cookieErr) {
      // Backend未起動時は静かに失敗（Supabase同期は成功済み）
      console.debug('[LS-BG] CookieSync: Backend未到達:', cookieErr.message);
    }
  } catch (err) {
    console.error('[LS-BG] SessionExport: エラー:', err.message);
  }
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


      loadRegisteredCasts();
      initAutoPatrol(); // SPY自動巡回の初期化
      initSpyRotation(); // 他社SPYローテーション初期化
      if (spyEnabled) {
        startScreenshotCapture(); // SW再起動時にSPY有効ならスクショ再開
        chrome.alarms.create('viewerMembers', { periodInMinutes: 1 }); // Viewer memberポーリング再開
      }
      // セッション同期 + Cookie書き出し: 30分ごと + 即時1回
      chrome.alarms.create('sessionSync', { periodInMinutes: 30 });
      exportSessionCookie().catch(e => console.warn('[LS-BG] SessionSync初回:', e.message));
      console.log('[LS-BG] 初期化完了 SPY/Auth機能起動');
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
              const restoreData = await chrome.storage.local.get(['last_cast_name']);
              await insertSession(currentSessionId, accountId, restoreData.last_cast_name);
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
      console.log('[LS-BG] 初期化完了 認証待ち → cookie自動復元を試行');
      const recovered = await tryRecoverSessionFromCookie();
      if (recovered) {
        await loadAuth();
        if (accessToken && accountId) {
    
    
          loadRegisteredCasts();
          initAutoPatrol();
          initSpyRotation();
          chrome.alarms.create('sessionSync', { periodInMinutes: 30 });
          exportSessionCookie().catch(e => console.warn('[LS-BG] SessionSync初回:', e.message));
          console.log('[LS-BG] Cookie復元成功 → 全機能起動');
        }
      }
    }
  });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.access_token || changes.account_id) {
    console.log('[LS-BG] Storage変更検出: access_token変更=', !!changes.access_token, 'account_id変更=', !!changes.account_id);
    loadAuth().then(() => {
      console.log('[LS-BG] Storage変更後の状態: token=', !!accessToken, 'account=', accountId);
      if (accessToken && accountId) {
  
  
        loadRegisteredCasts();
        // バッファflush試行
        if (messageBuffer.length > 0) {
          console.log('[LS-BG] Storage変更でaccountId取得 → バッファflush試行:', messageBuffer.length, '件');
          flushMessageBuffer();
        }
      } else {


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
