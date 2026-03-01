/**
 * auth/index.ts — 統合認証モジュール
 *
 * フォールバックチェーン:
 *   1. メモリキャッシュ（有効期限内）
 *   2. 方式C: ページHTML → __PRELOADED_STATE__
 *   3. 方式B: REST API /config
 *   4. 方式A: Playwright headless（Cloudflare突破、JWT WS傍受）
 *   5. .envフォールバック（手動設定）
 */

import { createLogger } from '../utils/logger.js';
import { AUTH_CONFIG, PLAYWRIGHT_CONFIG } from '../config.js';
import {
  StripchatAuth,
  fetchAuthFromPage,
  fetchAuthFromConfig,
} from './stripchat-auth.js';
import { fetchAuthViaPlaywright } from './playwright-auth.js';

const log = createLogger('auth');

// ----- In-memory cache -----
let cachedAuth: StripchatAuth | null = null;

const EXPIRY_MARGIN_SEC = 300; // Refresh 5 minutes before expiry

function isCacheValid(): boolean {
  if (!cachedAuth) return false;
  const now = Math.floor(Date.now() / 1000);
  return cachedAuth.expiresAt - EXPIRY_MARGIN_SEC > now;
}

// ----- Mutex: 同時auth取得を防止 -----
let authInFlight: Promise<StripchatAuth> | null = null;

// ----- Public API -----

export async function getAuth(modelName?: string): Promise<StripchatAuth> {
  // 1. Cache
  if (isCacheValid()) {
    log.debug('Using cached auth');
    return cachedAuth!;
  }

  // 2. 既にauth取得中なら、その結果を待つ（Playwright多重起動防止）
  if (authInFlight) {
    log.debug('Auth refresh already in flight — waiting...');
    return authInFlight;
  }

  // 3. auth取得開始 — ロック獲得
  authInFlight = doGetAuth(modelName);
  try {
    return await authInFlight;
  } finally {
    authInFlight = null;
  }
}

async function doGetAuth(modelName?: string): Promise<StripchatAuth> {
  // Auto-refresh chain
  if (AUTH_CONFIG.autoRefresh) {
    // 方式C: ページHTML
    const pageAuth = await fetchAuthFromPage(modelName || 'Risa_06');
    if (pageAuth) {
      cachedAuth = pageAuth;
      log.info(`Auth acquired via ${pageAuth.method} (expires ${new Date(pageAuth.expiresAt * 1000).toLocaleTimeString('ja-JP')})`);
      return pageAuth;
    }

    // 方式B: REST API
    const configAuth = await fetchAuthFromConfig();
    if (configAuth) {
      cachedAuth = configAuth;
      log.info(`Auth acquired via ${configAuth.method}`);
      return configAuth;
    }

    // 方式A: Playwright headless（Cloudflare突破 + WS JWT傍受）
    const playwrightAuth = await fetchAuthViaPlaywright({
      modelName: modelName || 'Risa_06',
      timeoutMs: PLAYWRIGHT_CONFIG.timeoutMs,
      username: PLAYWRIGHT_CONFIG.username || undefined,
      password: PLAYWRIGHT_CONFIG.password || undefined,
      headless: PLAYWRIGHT_CONFIG.headless,
    });
    if (playwrightAuth) {
      cachedAuth = playwrightAuth;
      log.info(`Auth acquired via ${playwrightAuth.method} (expires ${new Date(playwrightAuth.expiresAt * 1000).toLocaleTimeString('ja-JP')})`);
      return playwrightAuth;
    }
  }

  // .env fallback
  if (AUTH_CONFIG.jwt) {
    log.info('Using .env fallback JWT');
    const envAuth: StripchatAuth = {
      jwt: AUTH_CONFIG.jwt,
      cfClearance: AUTH_CONFIG.cfClearance,
      wsUrl: 'wss://websocket-sp-v6.stripchat.com/connection/websocket',
      userId: '',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      method: 'env',
    };
    cachedAuth = envAuth;
    return envAuth;
  }

  // All failed
  log.error('All auth methods failed. WS connection will likely fail.');
  return {
    jwt: '',
    cfClearance: '',
    wsUrl: 'wss://websocket-sp-v6.stripchat.com/connection/websocket',
    userId: '',
    expiresAt: 0,
    method: 'env',
  };
}

/** Force refresh (invalidate cache) */
export function invalidateAuth(): void {
  cachedAuth = null;
  log.info('Auth cache invalidated');
}

/** Check if we have valid auth */
export function hasValidAuth(): boolean {
  return isCacheValid();
}

export type { StripchatAuth };
