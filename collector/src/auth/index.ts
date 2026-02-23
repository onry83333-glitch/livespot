/**
 * auth/index.ts — 統合認証モジュール
 *
 * フォールバックチェーン:
 *   1. メモリキャッシュ（有効期限内）
 *   2. 方式C: ページHTML → __PRELOADED_STATE__
 *   3. 方式B: REST API /config
 *   4. .envフォールバック（手動設定）
 */

import { createLogger } from '../utils/logger.js';
import { AUTH_CONFIG } from '../config.js';
import {
  StripchatAuth,
  fetchAuthFromPage,
  fetchAuthFromConfig,
} from './stripchat-auth.js';

const log = createLogger('auth');

// ----- In-memory cache -----
let cachedAuth: StripchatAuth | null = null;

const EXPIRY_MARGIN_SEC = 300; // Refresh 5 minutes before expiry

function isCacheValid(): boolean {
  if (!cachedAuth) return false;
  const now = Math.floor(Date.now() / 1000);
  return cachedAuth.expiresAt - EXPIRY_MARGIN_SEC > now;
}

// ----- Public API -----

export async function getAuth(modelName?: string): Promise<StripchatAuth> {
  // 1. Cache
  if (isCacheValid()) {
    log.debug('Using cached auth');
    return cachedAuth!;
  }

  // 2. Auto-refresh chain
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
  }

  // 3. .env fallback
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

  // 4. All failed
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
