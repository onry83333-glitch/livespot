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
      _monitoredCastStatus: monitoredCastStatus,
    });
    console.log('[LS-BG] セッション状態保存:', castSessions.size, '件');
  } catch (e) {
    console.warn('[LS-BG] セッション状態保存失敗:', e.message);
  }
}

async function restoreSessionState() {
  try {
    const { _castSessions, _castLastActivity, _castSessionStarted, _monitoredCastStatus } = await chrome.storage.local.get([
      '_castSessions', '_castLastActivity', '_castSessionStarted', '_monitoredCastStatus',
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
    if (_monitoredCastStatus && typeof _monitoredCastStatus === 'object') {
      monitoredCastStatus = _monitoredCastStatus;
    }
    console.log('[LS-BG] セッション状態復元:', castSessions.size, '件, 巡回状態:', Object.keys(monitoredCastStatus).length, '件');
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

// DM API送信: 状態管理 + 安全機構
let dmProcessing = false;
let dmPollingTimer = null;
let dmApiConsecutiveErrors = 0;
let dmApiCooldownUntil = 0;
const DM_API_MAX_CONSECUTIVE_ERRORS = 5;
const DM_API_COOLDOWN_403 = 5 * 60 * 1000;   // 403時: 5分クールダウン
const DM_API_COOLDOWN_429 = 10 * 60 * 1000;  // 429時: 10分クールダウン
const DM_TEST_MODE = false;                    // true時はホワイトリスト以外をブロック
const DM_WHITELIST = ['pojipojipoji', 'kantou1234', 'Nekomeem34'];



// ============================================================
// A.1: Service Worker Keepalive via chrome.alarms
// ============================================================
// ユーティリティ: Promise-based sleep
function sleep_bg(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      is_vip: !!msg.is_vip,
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
      // API確認してからクローズ（メッセージ途絶≠配信終了）
      checkCastOnlineStatus(castName).then(status => {
        if (!isStreamingStatus(status)) {
          console.log('[LS-BG] 配信終了検出(5分タイムアウト+API確認):', castName, 'status=', status);
          closeCastSession(castName).catch(e => {
            console.warn('[LS-BG] closeCastSession失敗:', castName, e.message);
          });
        } else {
          // まだ配信中 → タイムスタンプを更新して誤クローズ防止
          castLastActivity.set(castName, Date.now());
          console.log('[LS-BG] 5分無活動だが配信中:', castName, 'status=', status);
        }
      }).catch(e => {
        console.warn('[LS-BG] checkBroadcastEnd API確認失敗:', castName, e.message);
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
    // トークン更新後にセッション同期 + CSRF再保存を実行
    if (accessToken && accountId) {
      exportSessionCookie().catch(e => console.warn('[LS-BG] AUTH_UPDATED → SessionSync失敗:', e.message));
      if (cachedCsrfToken) {
        _saveCsrfToDb(cachedCsrfToken, cachedCsrfTimestamp, false)
          .catch(e => console.warn('[LS-BG] AUTH_UPDATED → CSRF再保存失敗:', e.message));
      }
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

  // --- CSRF captured from content_jwt_capture.js ---
  if (msg.type === 'CSRF_CAPTURED') {
    handleCsrfCaptured(msg);
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

  // --- Content Script: コイン取引バッチ（ストリーミングUPSERT） ---
  if (msg.type === 'COIN_BATCH') {
    // content_coin_sync.jsから随時送られるバッチをUPSERTキューに追加
    const txs = msg.transactions || [];
    if (txs.length > 0 && _coinStreamState.active) {
      _coinStreamState.totalReceived += txs.length;
      _coinStreamUpsertQueue(txs);
    }
    sendResponse({ ok: true, queued: txs.length });
    return false;
  }

  // --- Popup: Earnings同期 ---
  if (msg.type === 'SYNC_EARNINGS') {
    handleSyncEarnings(msg.castName, msg.fromDate).then(result => {
      sendResponse({ ok: true, ...result });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true; // async sendResponse
  }

  return false;
});

// ============================================================
// コインストリーミングUPSERT — content scriptから随時バッチ受信してDB保存
// ============================================================
const _coinStreamState = {
  active: false,
  accountId: null,
  castName: null,
  serviceRoleKey: null,
  totalReceived: 0,
  totalSynced: 0,
  queue: [],
  processing: false,
};

async function _coinStreamUpsertQueue(newTxs) {
  const st = _coinStreamState;
  if (!st.active || !st.serviceRoleKey) return;

  st.queue.push(...newTxs);

  // 既にprocessing中なら追加分は次回に処理される
  if (st.processing) return;
  st.processing = true;

  try {
    while (st.queue.length > 0) {
      const BATCH = 500;
      const batch = st.queue.splice(0, BATCH);
      const rows = batch.map(tx => ({
        account_id: st.accountId,
        cast_name: st.castName,
        stripchat_tx_id: tx.id != null ? String(tx.id) : null,
        user_name: tx.userName || tx.user_name || tx.username || 'anonymous',
        tokens: Math.max(0, tx.tokens || tx.amount || 0),
        type: (tx.type || tx.sourceType || 'unknown').toLowerCase(),
        date: tx.date || tx.created_at || tx.createdAt || new Date().toISOString(),
        is_anonymous: tx.isAnonymous ? true : false,
      }));

      try {
        const res = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/coin_transactions?on_conflict=account_id,stripchat_tx_id`,
          {
            method: 'POST',
            headers: {
              'apikey': st.serviceRoleKey,
              'Authorization': `Bearer ${st.serviceRoleKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(rows),
          },
        );
        if (res.ok || res.status === 201) {
          st.totalSynced += rows.length;
          console.log(`[LS-BG] [stream] UPSERT成功: ${rows.length}件（累計 ${st.totalSynced}件）`);
        } else {
          const errBody = await res.text().catch(() => '');
          console.warn(`[LS-BG] [stream] UPSERT失敗: ${res.status}`, errBody);
        }
      } catch (e) {
        console.error(`[LS-BG] [stream] UPSERT error:`, e.message);
      }
    }
  } finally {
    st.processing = false;
  }
}

// ============================================================
// handleSyncEarnings — content script経由でEarnings API取得 → Supabase UPSERT
// ============================================================
async function handleSyncEarnings(castName, fromDate) {
  if (!castName) throw new Error('castName が未設定');
  if (!accountId) throw new Error('accountId が未設定（アカウントを選択してください）');

  // 1. Stripchatタブを探す（earningsページ優先）
  let targetTab;
  const earningsTabs = await chrome.tabs.query({
    url: ['*://stripchat.com/earnings/*', '*://*.stripchat.com/earnings/*'],
  });
  if (earningsTabs.length > 0) {
    targetTab = earningsTabs[0];
    console.log('[LS-BG] Earnings同期: 既存earningsタブ使用 tab=', targetTab.id);
  } else {
    const scTabs = await chrome.tabs.query({
      url: ['*://stripchat.com/*', '*://*.stripchat.com/*'],
    });
    if (scTabs.length === 0) {
      throw new Error('Stripchatのタブが開かれていません。Stripchatを開いてログインしてください');
    }
    targetTab = scTabs[0];
    console.log('[LS-BG] Earnings同期: Stripchatタブをearningsページへ遷移 tab=', targetTab.id);
    await chrome.tabs.update(targetTab.id, {
      url: 'https://ja.stripchat.com/earnings/tokens-history',
    });
    // ページロード完了待ち
    await new Promise((resolve) => {
      const check = setInterval(async () => {
        try {
          const t = await chrome.tabs.get(targetTab.id);
          if (t.status === 'complete') { clearInterval(check); resolve(); }
        } catch { clearInterval(check); resolve(); }
      }, 500);
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });
    await new Promise(r => setTimeout(r, 3000)); // DOM安定待ち
  }

  // 2. content_coin_sync.js を動的注入（manifest.jsonで既に注入されている場合はPINGで確認）
  let scriptReady = false;
  try {
    const pong = await chrome.tabs.sendMessage(targetTab.id, { type: 'COIN_SYNC_PING' });
    if (pong && pong.pong) scriptReady = true;
  } catch { /* not injected yet */ }

  if (!scriptReady) {
    console.log('[LS-BG] Earnings同期: content_coin_sync.js を動的注入');
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      files: ['content_coin_sync.js'],
    });
    await new Promise(r => setTimeout(r, 1000));
  }

  // 3. Service Role Key 取得（ストリーミングUPSERT用に先に取得）
  const storageData = await chrome.storage.local.get(['service_role_key']);
  const SERVICE_ROLE_KEY = storageData.service_role_key;
  if (!SERVICE_ROLE_KEY) {
    throw new Error('Service Role Key が未設定です。Chrome拡張のポップアップ設定から入力してください');
  }

  // 4. ストリーミングUPSERT状態を初期化（COIN_BATCHハンドラが使用）
  _coinStreamState.active = true;
  _coinStreamState.accountId = accountId;
  _coinStreamState.castName = castName;
  _coinStreamState.serviceRoleKey = SERVICE_ROLE_KEY;
  _coinStreamState.totalReceived = 0;
  _coinStreamState.totalSynced = 0;
  _coinStreamState.queue = [];
  _coinStreamState.processing = false;

  // 5. 差分同期: coin_transactionsのMAX(date)を取得してsinceISOに使用
  let sinceISO = fromDate || null;
  try {
    const maxDateRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/coin_transactions?account_id=eq.${accountId}&cast_name=eq.${encodeURIComponent(castName)}&select=date&order=date.desc&limit=1`,
      {
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (maxDateRes.ok) {
      const rows = await maxDateRes.json();
      if (rows.length > 0 && rows[0].date) {
        sinceISO = rows[0].date;
        console.log('[LS-BG] 差分同期: MAX(date)=', sinceISO);
      } else {
        console.log('[LS-BG] 初回同期: coin_transactionsにデータなし → 365日分取得');
        sinceISO = null;
      }
    }
  } catch (e) {
    console.warn('[LS-BG] MAX(date)取得失敗（フォールバック: 365日分取得）:', e.message);
    sinceISO = null;
  }
  console.log('[LS-BG] Earnings同期: FETCH_COINS送信（ストリーミングモード） sinceISO=', sinceISO);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Earnings取得タイムアウト（30分）')), 30 * 60 * 1000);
      chrome.tabs.sendMessage(
        targetTab.id,
        { type: 'FETCH_COINS', options: { sinceISO } },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('content scriptから応答なし'));
            return;
          }
          resolve(response);
        },
      );
    });
  } finally {
    // ストリーミング終了 — 残りのキューを処理してから無効化
    if (_coinStreamState.queue.length > 0) {
      await _coinStreamUpsertQueue([]);
    }
    // processing完了を待つ（最大10秒）
    for (let i = 0; i < 20 && _coinStreamState.processing; i++) {
      await new Promise(r => setTimeout(r, 500));
    }
    _coinStreamState.active = false;
  }

  if (result.error) {
    throw new Error(result.message || result.error);
  }

  const totalFetched = result.totalFetched || 0;
  const totalSynced = _coinStreamState.totalSynced;
  console.log(`[LS-BG] Earnings同期完了: 取得=${totalFetched}件, UPSERT=${totalSynced}件`);

  if (totalFetched === 0) {
    return { synced: 0, totalTokens: 0, fetched: 0 };
  }

  // 6. paying users があればpaid_usersテーブルにUPSERT
  let puSynced = 0;
  if (result.payingUsers && result.payingUsers.length > 0) {
    console.log(`[LS-BG] 有料ユーザー ${result.payingUsers.length}名のUPSERT開始`);

    const now = new Date().toISOString();
    const puRows = result.payingUsers
      .filter(u => (u.username || u.userName) && u.userId)
      .map(u => {
        const userName = u.username || u.userName || '';
        return {
          account_id: accountId,
          cast_name: castName,
          user_name: userName,
          total_coins: u.totalTokens || 0,
          last_payment_date: u.lastPaid || null,
          user_id_stripchat: String(u.userId),
          profile_url: `https://stripchat.com/user/${userName}`,
          updated_at: now,
        };
      });

    const BATCH = 500;
    for (let i = 0; i < puRows.length; i += BATCH) {
      const batch = puRows.slice(i, i + BATCH);
      try {
        const res = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/paid_users?on_conflict=account_id,user_name`,
          {
            method: 'POST',
            headers: {
              'apikey': SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(batch),
          },
        );
        if (res.ok || res.status === 201) {
          puSynced += batch.length;
        } else {
          const errBody = await res.text().catch(() => '');
          console.warn('[LS-BG] paid_users UPSERT失敗:', res.status, errBody);
        }
      } catch (e) {
        console.error('[LS-BG] paid_users UPSERT error:', e.message);
      }
    }
    console.log(`[LS-BG] 有料ユーザー同期完了: ${puSynced}/${puRows.length}名`);
  }

  return { synced: totalSynced, totalTokens: 0, fetched: totalFetched, pages: result.pages || 0, payingUsers: puSynced };
}

// ============================================================
// getLoggedInCastFromCookies — CookieからログインキャストのStripchat IDを取得
// ============================================================
async function getLoggedInCastFromCookies() {
  // 1. stripchat_com_userId Cookie取得
  const allCookies = await chrome.cookies.getAll({ domain: '.stripchat.com' });
  const userIdValues = new Set();
  for (const c of allCookies) {
    if (c.name === 'stripchat_com_userId' && c.value) {
      userIdValues.add(c.value);
    }
  }

  // userId が取れない場合: AMP cookieフォールバック
  if (userIdValues.size === 0) {
    for (const c of allCookies) {
      if (!c.name.startsWith('AMP_')) continue;
      try {
        let decoded = atob(c.value);
        if (decoded.includes('%7B') || decoded.includes('%22')) {
          decoded = decodeURIComponent(decoded);
        }
        const ampJson = JSON.parse(decoded);
        if (ampJson.userId) {
          userIdValues.add(String(ampJson.userId));
          console.log('[LS-BG] getLoggedInCast: AMP cookieからuserId取得:', ampJson.userId);
          break;
        }
      } catch { /* ignore non-JSON AMP cookies */ }
    }
  }

  if (userIdValues.size === 0) {
    return { userId: null, castName: null };
  }

  // 複数userId検出（複数アカウントが混在）
  const allUserIds = [...userIdValues];
  if (allUserIds.length > 1) {
    return { multipleDetected: true, allUserIds };
  }

  const userId = allUserIds[0];

  // 2. registered_casts から stripchat_user_id で照合
  const token = accessToken;
  if (!token || !accountId) {
    return { userId, castName: null };
  }

  try {
    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&is_active=eq.true&select=cast_name,stripchat_user_id`,
      {
        headers: {
          'apikey': CONFIG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
      }
    );
    if (!res.ok) {
      return { userId, castName: null };
    }

    const casts = await res.json();
    const matched = casts.find(c => String(c.stripchat_user_id) === String(userId));

    return {
      userId,
      castName: matched?.cast_name || null,
      displayName: matched?.cast_name || null,
      allCasts: casts,
    };
  } catch (e) {
    console.warn('[LS-BG] getLoggedInCastFromCookies: registered_casts照合失敗:', e.message);
    return { userId, castName: null };
  }
}

// ============================================================
// clearStripchatIdentityCookies — Stripchat認証Cookieをクリア
// ============================================================
async function clearStripchatIdentityCookies() {
  const cookieNames = [
    'stripchat_com_userId',
    'stripchat_com_sessionId',
    'AMP',
  ];
  const cleared = [];
  for (const name of cookieNames) {
    try {
      await chrome.cookies.remove({ url: 'https://stripchat.com', name });
      cleared.push(name);
    } catch (e) {
      // Cookie が存在しない場合は無視
    }
  }
  console.log('[LS-BG] clearStripchatIdentityCookies: クリア完了', cleared);
  return cleared;
}

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

  // キャッシュが空または5分以上経過ならリロード
  if (registeredCastNames.size === 0 || (Date.now() - (runAutoPatrol._lastCacheLoad || 0)) > 5 * 60 * 1000) {
    const oldCache = new Set(registeredCastNames);
    await loadRegisteredCasts();
    runAutoPatrol._lastCacheLoad = Date.now();
    // ロード失敗時は古いキャッシュを復元
    if (registeredCastNames.size === 0 && oldCache.size > 0) {
      registeredCastNames = oldCache;
    }
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
    scheduleSessionStateSave();

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

/**
 * CSRF取得ハンドラ: MAIN world content_jwt_capture.js → content_spy.js → ここ
 * メモリに保持 + stripchat_sessions に即時保存
 */
let cachedCsrfToken = null;
let cachedCsrfTimestamp = null;

async function handleCsrfCaptured(message) {
  const { csrfToken, csrfTimestamp } = message;
  if (!csrfToken) return;

  // メモリに保持（exportSessionCookieのupsert時に使用）
  cachedCsrfToken = csrfToken;
  cachedCsrfTimestamp = csrfTimestamp || null;
  console.log('[LS-BG] CSRF cached in memory');

  if (!accountId || !accessToken) {
    console.log('[LS-BG] CSRF cached but no auth context for DB save');
    return;
  }

  // 即時DB保存（401時はトークンリフレッシュしてリトライ）
  await _saveCsrfToDb(csrfToken, csrfTimestamp, false);
}

async function _saveCsrfToDb(csrfToken, csrfTimestamp, isRetry) {
  try {
    const body = {
      csrf_token: csrfToken,
      updated_at: new Date().toISOString(),
    };
    if (csrfTimestamp) body.csrf_timestamp = csrfTimestamp;

    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?account_id=eq.${accountId}&cast_name=not.is.null`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: CONFIG.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
      }
    );

    if (res.ok) {
      console.log('[LS-BG] CSRF saved to stripchat_sessions');
    } else if (res.status === 401 && !isRetry) {
      console.warn('[LS-BG] CSRF save 401 → トークンリフレッシュ試行');
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        await _saveCsrfToDb(csrfToken, csrfTimestamp, true);
      } else {
        console.error('[LS-BG] CSRF save: トークンリフレッシュ失敗。ポップアップで再ログインしてください。');
      }
    } else {
      console.warn('[LS-BG] CSRF save failed:', res.status);
    }
  } catch (err) {
    console.warn('[LS-BG] CSRF save error:', err.message);
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
    // 1. Stripchat sessionId クッキー取得（chrome.cookies.get → getAll フォールバック）
    let sessionCookie = await chrome.cookies.get({
      url: 'https://stripchat.com',
      name: 'stripchat_com_sessionId'
    });
    // domain違いで取得できない場合、getAllからフォールバック
    if (!sessionCookie || !sessionCookie.value) {
      const fallbackCookies = await chrome.cookies.getAll({ domain: '.stripchat.com' });
      const fbSession = fallbackCookies.find(c => c.name === 'stripchat_com_sessionId');
      if (fbSession) {
        sessionCookie = fbSession;
        console.log('[LS-BG] SessionExport: getAll fallback でsessionId取得');
      }
    }
    if (!sessionCookie || !sessionCookie.value) {
      console.warn('[LS-BG] SessionExport: sessionId cookie not found');
      return;
    }

    // 2. userId クッキー取得（Cookie → cookiesJson → AMP cookie → API フォールバック）
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

    // 3.1. cookiesJsonからuserIdを再取得（domain違いで chrome.cookies.get が取れない場合）
    if (!stripchatUserId && cookiesJson['stripchat_com_userId']) {
      stripchatUserId = cookiesJson['stripchat_com_userId'];
      console.log('[LS-BG] SessionExport: cookiesJsonからuserId取得:', stripchatUserId);
    }

    // 3.2. AMP cookie からuserIdを抽出（Stripchat仕様変更フォールバック）
    if (!stripchatUserId) {
      for (const ampKey of Object.keys(cookiesJson)) {
        if (!ampKey.startsWith('AMP_')) continue;
        try {
          let decoded = atob(cookiesJson[ampKey]);
          if (decoded.includes('%7B') || decoded.includes('%22')) {
            decoded = decodeURIComponent(decoded);
          }
          const ampJson = JSON.parse(decoded);
          if (ampJson.userId) {
            stripchatUserId = String(ampJson.userId);
            console.log('[LS-BG] SessionExport: AMP cookieからuserId取得:', stripchatUserId);
            break;
          }
        } catch { /* ignore non-JSON AMP cookies */ }
      }
    }

    // 3.5. userId / username を API で取得（キャスト別Cookie保存に必要）
    let stripchatUsername = null;
    {
      const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
      try {
        // /initial-dynamic API からuserId + username取得
        const dynRes = await fetch('https://stripchat.com/api/front/v2/initial-dynamic?requestType=initial', {
          headers: {
            'Accept': 'application/json',
            'Cookie': cookieStr,
          },
        });
        if (dynRes.ok) {
          const dynData = await dynRes.json();
          const dynUser = dynData?.initialDynamic?.user || dynData?.user;
          if (dynUser) {
            if (dynUser.id && dynUser.id > 0) {
              stripchatUserId = stripchatUserId || String(dynUser.id);
              console.log('[LS-BG] SessionExport: /initial-dynamic userId:', dynUser.id);
            }
            if (dynUser.username) {
              stripchatUsername = dynUser.username;
              console.log('[LS-BG] SessionExport: /initial-dynamic username:', stripchatUsername);
            }
          } else {
            console.warn('[LS-BG] SessionExport: /initial-dynamic user=null (isLogged=' + cookiesJson['isLogged'] + ')');
          }
        } else {
          console.warn('[LS-BG] SessionExport: /initial-dynamic HTTP', dynRes.status);
        }
      } catch (e) {
        console.warn('[LS-BG] SessionExport: /initial-dynamic 失敗:', e.message);
      }
    }

    // 3.5.1. username → registered_casts照合でcast_name決定
    let sessionCastName = null;
    if (stripchatUsername && ownCastNamesCache && ownCastNamesCache.size > 0) {
      // registered_castsのcast_nameと一致すればそのキャスト
      if (ownCastNamesCache.has(stripchatUsername)) {
        sessionCastName = stripchatUsername;
      }
    }
    // フォールバック: userIdでregistered_castsを検索
    if (!sessionCastName && stripchatUserId) {
      try {
        const rcRes = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&is_active=eq.true&or=(stripchat_model_id.eq.${stripchatUserId},stripchat_user_id.eq.${stripchatUserId})&select=cast_name&limit=1`,
          { headers: { 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` } }
        );
        if (rcRes.ok) {
          const rcData = await rcRes.json();
          if (rcData.length > 0) sessionCastName = rcData[0].cast_name;
        }
      } catch (e) {
        console.warn('[LS-BG] SessionExport: registered_casts照合失敗:', e.message);
      }
    }
    console.log('[LS-BG] SessionExport: cast_name=', sessionCastName || '(unknown)');

    // cast_name未解決の場合はupsertをスキップ（cast_name=nullレコードがis_valid=trueで
    // 書き込まれると、dm-serviceのmaybeSingle()が複数ヒットでエラーになるため）
    if (!sessionCastName) {
      console.warn('[LS-BG] SessionExport: cast_name未解決 — upsertスキップ（userId=' + stripchatUserId + ', username=' + stripchatUsername + '）');
      return;
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

    // 4. csrfToken は Content Script (content_jwt_capture.js) から
    //    handleCsrfCaptured() 経由で直接DBに保存される。
    //    ここでは /api/front/v2/config を叩かない（廃止済みで常に404）。
    let frontVersion = '11.5.57';

    // 5. Supabaseにupsert
    const expiresAt = sessionCookie.expirationDate
      ? new Date(sessionCookie.expirationDate * 1000).toISOString()
      : null;

    const body = {
      account_id: accountId,
      cast_name: sessionCastName,
      session_cookie: sessionCookie.value,
      front_version: frontVersion,
      cookies_json: cookiesJson,
      is_valid: true,
      last_validated_at: new Date().toISOString(),
      exported_at: new Date().toISOString(),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    };
    // null値でDB上の既存データを上書きしないよう、値があるフィールドのみ含める
    if (cachedCsrfToken) body.csrf_token = cachedCsrfToken;
    if (cachedCsrfTimestamp) body.csrf_timestamp = cachedCsrfTimestamp;
    if (stripchatUserId) body.stripchat_user_id = stripchatUserId;

    const upsertRes = await fetch(
      `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?on_conflict=account_id,cast_name`,
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
        `cast=${sessionCastName}, userId=${stripchatUserId}, csrf=${!!cachedCsrfToken}, expires=${expiresAt || 'unknown'}`);
    } else if (upsertRes.status === 401) {
      console.warn('[LS-BG] SessionExport: upsert 401 → トークンリフレッシュ試行');
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        // リトライ（1回のみ）
        const retryRes = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/stripchat_sessions?on_conflict=account_id,cast_name`,
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
        if (retryRes.ok) {
          console.log('[LS-BG] SessionExport: リトライ成功',
            `cast=${sessionCastName}, userId=${stripchatUserId}, csrf=${!!cachedCsrfToken}`);
        } else {
          const retryErr = await retryRes.text().catch(() => '');
          console.error('[LS-BG] SessionExport: リトライも失敗:', retryRes.status, retryErr);
        }
      } else {
        console.error('[LS-BG] SessionExport: トークンリフレッシュ失敗。ポップアップで再ログインしてください。');
      }
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
      startDMPolling(); // DM送信ポーリング開始
      console.log('[LS-BG] 初期化完了 SPY/Auth/DM機能起動');
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
          startDMPolling();
          console.log('[LS-BG] Cookie復元成功 → 全機能起動(DM含む)');
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

// ============================================================
// DM API送信 — Chrome拡張から直接Stripchat APIを叩く
// ============================================================

/**
 * DMキューからタスクを1件取得（30秒グレースピリオド付き）
 */
async function fetchNextDMTask() {
  await loadAuth();
  if (!accountId || !accessToken) return null;

  const graceThreshold = new Date(Date.now() - 30 * 1000).toISOString();
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`
    + `?account_id=eq.${accountId}&status=eq.queued`
    + `&created_at=lt.${encodeURIComponent(graceThreshold)}`
    + `&order=created_at.asc&limit=1`
    + `&select=id,user_name,profile_url,message,campaign,target_user_id,image_url,send_order,cast_name`;

  const res = await fetch(url, {
    headers: { 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
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
 * DMキューからバッチ取得
 */
async function fetchDMBatch(limit = 50) {
  await loadAuth();
  if (!accountId || !accessToken) return [];

  const graceThreshold = new Date(Date.now() - 30 * 1000).toISOString();
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`
    + `?account_id=eq.${accountId}&status=eq.queued`
    + `&created_at=lt.${encodeURIComponent(graceThreshold)}`
    + `&order=created_at.asc&limit=${limit}`
    + `&select=id,user_name,profile_url,message,campaign,target_user_id,image_url,send_order,cast_name`;

  const res = await fetch(url, {
    headers: { 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
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
  const tasks = Array.isArray(data) ? data : [];
  if (tasks.length === 0) return [];

  // ── アトミックロック: 取得したタスクを即座に 'sending' に更新 ──
  const ids = tasks.map(t => t.id);
  const lockUrl = `${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log`
    + `?id=in.(${ids.join(',')})`
    + `&status=eq.queued`;

  try {
    const lockRes = await fetch(lockUrl, {
      method: 'PATCH',
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ status: 'sending' }),
    });

    if (!lockRes.ok) {
      console.error('[LS-DM] ロック更新失敗:', lockRes.status);
      return [];
    }

    const locked = await lockRes.json();
    console.log(`[LS-DM] ${tasks.length}件取得 → ${locked.length}件ロック成功`);
    return Array.isArray(locked) ? locked : [];
  } catch (e) {
    console.error('[LS-DM] ロック例外:', e.message);
    return [];
  }
}

/**
 * dm_send_logのステータス更新
 */
async function updateDMTaskStatus(taskId, status, error, sentVia) {
  await loadAuth();
  if (!accessToken) return;

  const body = { status };
  if (error) body.error = typeof error === 'string' ? error.slice(0, 1000) : String(error).slice(0, 1000);
  if (status === 'success') body.sent_at = new Date().toISOString();
  if (sentVia) body.sent_via = sentVia;

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
    if (!res.ok && res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/dm_send_log?id=eq.${taskId}`, {
          method: 'PATCH',
          headers: {
            'apikey': CONFIG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(body),
        });
      }
    }
  } catch (e) {
    console.error('[LS-DM] ステータス更新例外:', e.message, 'taskId=', taskId);
  }
}

/**
 * DM送信間隔（4秒 ± 1.5秒ランダム）
 */
function getDMInterval() {
  const base = 4000;
  const jitter = (Math.random() - 0.5) * 3000;
  return Math.max(2000, base + jitter);
}

/**
 * タブ読み込み完了待ち
 */
function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    }, timeout);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(true);
      }
    }).catch(() => resolve(false));
  });
}

/**
 * __logger CSRF初期化待ち
 */
async function waitForPageLoad(tabId, maxWait = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => !!window.__logger?.kibanaLogger?.api?.csrfParams?.csrfToken,
      });
      if (results?.[0]?.result) {
        console.log('[LS-DM] __logger CSRF初期化完了', (Date.now() - start) + 'ms');
        return true;
      }
    } catch (e) { /* skip */ }
    await sleep_bg(500);
  }
  console.warn('[LS-DM] __logger CSRF初期化タイムアウト', maxWait + 'ms');
  return false;
}

// ============================================================
// DM安全ゲート（6層防御）
// ============================================================

/**
 * DM送信前の安全チェック。ブロック理由を返す。nullなら安全。
 */
function dmSafetyCheck(task) {
  // Gate 1: campaign必須
  const c = task.campaign || '';
  if (!c) return 'campaign未設定';

  // Gate 2: cast_name必須
  if (!task.cast_name) return 'cast_name未設定';

  // Gate 3: テストモード + ホワイトリスト
  if (DM_TEST_MODE && !DM_WHITELIST.includes(task.user_name)) {
    return `TEST MODE: ${task.user_name} はホワイトリスト外`;
  }

  // Gate 4: campaign形式チェック（正規UIフロー経由か）
  if (c !== 'TEST' && !(c.startsWith('pipe') || c.startsWith('seq') || c.startsWith('bulk') || c.includes('_sched_') || c.includes('_bulk_'))) {
    return `不正campaign形式: ${c}`;
  }

  return null; // 安全
}

/**
 * AMP cookieから複数ユーザーID検出ブロック
 * 複数アカウントが同じブラウザにログイン → 誤送信リスク
 */
async function checkAMPMultipleUsers() {
  try {
    const allCookies = await chrome.cookies.getAll({ domain: 'stripchat.com' });
    const userIds = new Set();
    for (const c of allCookies) {
      if (c.name.startsWith('AMP_') || c.name === 'baseAmpl') {
        try {
          let decoded = decodeURIComponent(atob(c.value));
          const match = decoded.match(/"userId"\s*:\s*"(\d+)"/);
          if (match) userIds.add(match[1]);
        } catch { /* skip */ }
      }
    }
    if (userIds.size > 1) {
      console.error('[LS-DM] AMP cookie複数ユーザー検出:', [...userIds], '→ DM送信ブロック');
      return true; // blocked
    }
  } catch { /* skip */ }
  return false;
}

// ============================================================
// tryDMviaAPI — ブラウザ内からStripchat APIを直接叩く
// ============================================================

async function tryDMviaAPI(task, tabId) {
  // クールダウン中
  if (Date.now() < dmApiCooldownUntil) {
    const remainSec = Math.ceil((dmApiCooldownUntil - Date.now()) / 1000);
    console.log('[LS-DM] クールダウン中 (残り', remainSec, '秒)');
    return null;
  }

  // 連続エラー上限
  if (dmApiConsecutiveErrors >= DM_API_MAX_CONSECUTIVE_ERRORS) {
    console.log('[LS-DM] 連続エラー', dmApiConsecutiveErrors, '回 → 停止');
    return null;
  }

  try {
    // ---- 1. myUserId (AMP cookie) ----
    let myUserId = null;
    const allCookies = await chrome.cookies.getAll({ domain: 'stripchat.com' });
    for (const c of allCookies) {
      if (c.name.startsWith('AMP_')) {
        try {
          const decoded = decodeURIComponent(atob(c.value));
          const match = decoded.match(/"userId"\s*:\s*"(\d+)"/);
          if (match) { myUserId = match[1]; break; }
        } catch { /* skip */ }
      }
    }
    if (!myUserId) {
      for (const c of allCookies) {
        if (c.name === 'baseAmpl') {
          try {
            const decoded = decodeURIComponent(c.value);
            const match = decoded.match(/"userId"\s*:\s*"(\d+)"/);
            if (match) { myUserId = match[1]; break; }
          } catch { /* skip */ }
        }
      }
    }
    if (!myUserId) {
      console.warn('[LS-DM] myUserId取得失敗');
      return null;
    }

    // ---- 1.5 キャスト身元照合 ----
    // registered_castsのstripchat_user_idとmyUserIdが一致するか確認
    if (task.cast_name && accountId && accessToken) {
      try {
        const rcRes = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/registered_casts?account_id=eq.${accountId}&cast_name=eq.${encodeURIComponent(task.cast_name)}&is_active=eq.true&select=stripchat_user_id,stripchat_model_id`,
          { headers: { 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` } }
        );
        if (rcRes.ok) {
          const rcRows = await rcRes.json();
          if (rcRows.length > 0) {
            const rc = rcRows[0];
            const expectedId = rc.stripchat_user_id || rc.stripchat_model_id;
            if (expectedId && String(expectedId) !== String(myUserId)) {
              console.error('[LS-DM] CAST_IDENTITY_MISMATCH: task.cast_name=', task.cast_name, 'expected=', expectedId, 'actual=', myUserId);
              return { success: false, error: `CAST_IDENTITY_MISMATCH: ログイン中=${myUserId}, 期待=${expectedId}` };
            }
          }
        }
      } catch (e) {
        console.warn('[LS-DM] キャスト身元照合失敗:', e.message);
      }
    }

    // ---- 2. targetUserId (DB解決) ----
    let targetUserId = task.target_user_id ? String(task.target_user_id) : null;

    if (!targetUserId && accountId && accessToken) {
      const headers = { 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` };
      const enc = encodeURIComponent(task.user_name);

      // spy_viewers
      try {
        const r1 = await fetch(
          `${CONFIG.SUPABASE_URL}/rest/v1/spy_viewers?account_id=eq.${accountId}&user_name=eq.${enc}&user_id_stripchat=not.is.null&select=user_id_stripchat&order=last_seen_at.desc&limit=1`,
          { headers }
        );
        if (r1.ok) {
          const rows = await r1.json();
          if (rows?.[0]?.user_id_stripchat) targetUserId = rows[0].user_id_stripchat;
        }
      } catch { /* fallthrough */ }

      // paid_users
      if (!targetUserId) {
        try {
          const r2 = await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/paid_users?account_id=eq.${accountId}&user_name=eq.${enc}&user_id_stripchat=not.is.null&select=user_id_stripchat&limit=1`,
            { headers }
          );
          if (r2.ok) {
            const rows = await r2.json();
            if (rows?.[0]?.user_id_stripchat) targetUserId = rows[0].user_id_stripchat;
          }
        } catch { /* fallthrough */ }
      }

      // coin_transactions
      if (!targetUserId) {
        try {
          const r3 = await fetch(
            `${CONFIG.SUPABASE_URL}/rest/v1/coin_transactions?account_id=eq.${accountId}&user_name=eq.${enc}&user_id=not.is.null&select=user_id&limit=1`,
            { headers }
          );
          if (r3.ok) {
            const rows = await r3.json();
            if (rows?.[0]?.user_id) targetUserId = String(rows[0].user_id);
          }
        } catch { /* fallthrough */ }
      }
    }

    if (!targetUserId) {
      console.warn('[LS-DM] targetUserId解決失敗:', task.user_name);
      return { success: false, error: `targetUserId解決失敗: ${task.user_name}` };
    }

    // ---- 3. 画像取得（必要な場合） ----
    const messageBody = (task.message || '').replace(/\{username\}/g, task.user_name || '');
    const imageUrl = task.image_url || null;
    const sendOrder = task.send_order || 'text_only';

    let imageBase64 = null;
    if (imageUrl && sendOrder !== 'text_only') {
      try {
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) throw new Error('HTTP ' + imgRes.status);
        const imgBlob = await imgRes.blob();
        const arrayBuf = await imgBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        imageBase64 = btoa(binary);
        console.log('[LS-DM] 画像取得成功:', (imageBase64.length / 1024).toFixed(1), 'KB');
      } catch (e) {
        console.error('[LS-DM] 画像取得失敗:', e.message, '→ text_onlyにフォールバック');
        imageBase64 = null;
      }
    }
    const effectiveSendOrder = (sendOrder !== 'text_only' && !imageBase64) ? 'text_only' : sendOrder;

    // ---- 4. executeScript (MAIN world) でCSRF取得 + 送信 ----
    const execDmSend = async () => {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (myUid, targetUid, msgBody, imgB64, sendOrd) => {
          var csrf = window.__logger && window.__logger.kibanaLogger
            && window.__logger.kibanaLogger.api && window.__logger.kibanaLogger.api.csrfParams;
          if (!csrf || !csrf.csrfToken) {
            return {
              success: false, error: 'CSRF未初期化',
              hasLogger: !!window.__logger,
              hasKibana: !!(window.__logger && window.__logger.kibanaLogger),
              hasApi: !!(window.__logger && window.__logger.kibanaLogger && window.__logger.kibanaLogger.api),
            };
          }

          function parseResponse(r) {
            return r.text().then(function (text) {
              var data = null;
              try { data = JSON.parse(text); } catch (e) { /* skip */ }
              return { status: r.status, data: data, text: text.substring(0, 300) };
            });
          }
          function handleMessageResponse(resp) {
            if (resp.status >= 200 && resp.status < 300 && resp.data && resp.data.message) {
              return { success: true, messageId: resp.data.message.id, httpStatus: resp.status };
            }
            return { success: false, error: 'HTTP ' + resp.status + ': ' + resp.text, httpStatus: resp.status };
          }
          function sendTextMessage(uniqId) {
            return fetch('/api/front/users/' + myUid + '/conversations/' + targetUid + '/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
              credentials: 'include',
              body: JSON.stringify({
                body: msgBody,
                csrfToken: csrf.csrfToken, csrfTimestamp: csrf.csrfTimestamp, csrfNotifyTimestamp: csrf.csrfNotifyTimestamp,
                uniq: uniqId,
              }),
            }).then(parseResponse).then(handleMessageResponse);
          }
          function uploadPhoto() {
            var binaryStr = atob(imgB64);
            var bytes = new Uint8Array(binaryStr.length);
            for (var i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            var blob = new Blob([bytes], { type: 'image/jpeg' });
            var fd = new FormData();
            fd.append('photo', blob, 'image.jpg');
            fd.append('source', 'upload');
            fd.append('messenger', '1');
            fd.append('csrfToken', csrf.csrfToken);
            fd.append('csrfTimestamp', csrf.csrfTimestamp);
            fd.append('csrfNotifyTimestamp', csrf.csrfNotifyTimestamp);
            return fetch('/api/front/users/' + myUid + '/albums/0/photos', {
              method: 'POST',
              headers: { 'X-Requested-With': 'XMLHttpRequest' },
              credentials: 'include',
              body: fd,
            }).then(function (r) { return r.json(); }).then(function (photoData) {
              if (!photoData.photo || !photoData.photo.id) throw new Error('写真アップロード失敗: ' + JSON.stringify(photoData).substring(0, 200));
              return photoData.photo.id;
            });
          }
          function sendMessageWithMedia(mediaId, body, uniqId) {
            return fetch('/api/front/users/' + myUid + '/conversations/' + targetUid + '/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
              credentials: 'include',
              body: JSON.stringify({
                body: body || '', mediaId: mediaId, mediaSource: 'upload', platform: 'Web',
                csrfToken: csrf.csrfToken, csrfTimestamp: csrf.csrfTimestamp, csrfNotifyTimestamp: csrf.csrfNotifyTimestamp,
                uniq: uniqId,
              }),
            }).then(parseResponse).then(handleMessageResponse);
          }

          try {
            var uniq1 = Math.random().toString(36).substring(2, 18);
            var uniq2 = Math.random().toString(36).substring(2, 18);

            if (sendOrd === 'image_only') {
              return uploadPhoto().then(function (mediaId) {
                return sendMessageWithMedia(mediaId, '', uniq1);
              }).catch(function (e) { return { success: false, error: '画像DM: ' + e.message }; });
            }
            if (sendOrd === 'text_then_image') {
              return sendTextMessage(uniq1).then(function (textResult) {
                if (!textResult.success) return textResult;
                return uploadPhoto().then(function (mediaId) {
                  return sendMessageWithMedia(mediaId, '', uniq2);
                }).then(function (imgResult) {
                  return { success: imgResult.success, messageId: imgResult.messageId, httpStatus: imgResult.httpStatus, sentMessages: 2, textMessageId: textResult.messageId };
                });
              }).catch(function (e) { return { success: false, error: 'text_then_image: ' + e.message }; });
            }
            if (sendOrd === 'image_then_text') {
              return uploadPhoto().then(function (mediaId) {
                return sendMessageWithMedia(mediaId, '', uniq1);
              }).then(function (imgResult) {
                if (!imgResult.success) return imgResult;
                return sendTextMessage(uniq2).then(function (textResult) {
                  return { success: textResult.success, messageId: textResult.messageId, httpStatus: textResult.httpStatus, sentMessages: 2, imageMessageId: imgResult.messageId };
                });
              }).catch(function (e) { return { success: false, error: 'image_then_text: ' + e.message }; });
            }
            // text_only (default)
            return sendTextMessage(uniq1).catch(function (e) { return { success: false, error: e.message }; });
          } catch (e) {
            return Promise.resolve({ success: false, error: 'send_order処理エラー: ' + e.message });
          }
        },
        args: [myUserId, targetUserId, messageBody, imageBase64, effectiveSendOrder],
      });
      return results?.[0]?.result || null;
    };

    let result = await execDmSend();

    // CSRF未初期化 → 3秒待ってリトライ（最大2回）
    if (result && !result.success && result.error === 'CSRF未初期化') {
      console.log('[LS-DM] CSRF未初期化 → 3秒待機リトライ...');
      await sleep_bg(3000);
      result = await execDmSend();
      if (result && !result.success && result.error === 'CSRF未初期化') {
        await sleep_bg(3000);
        result = await execDmSend();
      }
    }

    if (!result) {
      dmApiConsecutiveErrors++;
      return null;
    }

    if (result.success) {
      dmApiConsecutiveErrors = 0;
      console.log('[LS-DM] 送信成功!', task.user_name, 'messageId:', result.messageId);
      return { success: true, error: null, via: 'chrome_ext' };
    }

    // 失敗
    dmApiConsecutiveErrors++;
    if (result.httpStatus === 403) {
      console.warn('[LS-DM] 403 → 5分クールダウン');
      dmApiCooldownUntil = Date.now() + DM_API_COOLDOWN_403;
    } else if (result.httpStatus === 429) {
      console.warn('[LS-DM] 429 → 10分クールダウン');
      dmApiCooldownUntil = Date.now() + DM_API_COOLDOWN_429;
    }
    return { success: false, error: result.error || 'unknown error' };

  } catch (err) {
    dmApiConsecutiveErrors++;
    console.error('[LS-DM] tryDMviaAPI例外:', err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
// DM直列送信パイプライン
// ============================================================

async function processDMQueueSerial(tasks) {
  console.log('[LS-DM] ========== DM直列送信開始 (' + tasks.length + '件) ==========');

  // Stripchatタブを1つ作成
  let tabId;
  try {
    const tab = await chrome.tabs.create({ url: 'https://ja.stripchat.com/', active: false });
    tabId = tab.id;
  } catch (e) {
    console.error('[LS-DM] タブ作成失敗:', e.message);
    return;
  }

  // ページ読み込み + __logger初期化待ち
  const loaded = await waitForTabComplete(tabId, 12000);
  if (loaded) {
    await waitForPageLoad(tabId, 8000);
  } else {
    console.warn('[LS-DM] タブ読み込みタイムアウト → それでも送信試行');
  }

  let sent = 0, errors = 0, skipped = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    // 安全チェック
    const blockReason = dmSafetyCheck(task);
    if (blockReason) {
      console.warn('[LS-DM] 安全ブロック:', blockReason, 'taskId=', task.id);
      await updateDMTaskStatus(task.id, 'error', `DM安全ブロック: ${blockReason}`, 'chrome_ext');
      skipped++;
      continue;
    }

    console.log(`[LS-DM] ${i + 1}/${tasks.length}: ${task.user_name} (${task.cast_name})`);
    // ロック済み（fetchDMBatchでsendingに更新済み）

    const result = await tryDMviaAPI(task, tabId);

    if (result && result.success) {
      await updateDMTaskStatus(task.id, 'success', null, 'chrome_ext');
      sent++;
    } else if (result && !result.success) {
      await updateDMTaskStatus(task.id, 'error', result.error, 'chrome_ext');
      errors++;
      // IDENTITY_MISMATCH → 残り全部スキップ
      if (result.error && result.error.includes('CAST_IDENTITY_MISMATCH')) {
        console.error('[LS-DM] IDENTITY_MISMATCH → 残りタスク中断');
        for (let j = i + 1; j < tasks.length; j++) {
          await updateDMTaskStatus(tasks[j].id, 'queued', null);
        }
        break;
      }
    } else {
      // null（クールダウン/連続エラー上限）→ requeueして中断
      await updateDMTaskStatus(task.id, 'queued', null);
      console.warn('[LS-DM] API不可 → 残りタスク中断');
      for (let k = i + 1; k < tasks.length; k++) {
        await updateDMTaskStatus(tasks[k].id, 'queued', null);
      }
      break;
    }

    // 次のタスクがあれば間隔を空ける
    if (i < tasks.length - 1) {
      const interval = getDMInterval();
      await sleep_bg(interval);
    }
  }

  // タブを閉じる
  try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }

  console.log(`[LS-DM] ========== DM直列送信完了 (成功:${sent} エラー:${errors} スキップ:${skipped}) ==========`);
}

// ============================================================
// DMキュー処理メインループ
// ============================================================

async function processDMQueue() {
  if (dmProcessing) return;
  dmProcessing = true;

  try {
    // クールダウン中はキューを取得しない（sendingロック孤立を防止）
    if (dmApiCooldownUntil && Date.now() < dmApiCooldownUntil) {
      console.log('[LS-DM] クールダウン中 → キュー取得スキップ');
      return;
    }

    // AMP cookie複数ユーザー検出
    if (await checkAMPMultipleUsers()) {
      console.error('[LS-DM] 複数ユーザー検出 → DM送信停止');
      return;
    }

    // バッチ取得
    const tasks = await fetchDMBatch(50);
    if (!tasks || tasks.length === 0) return;

    console.log('[LS-DM] キューから', tasks.length, '件取得');

    // 直列送信
    await processDMQueueSerial(tasks);
  } catch (e) {
    console.error('[LS-DM] DMキュー処理エラー:', e.message);
  } finally {
    dmProcessing = false;
  }
}

// ============================================================
// DMポーリング（10秒間隔）
// ============================================================

function startDMPolling() {
  if (dmPollingTimer) return;
  console.log('[LS-DM] DMポーリング開始 (10秒間隔)');
  processDMQueue();
  dmPollingTimer = setInterval(() => { processDMQueue(); }, 10000);
}

function stopDMPolling() {
  if (dmPollingTimer) {
    clearInterval(dmPollingTimer);
    dmPollingTimer = null;
    console.log('[LS-DM] DMポーリング停止');
  }
}
