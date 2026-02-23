/**
 * collector.ts — Per-cast connection manager
 *
 * Hybrid approach:
 * - REST polling for status detection (online/offline)
 * - WebSocket (Centrifugo) for live chat/events when online
 * - REST polling for viewer list
 */

import { createHash } from 'crypto';
import { CastTarget, POLL_INTERVALS } from './config.js';
import {
  pollCastStatus,
  pollViewers,
  CastStatus,
  StripchatWsClient,
  WsMessage,
} from './ws-client.js';
import { upsertViewers, updateCastOnlineStatus, enqueue } from './storage/supabase.js';
import { accumulateViewer } from './storage/spy-profiles.js';
import { parseCentrifugoChat } from './parsers/chat.js';
import { RetryTracker, sleep } from './utils/reconnect.js';
import { createLogger } from './utils/logger.js';
import { getAuth, invalidateAuth } from './auth/index.js';

const log = createLogger('collector');

interface CastState {
  target: CastTarget;
  status: CastStatus;
  viewerCount: number;
  modelId: string | null;
  lastStatusPoll: number;
  lastViewerPoll: number;
  sessionId: string | null;
  sessionStartTime: string | null;
  wsClient: StripchatWsClient | null;
  running: boolean;
  wsMessageCount: number;
  wsTipTotal: number;
}

const castStates = new Map<string, CastState>();
const retryTracker = new RetryTracker();
let mainLoopRunning = false;
let currentAuthToken = '';
let currentCfClearance = '';

/** cast_name + 配信開始時刻 → 決定的session_id */
function generateSessionId(castName: string, startTime: string): string {
  const hash = createHash('sha256').update(`${castName}:${startTime}`).digest('hex');
  return hash.substring(0, 16);
}

/** Fetch auth token (cached) and store for WS connections */
async function ensureAuth(): Promise<string> {
  const auth = await getAuth();
  currentAuthToken = auth.jwt;
  currentCfClearance = auth.cfClearance;
  return auth.jwt;
}

/** Handle auth error from WS — invalidate cache and re-fetch */
async function handleAuthError(state: CastState): Promise<void> {
  log.warn(`${state.target.castName}: Auth error — invalidating and retrying`);
  invalidateAuth();
  const token = await ensureAuth();
  if (state.wsClient) {
    state.wsClient.setAuthToken(token);
    state.wsClient.setCfClearance(currentCfClearance);
    state.wsClient.disconnect();
    state.wsClient.connect();
  }
}

function stateKey(target: CastTarget): string {
  return `${target.accountId}:${target.castName}`;
}

// ----- WebSocket message handler -----

function createWsHandler(state: CastState) {
  return (msg: WsMessage) => {
    const { target } = state;

    if (msg.event === 'newChatMessage') {
      state.wsMessageCount++;

      // Use parser that understands Centrifugo nested structure:
      //   data.message.userData.username, data.message.details.body, etc.
      const parsed = parseCentrifugoChat(msg.data);

      if (!parsed) {
        log.debug(`${target.castName}: unparseable chat: ${JSON.stringify(msg.data).substring(0, 100)}`);
        return;
      }

      const isVip = parsed.tokens >= 1000 || parsed.isKing || parsed.isKnight;
      if (parsed.tokens > 0) state.wsTipTotal += parsed.tokens;

      // Write to spy_messages via batch
      enqueue('spy_messages', {
        account_id: target.accountId,
        cast_name: target.castName,
        message_time: parsed.messageTime,
        msg_type: parsed.msgType,
        user_name: parsed.userName,
        message: parsed.message,
        tokens: parsed.tokens,
        is_vip: isVip,
        session_id: state.sessionId,
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
        log.info(`${target.castName}: TIP ${parsed.userName} ${parsed.tokens}tk "${parsed.message.substring(0, 40)}"`);
      } else {
        log.debug(`${target.castName}: CHAT ${parsed.userName}: ${parsed.message.substring(0, 60)}`);
      }
    } else if (msg.event === 'newModelEvent') {
      const eventType = String(msg.data.event || msg.data.type || 'unknown');
      log.info(`${target.castName}: EVENT ${eventType}`);

      enqueue('spy_messages', {
        account_id: target.accountId,
        cast_name: target.castName,
        message_time: msg.receivedAt,
        msg_type: 'system',
        user_name: 'collector',
        message: `Model event: ${eventType}`,
        tokens: 0,
        is_vip: false,
        session_id: state.sessionId,
        metadata: { source: 'collector-ws', event: eventType, rawData: msg.data },
      });
    } else if (msg.event === 'userUpdated') {
      log.debug(`${target.castName}: USER_UPDATED ${JSON.stringify(msg.data).substring(0, 100)}`);
    }
  };
}

// ----- Public API -----

export function registerTarget(target: CastTarget): void {
  const key = stateKey(target);
  if (castStates.has(key)) return;

  castStates.set(key, {
    target,
    status: 'unknown',
    viewerCount: 0,
    modelId: null,
    lastStatusPoll: 0,
    lastViewerPoll: 0,
    sessionId: null,
    sessionStartTime: null,
    wsClient: null,
    running: true,
    wsMessageCount: 0,
    wsTipTotal: 0,
  });

  log.info(`Registered: ${target.castName} (${target.source})`);
}

export function unregisterTarget(target: CastTarget): void {
  const key = stateKey(target);
  const state = castStates.get(key);
  if (state) {
    state.running = false;
    state.wsClient?.disconnect();
    castStates.delete(key);
    log.info(`Unregistered: ${target.castName}`);
  }
}

export function getRegisteredCount(): number {
  return castStates.size;
}

export function getStatus(): {
  castName: string;
  status: CastStatus;
  viewerCount: number;
  source: string;
  wsConnected: boolean;
  wsMessages: number;
  wsTips: number;
}[] {
  return Array.from(castStates.values()).map((s) => ({
    castName: s.target.castName,
    status: s.status,
    viewerCount: s.viewerCount,
    source: s.target.source,
    wsConnected: s.wsClient?.isConnected() ?? false,
    wsMessages: s.wsMessageCount,
    wsTips: s.wsTipTotal,
  }));
}

// ----- Polling logic -----

async function pollStatus(state: CastState): Promise<void> {
  const { target } = state;
  const now = Date.now();

  if (now - state.lastStatusPoll < POLL_INTERVALS.statusSec * 1000) return;
  state.lastStatusPoll = now;

  const result = await pollCastStatus(target.castName);

  if (result.status === 'unknown') {
    retryTracker.recordFailure(`status:${target.castName}`);
    return;
  }

  retryTracker.recordSuccess(`status:${target.castName}`);

  const prevStatus = state.status;
  state.status = result.status;
  state.viewerCount = result.viewerCount;

  // Store modelId for WS subscription
  if (result.modelId) {
    state.modelId = result.modelId;
  }

  const isOnline = result.status === 'public' || result.status === 'private' || result.status === 'p2p';
  const wasOnline = prevStatus === 'public' || prevStatus === 'private' || prevStatus === 'p2p';

  // ------ ONLINE transition ------
  if (isOnline && !wasOnline && prevStatus !== 'unknown') {
    const startTime = new Date().toISOString();
    state.sessionStartTime = startTime;
    state.sessionId = generateSessionId(target.castName, startTime);
    state.wsMessageCount = 0;
    state.wsTipTotal = 0;

    log.info(`${target.castName}: ONLINE (${result.status}, ${result.viewerCount} viewers, session=${state.sessionId})`);

    enqueue('spy_messages', {
      account_id: target.accountId,
      cast_name: target.castName,
      message_time: startTime,
      msg_type: 'system',
      user_name: 'collector',
      message: `配信開始検出 (${result.status}, ${result.viewerCount}人)`,
      tokens: 0,
      is_vip: false,
      session_id: state.sessionId,
      metadata: { source: 'collector', modelId: result.modelId, viewerCount: result.viewerCount },
    });

    // Connect WebSocket for live chat
    if (state.modelId) {
      state.wsClient = new StripchatWsClient(
        target.castName,
        state.modelId,
        createWsHandler(state),
        currentAuthToken,
        currentCfClearance,
        () => handleAuthError(state),
      );
      state.wsClient.connect();
    }
  }

  // ------ OFFLINE transition ------
  if (!isOnline && wasOnline) {
    log.info(`${target.castName}: OFFLINE (${state.wsMessageCount} msgs, ${state.wsTipTotal}tk captured)`);

    enqueue('spy_messages', {
      account_id: target.accountId,
      cast_name: target.castName,
      message_time: new Date().toISOString(),
      msg_type: 'system',
      user_name: 'collector',
      message: `配信終了検出 (${state.wsMessageCount}メッセージ, ${state.wsTipTotal}tk)`,
      tokens: 0,
      is_vip: false,
      session_id: state.sessionId,
      metadata: { source: 'collector', lastViewerCount: state.viewerCount },
    });

    // Disconnect WebSocket
    state.wsClient?.disconnect();
    state.wsClient = null;
    state.sessionId = null;
    state.sessionStartTime = null;
  }

  // ------ First poll: if already online, connect WS ------
  if (isOnline && prevStatus === 'unknown' && state.modelId && !state.wsClient) {
    const startTime = new Date().toISOString();
    state.sessionStartTime = startTime;
    state.sessionId = generateSessionId(target.castName, startTime);
    log.info(`${target.castName}: already online (${result.status}), connecting WS (session=${state.sessionId})`);
    state.wsClient = new StripchatWsClient(
      target.castName,
      state.modelId,
      createWsHandler(state),
      currentAuthToken,
      currentCfClearance,
      () => handleAuthError(state),
    );
    state.wsClient.connect();
  }

  if (isOnline) {
    await updateCastOnlineStatus(target.source, target.accountId, target.castName, true);
  }
}

async function pollViewerList(state: CastState): Promise<void> {
  const { target } = state;
  const now = Date.now();

  const isOnline = state.status === 'public' || state.status === 'private' || state.status === 'p2p';
  if (!isOnline) return;

  if (now - state.lastViewerPoll < POLL_INTERVALS.viewerSec * 1000) return;
  state.lastViewerPoll = now;

  const result = await pollViewers(target.castName);

  if (result.viewers.length === 0) {
    if (retryTracker.getFailureCount(`viewers:${target.castName}`) === 0) {
      log.warn(`${target.castName}: viewer list empty (may require auth)`);
    }
    retryTracker.recordFailure(`viewers:${target.castName}`);
    return;
  }

  retryTracker.recordSuccess(`viewers:${target.castName}`);

  const upserted = await upsertViewers(
    target.accountId,
    target.castName,
    state.sessionId,
    result.viewers,
  );

  for (const v of result.viewers) {
    accumulateViewer(target.castName, v);
  }

  log.debug(`${target.castName}: ${result.viewers.length} viewers, ${upserted} upserted`);
}

// ----- Main loop -----

export async function startCollector(): Promise<void> {
  mainLoopRunning = true;
  log.info('Collector main loop started');

  // Pre-fetch auth token before starting polling
  try {
    await ensureAuth();
    log.info(`Auth ready (token=${currentAuthToken ? 'yes' : 'no'})`);
  } catch (err) {
    log.warn('Auth pre-fetch failed, will retry on WS connect', err);
  }

  while (mainLoopRunning) {
    const states = Array.from(castStates.values()).filter((s) => s.running);

    for (const state of states) {
      if (!mainLoopRunning) break;

      try {
        await pollStatus(state);
        await pollViewerList(state);
      } catch (err) {
        log.error(`${state.target.castName}: poll error`, err);
      }

      // Stagger between casts
      await sleep(200);
    }

    // Wait before next cycle
    await sleep(5000);
  }

  // Cleanup all WS connections
  for (const state of castStates.values()) {
    state.wsClient?.disconnect();
  }

  log.info('Collector main loop stopped');
}

export function stopCollector(): void {
  mainLoopRunning = false;
  log.info('Collector stop requested');
}
