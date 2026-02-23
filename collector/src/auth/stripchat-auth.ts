/**
 * stripchat-auth.ts — Stripchat JWT/Cookie自動取得
 *
 * 3方式を優先順に試行:
 *   C. ページHTML → __PRELOADED_STATE__ からJWT抽出（ゲストトークン）
 *   B. REST API /api/front/v2/config からトークン取得
 *   A. Playwright headless（Cloudflare突破、最終手段）
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface StripchatAuth {
  jwt: string;
  cfClearance: string;
  wsUrl: string;
  userId: string;
  expiresAt: number; // Unix seconds
  method: 'page_html' | 'rest_api' | 'playwright' | 'env';
}

// ----- JWT decode (header.payload.sig → payload) -----

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function getJwtExpiry(jwt: string): number {
  const payload = decodeJwtPayload(jwt);
  if (payload?.exp && typeof payload.exp === 'number') return payload.exp;
  // Default: 1 hour from now
  return Math.floor(Date.now() / 1000) + 3600;
}

// ----- 方式C: ページHTMLから__PRELOADED_STATE__取得 -----

export async function fetchAuthFromPage(
  modelName: string = 'Risa_06',
): Promise<StripchatAuth | null> {
  const url = `https://stripchat.com/${encodeURIComponent(modelName)}`;
  log.info(`[方式C] Fetching page: ${url}`);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    if (!res.ok) {
      log.warn(`[方式C] HTTP ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Extract __PRELOADED_STATE__
    const stateMatch = html.match(
      /window\.__PRELOADED_STATE__\s*=\s*({.+?});\s*<\/script>/s,
    );

    if (!stateMatch) {
      // Try alternate pattern
      const altMatch = html.match(
        /window\.__PRELOADED_STATE__\s*=\s*({.+?});/s,
      );
      if (!altMatch) {
        log.warn('[方式C] __PRELOADED_STATE__ not found in HTML');
        // Dump first 500 chars for debugging
        log.debug(`[方式C] HTML start: ${html.substring(0, 500)}`);
        return null;
      }
      return parsePreloadedState(altMatch[1], res);
    }

    return parsePreloadedState(stateMatch[1], res);
  } catch (err: any) {
    log.error(`[方式C] Failed: ${err.message}`);
    return null;
  }
}

function parsePreloadedState(
  jsonStr: string,
  res: Response,
): StripchatAuth | null {
  try {
    const state = JSON.parse(jsonStr);

    // Extract JWT — search multiple known paths
    const jwt =
      state?.config?.centrifugoToken ||
      state?.configV3?.centrifugoToken ||
      state?.user?.centrifugoToken ||
      state?.user?.token ||
      state?.centrifugoToken ||
      findNestedValue(state, 'centrifugoToken') ||
      findNestedValue(state, 'wsToken') ||
      '';

    // Extract WebSocket URL
    const wsUrl =
      state?.config?.webSocketUrl ||
      state?.configV3?.webSocketUrl ||
      findNestedValue(state, 'webSocketUrl') ||
      findNestedValue(state, 'wsUrl') ||
      'wss://websocket-sp-v6.stripchat.com/connection/websocket';

    // Extract user info
    const userId =
      state?.user?.user?.id?.toString() ||
      state?.user?.id?.toString() ||
      '';

    if (!jwt) {
      log.warn('[方式C] JWT not found in __PRELOADED_STATE__');
      // Log available top-level keys for debugging
      const keys = Object.keys(state).join(', ');
      log.debug(`[方式C] State keys: ${keys}`);

      // Deep-search for any JWT-like string
      const jwtCandidate = findJwtInObject(state);
      if (jwtCandidate) {
        log.info(`[方式C] Found JWT candidate via deep search`);
        return buildAuth(jwtCandidate, wsUrl, userId, res, 'page_html');
      }

      return null;
    }

    log.info(`[方式C] JWT found (${jwt.substring(0, 20)}...) userId=${userId}`);
    return buildAuth(jwt, wsUrl, userId, res, 'page_html');
  } catch (err: any) {
    log.error(`[方式C] JSON parse failed: ${err.message}`);
    return null;
  }
}

// ----- 方式B: REST API /config -----

export async function fetchAuthFromConfig(): Promise<StripchatAuth | null> {
  log.info('[方式B] Fetching /api/front/v2/config');

  try {
    const res = await fetch('https://stripchat.com/api/front/v2/config', {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'Accept-Language': 'ja,en-US;q=0.9',
      },
    });

    if (!res.ok) {
      log.warn(`[方式B] HTTP ${res.status}`);
      return null;
    }

    const config = await res.json() as Record<string, unknown>;

    const jwt =
      (config as any)?.centrifugoToken ||
      (config as any)?.data?.centrifugoToken ||
      (config as any)?.config?.centrifugoToken ||
      findNestedValue(config, 'centrifugoToken') ||
      '';

    const wsUrl =
      (config as any)?.webSocketUrl ||
      (config as any)?.data?.webSocketUrl ||
      findNestedValue(config, 'webSocketUrl') ||
      'wss://websocket-sp-v6.stripchat.com/connection/websocket';

    if (!jwt) {
      log.warn('[方式B] JWT not found in config response');
      const keys = Object.keys(config).join(', ');
      log.debug(`[方式B] Config keys: ${keys}`);

      const jwtCandidate = findJwtInObject(config);
      if (jwtCandidate) {
        log.info('[方式B] Found JWT candidate via deep search');
        return buildAuth(jwtCandidate, wsUrl, '', null, 'rest_api');
      }

      return null;
    }

    log.info(`[方式B] JWT found (${jwt.substring(0, 20)}...)`);
    return buildAuth(jwt, wsUrl, '', null, 'rest_api');
  } catch (err: any) {
    log.error(`[方式B] Failed: ${err.message}`);
    return null;
  }
}

// ----- Helpers -----

function buildAuth(
  jwt: string,
  wsUrl: string,
  userId: string,
  res: Response | null,
  method: StripchatAuth['method'],
): StripchatAuth {
  // Extract cf_clearance from response cookies
  let cfClearance = '';
  if (res) {
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const cookie of setCookies) {
      const match = cookie.match(/cf_clearance=([^;]+)/);
      if (match) cfClearance = match[1];
    }
  }

  return {
    jwt,
    cfClearance,
    wsUrl,
    userId,
    expiresAt: getJwtExpiry(jwt),
    method,
  };
}

/** Recursively search for a key in nested objects (max depth 5) */
function findNestedValue(
  obj: unknown,
  key: string,
  depth = 0,
): string | null {
  if (depth > 5 || !obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  if (key in record && typeof record[key] === 'string') {
    return record[key] as string;
  }
  for (const v of Object.values(record)) {
    if (v && typeof v === 'object') {
      const found = findNestedValue(v, key, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Search for JWT-like strings (eyJ...) in nested objects */
function findJwtInObject(obj: unknown, depth = 0): string | null {
  if (depth > 4 || !obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && v.startsWith('eyJ') && v.includes('.')) {
      // Looks like a JWT
      const parts = v.split('.');
      if (parts.length === 3 && parts[1].length > 10) {
        log.debug(`[JWT-scan] Found at key "${k}": ${v.substring(0, 30)}...`);
        return v;
      }
    }
    if (v && typeof v === 'object') {
      const found = findJwtInObject(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
