/**
 * ws-client.ts — Stripchat data collector (WebSocket + REST)
 *
 * WebSocket: Centrifugo v3 protocol
 *   URL:       wss://websocket-sp-v6.stripchat.com/connection/websocket
 *   Subscribe: {"subscribe":{"channel":"{event}@{modelId}"},"id":{n}}
 *   Push:      {"push":{"channel":"...","pub":{"data":{...}}}}
 *   Keepalive: {} every 25s
 *
 * REST (fallback / supplement):
 *   Status:  /api/front/v2/models/username/{name}/cam
 *   Viewers: /api/front/models/username/{name}/groupShow/members
 */

import WebSocket from 'ws';
import { STRIPCHAT } from './config.js';
import { createLogger } from './utils/logger.js';
import { parseViewerList, ViewerEntry } from './parsers/viewer.js';

const log = createLogger('ws-client');

// ----- Constants -----
const WS_URL = 'wss://websocket-sp-v6.stripchat.com/connection/websocket';
const KEEPALIVE_INTERVAL = 25000;

const WS_CHANNELS = [
  'newChatMessage',
  'newModelEvent',
  'clearChatMessages',
  'userUpdated',
];

const FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// ----- Types -----
export type CastStatus = 'public' | 'private' | 'off' | 'p2p' | 'unknown';

export interface StatusResult {
  status: CastStatus;
  viewerCount: number;
  modelId: string | null;
  rawData: Record<string, unknown> | null;
}

export interface ViewerResult {
  viewers: ViewerEntry[];
  fetchedAt: string;
}

export interface WsMessage {
  channel: string;
  event: string; // newChatMessage, newModelEvent, userUpdated, clearChatMessages
  data: Record<string, unknown>;
  receivedAt: string;
}

export type WsMessageHandler = (msg: WsMessage) => void;

// ----- Centrifugo WebSocket connection -----

export class StripchatWsClient {
  private ws: WebSocket | null = null;
  private modelId: string;
  private castName: string;
  private msgId = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private handler: WsMessageHandler;
  private connected = false;
  private authToken: string;
  private cfClearance: string;
  private onAuthError: (() => void) | null = null;

  constructor(
    castName: string,
    modelId: string,
    handler: WsMessageHandler,
    authToken: string = '',
    cfClearance: string = '',
    onAuthError?: () => void,
  ) {
    this.castName = castName;
    this.modelId = modelId;
    this.handler = handler;
    this.authToken = authToken;
    this.cfClearance = cfClearance;
    this.onAuthError = onAuthError ?? null;
  }

  /** Update auth token (e.g. after refresh) */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /** Update cf_clearance cookie */
  setCfClearance(cookie: string): void {
    this.cfClearance = cookie;
  }

  connect(): void {
    if (this.ws) this.disconnect();

    log.info(`${this.castName}: WS connecting (modelId=${this.modelId}, auth=${this.authToken ? 'yes' : 'no'})`);

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://stripchat.com',
      'Accept-Language': 'ja,en-US;q=0.9',
    };

    // cf_clearance Cookie — Cloudflare bot検知回避
    if (this.cfClearance) {
      headers['Cookie'] = `cf_clearance=${this.cfClearance}`;
    }

    this.ws = new WebSocket(WS_URL, { headers });

    this.ws.on('open', () => {
      log.info(`${this.castName}: WS open — sending Centrifugo connect`);

      // Centrifugo v3: must send connect command with JWT before subscribing
      const connectCmd = JSON.stringify({
        connect: { token: this.authToken, name: 'js' },
        id: ++this.msgId,
      });
      this.ws!.send(connectCmd);
    });

    this.ws.on('message', (raw: Buffer) => {
      const text = raw.toString().trim();

      // Server ping → respond with pong immediately
      if (text === '{}') {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{}');
        return;
      }

      // Parse potentially multi-JSON frame (Centrifugo concatenates)
      const frames = this.splitFrames(text);

      for (const frame of frames) {
      try {
        const msg = frame as {
          id?: number;
          connect?: { client?: string; version?: string };
          subscribe?: { epoch?: string };
          push?: {
            channel?: string;
            pub?: { data?: Record<string, unknown> };
          };
          error?: { code?: number; message?: string };
        };

        // Connect response → subscribe to channels
        if (msg.id && msg.connect) {
          this.connected = true;
          log.info(`${this.castName}: CONNECT OK client=${msg.connect.client || '-'}`);

          // Now subscribe to all channels
          for (const ch of WS_CHANNELS) {
            const channel = `${ch}@${this.modelId}`;
            const payload = JSON.stringify({ subscribe: { channel }, id: ++this.msgId });
            this.ws!.send(payload);
            log.debug(`${this.castName}: SUB → ${channel}`);
          }

          // Client-side keepalive (backup — server ping/pong is primary)
          this.keepaliveTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send('{}');
            }
          }, KEEPALIVE_INTERVAL);
          continue;
        }

        // Connect error (e.g. 3501 = auth required)
        if (msg.id === 1 && msg.error) {
          log.error(`${this.castName}: CONNECT ERR code=${msg.error.code} ${msg.error.message}`);
          if (msg.error.code === 3501 && this.onAuthError) {
            this.onAuthError();
          }
          continue;
        }

        // Sub confirmation
        if (msg.id && msg.subscribe) {
          log.debug(`${this.castName}: SUB OK id=${msg.id}`);
          continue;
        }

        // Sub error
        if (msg.id && msg.error) {
          log.warn(`${this.castName}: SUB ERR id=${msg.id} code=${msg.error.code} ${msg.error.message}`);
          continue;
        }

        // Push message → dispatch to handler
        if (msg.push?.channel && msg.push.pub?.data) {
          const channel = msg.push.channel;
          const eventName = channel.split('@')[0];
          this.handler({
            channel,
            event: eventName,
            data: msg.push.pub.data,
            receivedAt: new Date().toISOString(),
          });
          continue;
        }
      } catch {
        log.debug(`${this.castName}: unparseable WS frame: ${text.substring(0, 100)}`);
      }
      } // end for (frame)
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      log.info(`${this.castName}: WS closed (code=${code}, reason=${reason || 'none'})`);

      // 3501 = JWT required/expired
      if (code === 3501 && this.onAuthError) {
        this.onAuthError();
      }
    });

    this.ws.on('error', (err) => {
      log.error(`${this.castName}: WS error`, err.message);
    });
  }

  /**
   * Split Centrifugo multi-JSON frames.
   * Centrifugo concatenates JSON objects in one WS frame: {"id":1,...}{"id":2,...}
   */
  private splitFrames(text: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '{') depth++;
        else if (line[i] === '}') {
          depth--;
          if (depth === 0) {
            parts.push(line.substring(start, i + 1));
            start = i + 1;
          }
        }
      }
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          results.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // skip unparseable chunks
        }
      }
    }
    return results;
  }

  disconnect(): void {
    this.connected = false;
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    log.debug(`${this.castName}: WS disconnected`);
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}

// ----- REST polling (status + viewers) -----

export async function pollCastStatus(castName: string): Promise<StatusResult> {
  const url = STRIPCHAT.statusUrl(castName);

  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });

    if (res.status === 403) {
      log.warn(`${castName}: Cloudflare 403`);
      return { status: 'unknown', viewerCount: 0, modelId: null, rawData: null };
    }

    if (res.status === 404) {
      return { status: 'off', viewerCount: 0, modelId: null, rawData: null };
    }

    if (!res.ok) {
      log.warn(`${castName}: HTTP ${res.status}`);
      return { status: 'unknown', viewerCount: 0, modelId: null, rawData: null };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const user = data.user as Record<string, unknown> | undefined;

    const status = (user?.status as CastStatus) || 'off';
    const viewerCount = Number(user?.viewersCount || user?.viewers || 0);
    const modelId = user?.id ? String(user.id) : null;

    return { status, viewerCount, modelId, rawData: data };
  } catch (err) {
    log.error(`${castName}: status poll failed`, err);
    return { status: 'unknown', viewerCount: 0, modelId: null, rawData: null };
  }
}

export async function pollViewers(
  castName: string,
  authToken?: string,
): Promise<ViewerResult> {
  const url = STRIPCHAT.viewerUrl(castName);
  const headers: Record<string, string> = { ...FETCH_HEADERS };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const res = await fetch(url, { headers });

    if (!res.ok) {
      log.warn(`${castName}: viewer list HTTP ${res.status}`);
      return { viewers: [], fetchedAt: new Date().toISOString() };
    }

    const data = await res.json();
    const viewers = parseViewerList(data);

    log.debug(`${castName}: ${viewers.length} viewers`);
    return { viewers, fetchedAt: new Date().toISOString() };
  } catch (err) {
    log.error(`${castName}: viewer poll failed`, err);
    return { viewers: [], fetchedAt: new Date().toISOString() };
  }
}
