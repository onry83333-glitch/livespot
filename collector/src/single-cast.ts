/**
 * single-cast.ts — 1プロセス1キャスト専用エントリポイント
 *
 * 環境変数:
 *   CAST_NAME       — 監視対象キャスト名 (必須)
 *   ACCOUNT_ID      — Supabaseアカウント UUID (必須)
 *   CAST_SOURCE     — 'registered_casts' | 'spy_casts' (デフォルト: 'registered_casts')
 *   CAST_DISPLAY    — 表示名 (省略可)
 *   MODEL_ID        — Stripchat model ID (省略可、REST pollで自動取得)
 *
 * Usage:
 *   CAST_NAME=Risa_06 ACCOUNT_ID=xxx tsx src/single-cast.ts
 *   pm2 start ecosystem.config.cjs
 */

import 'dotenv/config';
import { CastTarget, POLL_INTERVALS, BATCH_CONFIG, getSupabase } from './config.js';
import { pollCastStatus, pollViewers, CastStatus, StripchatWsClient, WsMessage } from './ws-client.js';
import { upsertViewers, updateCastOnlineStatus, enqueue, openSession, closeSession, closeStaleSessionsForCast, startBatchFlush, stopBatchFlush, flushBuffer } from './storage/supabase.js';
import { accumulateViewer, flushProfiles } from './storage/spy-profiles.js';
import { parseCentrifugoChat } from './parsers/chat.js';
import { RetryTracker, sleep } from './utils/reconnect.js';
import { createLogger, setLogLevel } from './utils/logger.js';
import { getAuth, invalidateAuth } from './auth/index.js';
import { TriggerEngine } from './triggers/index.js';
import { generatePostSessionReport } from './reports/post-session-report.js';
import { captureThumbnailForCast } from './thumbnails.js';
import { runCoinSync } from './coin-sync.js';
import { createHash } from 'crypto';

// ----- Validate env -----
const CAST_NAME = process.env.CAST_NAME;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const CAST_SOURCE = (process.env.CAST_SOURCE || 'registered_casts') as 'registered_casts' | 'spy_casts';

if (!CAST_NAME || !ACCOUNT_ID) {
  console.error('ERROR: CAST_NAME and ACCOUNT_ID env vars are required');
  console.error('Usage: CAST_NAME=Risa_06 ACCOUNT_ID=xxx tsx src/single-cast.ts');
  process.exit(1);
}

const log = createLogger(`cast:${CAST_NAME}`);
const envLevel = process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined;
if (envLevel) setLogLevel(envLevel);

// ----- Per-cast state (no Map, just local variables) -----
const target: CastTarget = {
  accountId: ACCOUNT_ID,
  castName: CAST_NAME,
  displayName: process.env.CAST_DISPLAY || null,
  isActive: true,
  autoMonitor: true,
  stripchatModelId: process.env.MODEL_ID || null,
  source: CAST_SOURCE,
};

let status: CastStatus = 'unknown';
let viewerCount = 0;
let modelId: string | null = target.stripchatModelId;
let lastStatusPoll = 0;
let lastViewerPoll = 0;
let sessionId: string | null = null;
let sessionStartTime: string | null = null;
let wsClient: StripchatWsClient | null = null;
let wsMessageCount = 0;
let wsTipTotal = 0;
let running = true;

// Auth — 1プロセス1キャストなので mutex 不要、単純な変数
let currentAuthToken = '';
let currentCfClearance = '';
let lastAuthRefreshAt = 0;
const AUTH_DEBOUNCE_MS = 10_000;

// Session cookies — stripchat_sessions テーブルから取得（viewer list認証用）
let cachedSessionCookies: string | null = null;
let lastSessionCookieFetch = 0;
const SESSION_COOKIE_CACHE_MS = 5 * 60 * 1000; // 5分キャッシュ

const retryTracker = new RetryTracker();

// ----- Helpers -----

function generateSessionId(startTime: string): string {
  const hex = createHash('sha256').update(`${ACCOUNT_ID}:${CAST_NAME}:${startTime}`).digest('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    '5' + hex.substring(13, 16),
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.substring(17, 20),
    hex.substring(20, 32),
  ].join('-');
}

async function refreshAuth(): Promise<void> {
  const auth = await getAuth();
  currentAuthToken = auth.jwt;
  currentCfClearance = auth.cfClearance;
}

async function handleAuthError(): Promise<void> {
  const now = Date.now();
  if (now - lastAuthRefreshAt < AUTH_DEBOUNCE_MS) {
    log.debug('Auth error debounced — reconnecting WS with existing token');
    if (wsClient) {
      wsClient.setAuthToken(currentAuthToken);
      wsClient.setCfClearance(currentCfClearance);
      wsClient.disconnect();
      wsClient.connect();
    }
    return;
  }

  log.warn('Auth error — refreshing');
  invalidateAuth();
  await refreshAuth();
  lastAuthRefreshAt = Date.now();
  retryTracker.resetByPrefix('viewers:');

  if (wsClient) {
    wsClient.setAuthToken(currentAuthToken);
    wsClient.setCfClearance(currentCfClearance);
    wsClient.disconnect();
    wsClient.connect();
  }
}

// ----- Session cookies for viewer list (registered_casts only) -----

async function getSessionCookies(): Promise<string | null> {
  if (CAST_SOURCE !== 'registered_casts') return null;

  const now = Date.now();
  if (cachedSessionCookies && now - lastSessionCookieFetch < SESSION_COOKIE_CACHE_MS) {
    return cachedSessionCookies;
  }

  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('stripchat_sessions')
      .select('cookies_json, session_cookie')
      .eq('account_id', ACCOUNT_ID)
      .eq('is_valid', true)
      .maybeSingle();

    if (!data) {
      log.debug('No valid stripchat_session for viewer list auth');
      lastSessionCookieFetch = now;
      cachedSessionCookies = null;
      return null;
    }

    const cj = data.cookies_json as Record<string, string> | null;
    if (cj && Object.keys(cj).length > 0) {
      cachedSessionCookies = Object.entries(cj).map(([k, v]) => `${k}=${v}`).join('; ');
    } else if (data.session_cookie) {
      cachedSessionCookies = `stripchat_com_sessionId=${data.session_cookie}`;
    } else {
      cachedSessionCookies = null;
    }

    lastSessionCookieFetch = now;
    if (cachedSessionCookies) {
      log.info('Session cookies acquired for viewer list auth');
    }
    return cachedSessionCookies;
  } catch (err) {
    log.warn(`Session cookie fetch failed: ${err}`);
    return null;
  }
}

// ----- WebSocket message handler -----

function onWsMessage(msg: WsMessage): void {
  if (msg.event === 'newChatMessage') {
    wsMessageCount++;
    const parsed = parseCentrifugoChat(msg.data);
    if (!parsed) return;

    const isVip = parsed.tokens >= 1000 || parsed.isKing || parsed.isKnight;
    if (parsed.tokens > 0) wsTipTotal += parsed.tokens;

    enqueue('spy_messages', {
      account_id: ACCOUNT_ID,
      cast_name: CAST_NAME,
      message_time: parsed.messageTime,
      msg_type: parsed.msgType,
      user_name: parsed.userName,
      message: parsed.message,
      tokens: parsed.tokens,
      is_vip: isVip,
      session_id: sessionId,
      user_league: parsed.userLeague || null,
      user_level: parsed.userLevel || null,
      metadata: {
        source: 'collector-ws',
        channel: msg.channel,
        isModel: parsed.isModel || undefined,
        isKing: parsed.isKing || undefined,
        isKnight: parsed.isKnight || undefined,
        isFanClub: parsed.isFanClub || undefined,
        stripchatUserId: parsed.userIdStripchat || undefined,
      },
    });

    if (parsed.tokens > 0) {
      log.info(`TIP ${parsed.userName} ${parsed.tokens}tk "${parsed.message.substring(0, 40)}"`);
    }
  } else if (msg.event === 'newModelEvent') {
    const eventType = String(msg.data.event || msg.data.type || 'unknown');
    log.info(`EVENT ${eventType}`);
    enqueue('spy_messages', {
      account_id: ACCOUNT_ID,
      cast_name: CAST_NAME,
      message_time: msg.receivedAt,
      msg_type: 'system',
      user_name: 'collector',
      message: `Model event: ${eventType}`,
      tokens: 0,
      is_vip: false,
      session_id: sessionId,
      metadata: { source: 'collector-ws', event: eventType, rawData: msg.data },
    });
  }
}

// ----- Polling -----

async function doPollStatus(): Promise<void> {
  const now = Date.now();
  if (now - lastStatusPoll < POLL_INTERVALS.statusSec * 1000) return;
  lastStatusPoll = now;

  const result = await pollCastStatus(CAST_NAME, currentCfClearance);
  if (result.status === 'unknown') {
    retryTracker.recordFailure(`status:${CAST_NAME}`);
    return;
  }
  retryTracker.recordSuccess(`status:${CAST_NAME}`);

  const prevStatus = status;
  status = result.status;
  viewerCount = result.viewerCount;
  if (result.modelId) modelId = result.modelId;

  const isOnline = result.status === 'public' || result.status === 'private' || result.status === 'p2p';
  const wasOnline = prevStatus === 'public' || prevStatus === 'private' || prevStatus === 'p2p';

  // --- ONLINE transition ---
  if (isOnline && !wasOnline && prevStatus !== 'unknown') {
    const startTime = new Date().toISOString();
    sessionStartTime = startTime;
    sessionId = generateSessionId(startTime);
    wsMessageCount = 0;
    wsTipTotal = 0;

    log.info(`ONLINE (${result.status}, ${result.viewerCount} viewers, session=${sessionId})`);

    try {
      sessionId = await openSession(ACCOUNT_ID, CAST_NAME, sessionId, startTime);
    } catch (err) {
      log.error(`Session open error: ${err}`);
    }

    enqueue('spy_messages', {
      account_id: ACCOUNT_ID,
      cast_name: CAST_NAME,
      message_time: startTime,
      msg_type: 'system',
      user_name: 'collector',
      message: `配信開始検出 (${result.status}, ${result.viewerCount}人)`,
      tokens: 0,
      is_vip: false,
      session_id: sessionId,
      metadata: { source: 'collector', modelId: result.modelId, viewerCount: result.viewerCount },
    });

    if (modelId) {
      wsClient = new StripchatWsClient(CAST_NAME, modelId, onWsMessage, currentAuthToken, currentCfClearance, () => handleAuthError());
      wsClient.connect();
    }

    if (triggerEngine) {
      triggerEngine.onSessionTransition(ACCOUNT_ID, CAST_NAME, 'start', {
        sessionId, viewerCount: result.viewerCount, startTime,
      }).catch((err) => log.error(`Trigger session start error: ${err}`));
    }
  }

  // --- OFFLINE transition ---
  if (!isOnline && wasOnline) {
    log.info(`OFFLINE (${wsMessageCount} msgs, ${wsTipTotal}tk)`);

    enqueue('spy_messages', {
      account_id: ACCOUNT_ID,
      cast_name: CAST_NAME,
      message_time: new Date().toISOString(),
      msg_type: 'system',
      user_name: 'collector',
      message: `配信終了検出 (${wsMessageCount}メッセージ, ${wsTipTotal}tk)`,
      tokens: 0,
      is_vip: false,
      session_id: sessionId,
      metadata: { source: 'collector', lastViewerCount: viewerCount },
    });

    if (sessionId) {
      closeSession(sessionId, ACCOUNT_ID, CAST_NAME, wsMessageCount, wsTipTotal, viewerCount)
        .catch((err) => log.error(`Session close error: ${err}`));
    }

    if (triggerEngine) {
      triggerEngine.onSessionTransition(ACCOUNT_ID, CAST_NAME, 'end', {
        sessionId, messageCount: wsMessageCount, tipTotal: wsTipTotal,
      }).catch((err) => log.error(`Trigger session end error: ${err}`));
    }

    // 配信後レポート自動生成（registered_castsのみ）
    if (sessionId && sessionStartTime && CAST_SOURCE === 'registered_casts') {
      generatePostSessionReport(ACCOUNT_ID, CAST_NAME, sessionId, sessionStartTime)
        .catch((err) => log.error(`Post-session report error: ${err}`));
    }

    wsClient?.disconnect();
    wsClient = null;
    sessionId = null;
    sessionStartTime = null;
  }

  // --- First poll: already online ---
  if (isOnline && prevStatus === 'unknown' && modelId && !wsClient) {
    try {
      const closed = await closeStaleSessionsForCast(ACCOUNT_ID, CAST_NAME);
      if (closed > 0) log.info(`Closed ${closed} stale session(s)`);
    } catch (err) {
      log.warn('Failed to close stale sessions', err);
    }

    const startTime = new Date().toISOString();
    sessionStartTime = startTime;
    sessionId = generateSessionId(startTime);
    wsMessageCount = 0;
    wsTipTotal = 0;
    log.info(`Already online (${result.status}), session=${sessionId}`);

    try {
      sessionId = await openSession(ACCOUNT_ID, CAST_NAME, sessionId, startTime);
    } catch (err) {
      log.error(`Session open error (first poll): ${err}`);
    }

    wsClient = new StripchatWsClient(CAST_NAME, modelId, onWsMessage, currentAuthToken, currentCfClearance, () => handleAuthError());
    wsClient.connect();
  }

  if (isOnline) {
    await updateCastOnlineStatus(CAST_SOURCE, ACCOUNT_ID, CAST_NAME, true);
  }
}

async function doPollViewerList(): Promise<void> {
  const now = Date.now();
  const isOnline = status === 'public' || status === 'private' || status === 'p2p';
  if (!isOnline) return;
  if (now - lastViewerPoll < POLL_INTERVALS.viewerSec * 1000) return;
  lastViewerPoll = now;

  const failKey = `viewers:${CAST_NAME}`;
  if (!retryTracker.shouldRetry(failKey)) return;

  const sessionCookies = await getSessionCookies();
  const result = await pollViewers(CAST_NAME, currentAuthToken, currentCfClearance, sessionCookies);

  if (result.httpStatus !== 200) {
    if (retryTracker.getFailureCount(failKey) === 0) {
      log.warn(`Viewer list failed (HTTP ${result.httpStatus})${sessionCookies ? ' with session cookies' : ' without auth'}`);
    }
    // 401 with session cookies → invalidate cookie cache
    if (result.httpStatus === 401 && sessionCookies) {
      cachedSessionCookies = null;
      lastSessionCookieFetch = 0;
      log.warn('Session cookies expired — will re-fetch next cycle');
    }
    retryTracker.recordFailure(failKey);
    return;
  }

  retryTracker.recordSuccess(failKey);
  if (result.viewers.length === 0) return;

  await upsertViewers(ACCOUNT_ID, CAST_NAME, sessionId, result.viewers);

  for (const v of result.viewers) {
    accumulateViewer(CAST_NAME, v);
  }

  log.debug(`${result.viewers.length} viewers upserted`);

  if (triggerEngine) {
    triggerEngine.onViewerListUpdate(ACCOUNT_ID, CAST_NAME, result.viewers)
      .catch((err) => log.error(`Trigger viewer list error: ${err}`));
  }
}

// ----- Trigger Engine -----
let triggerEngine: TriggerEngine | null = null;

// ----- Thumbnail (for this cast only when online) -----
async function doThumbnail(): Promise<void> {
  const isOnline = status === 'public' || status === 'private' || status === 'p2p';
  if (!isOnline || !modelId) return;
  try {
    await captureThumbnailForCast(CAST_NAME, modelId, ACCOUNT_ID, sessionId, CAST_SOURCE);
  } catch (err) {
    log.debug(`Thumbnail failed: ${err}`);
  }
}

// ----- Health report to pipeline_status -----
async function reportHealth(): Promise<void> {
  try {
    const sb = getSupabase();
    const isOnline = status === 'public' || status === 'private' || status === 'p2p';
    const wsConnected = wsClient?.isConnected() ?? false;
    const detail = `${CAST_NAME}: ${isOnline ? status : 'off'} WS=${wsConnected ? 'ON' : 'off'} ${wsMessageCount}msg ${wsTipTotal}tk`;

    await sb.from('pipeline_status').upsert({
      pipeline_name: `Collector:${CAST_NAME}`,
      status: 'auto',
      source: 'Stripchat WS+REST',
      destination: 'spy_messages',
      detail,
      last_run_at: new Date().toISOString(),
      last_success: true,
    }, { onConflict: 'pipeline_name' });
  } catch {
    // ignore health write errors
  }
}

// ----- Main -----

async function main(): Promise<void> {
  log.info('========================================');
  log.info(`Single-cast collector: ${CAST_NAME}`);
  log.info(`Account: ${ACCOUNT_ID}`);
  log.info(`Source: ${CAST_SOURCE}`);
  log.info(`Status poll: ${POLL_INTERVALS.statusSec}s, Viewer poll: ${POLL_INTERVALS.viewerSec}s`);
  log.info(`Batch: ${BATCH_CONFIG.maxSize} rows / ${BATCH_CONFIG.flushIntervalMs}ms`);
  log.info('========================================');

  // 1. Auth
  try {
    await refreshAuth();
    log.info(`Auth: token=${currentAuthToken ? 'yes' : 'no'}, cf=${currentCfClearance ? 'yes' : 'no'}`);
  } catch (err) {
    log.warn('Auth pre-fetch failed — REST polling still works', err);
  }

  // 2. Close stale sessions from previous runs
  try {
    const closed = await closeStaleSessionsForCast(ACCOUNT_ID, CAST_NAME);
    if (closed > 0) log.info(`Closed ${closed} stale session(s)`);
  } catch (err) {
    log.warn('Stale session cleanup failed', err);
  }

  // 3. Start batch flush
  startBatchFlush();

  // 4. Trigger Engine
  triggerEngine = new TriggerEngine();
  try {
    await triggerEngine.refreshTriggers();
    await triggerEngine.initSnapshots(ACCOUNT_ID);
    log.info('TriggerEngine ready');
  } catch (err) {
    log.warn('TriggerEngine init failed (triggers disabled)', err);
    triggerEngine = null;
  }

  // 5. Periodic jobs (simplified — 1 cast only)

  // Profile flush (10min)
  setInterval(async () => {
    try { await flushProfiles(ACCOUNT_ID); } catch (err) { log.error('Profile flush failed', err); }
  }, 10 * 60 * 1000);

  // Health report (1min)
  setInterval(() => reportHealth(), 60 * 1000);

  // Thumbnail (60s)
  setInterval(() => doThumbnail(), 60 * 1000);

  // Viewer retry reset (10min)
  setInterval(() => retryTracker.resetByPrefix('viewers:'), 10 * 60 * 1000);

  // Trigger refresh (5min)
  if (triggerEngine) {
    const te = triggerEngine;
    setInterval(async () => {
      try { await te.refreshTriggers(); } catch (err) { log.error('Trigger refresh failed', err); }
    }, 5 * 60 * 1000);

    // Scheduled trigger evaluation (1h)
    setInterval(async () => {
      try { await te.evaluateScheduled(); } catch (err) { log.error('Scheduled trigger eval failed', err); }
    }, 60 * 60 * 1000);

    // Post-session queue (1min)
    setInterval(async () => {
      try { await te.processPostSessionQueue(); } catch (err) { log.error('Post-session queue error', err); }
    }, 60 * 1000);
  }

  // Coin sync (2h, only for registered_casts)
  if (CAST_SOURCE === 'registered_casts') {
    const runCoinSyncSafe = async () => {
      try { await runCoinSync(); } catch (err) { log.error('Coin sync failed', err); }
    };
    setTimeout(() => runCoinSyncSafe(), 60 * 1000);
    setInterval(() => runCoinSyncSafe(), 2 * 60 * 60 * 1000);
    log.info('Coin sync scheduled (2h, registered_cast only)');
  }

  // 6. Main polling loop (5s cycle, 1 cast only — no stagger needed)
  log.info('Starting polling loop...');
  while (running) {
    try {
      await doPollStatus();
      await doPollViewerList();
    } catch (err) {
      log.error('Poll error', err);
    }

    if (triggerEngine) triggerEngine.incrementWarmup();
    await sleep(5000);
  }

  wsClient?.disconnect();
  log.info('Polling loop stopped');
}

// ----- Graceful shutdown -----
async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} — shutting down`);
  running = false;

  if (sessionId) {
    try {
      await closeSession(sessionId, ACCOUNT_ID, CAST_NAME, wsMessageCount, wsTipTotal, viewerCount);
      log.info(`Session ${sessionId} closed`);
    } catch (err) {
      log.error(`Failed to close session: ${err}`);
    }
  }

  wsClient?.disconnect();
  await flushBuffer();
  stopBatchFlush();
  log.info('Goodbye.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
