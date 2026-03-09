/**
 * Auth Manager — 独立プロセスとして認証を一元管理
 *
 * 認証フロー:
 *   1. 起動時: .auth/current.json から復元 → 有効なら再利用
 *   2. 無効/期限切れ: Playwright headless で新規取得
 *   3. 期限切れ30分前: 自動リフレッシュ（タイマー監視）
 *   4. HTTPサーバー: GET /auth でキャストプロセスに認証データ提供
 *   5. ファイル永続化: .auth/current.json に常時書き出し
 *
 * 実行: node --import tsx src/auth-manager/index.ts
 * PM2:  pm2 start ecosystem.config.cjs --only auth-manager
 */

import 'dotenv/config';
import * as store from './store.js';
import { startServer, setRefreshCallback } from './server.js';

// --- Playwright auth (dynamic import: 既存モジュール再利用) ---

async function acquireAuth(): Promise<void> {
  const modelName = process.env.AUTH_TARGET_MODEL || 'Risa_06';
  const timeoutMs = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '60000', 10);
  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false';
  const username = process.env.STRIPCHAT_USERNAME || undefined;
  const password = process.env.STRIPCHAT_PASSWORD || undefined;

  console.log(`[auth-manager] Acquiring auth via Playwright (model=${modelName}, headless=${headless})...`);
  const startTime = Date.now();

  try {
    const { fetchAuthViaPlaywright } = await import('../auth/playwright-auth.js');
    const auth = await fetchAuthViaPlaywright({
      modelName,
      timeoutMs,
      username,
      password,
      headless,
    });

    if (!auth || !auth.jwt) {
      console.error('[auth-manager] Playwright returned no auth');
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const existing = store.get();
    const refreshCount = (existing?.refreshCount ?? 0) + 1;

    store.set({
      jwt: auth.jwt,
      cfClearance: auth.cfClearance,
      wsUrl: auth.wsUrl,
      userId: auth.userId,
      expiresAt: auth.expiresAt,
      method: auth.method,
      acquiredAt: new Date().toISOString(),
      refreshCount,
    });

    const remaining = store.remainingSeconds();
    console.log(`[auth-manager] Auth acquired in ${elapsed}s (method=${auth.method}, userId=${auth.userId}, remaining=${remaining}s, refreshCount=${refreshCount})`);
  } catch (err) {
    console.error('[auth-manager] Auth acquisition failed:', err);
  }
}

// --- Refresh loop ---

const REFRESH_MARGIN_SEC = 30 * 60; // 期限の30分前にリフレッシュ
const CHECK_INTERVAL_MS = 60_000;   // 1分ごとにチェック
let refreshInProgress = false;

async function checkAndRefresh(): Promise<void> {
  if (refreshInProgress) return;

  const remaining = store.remainingSeconds();

  // 認証なし or 30分以内に期限切れ → リフレッシュ
  if (remaining <= REFRESH_MARGIN_SEC) {
    refreshInProgress = true;
    try {
      if (remaining === 0) {
        console.log('[auth-manager] No valid auth — acquiring...');
      } else {
        console.log(`[auth-manager] Auth expiring in ${remaining}s — refreshing...`);
      }
      await acquireAuth();
    } finally {
      refreshInProgress = false;
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('  Auth Manager — Stripchat認証一元管理');
  console.log('='.repeat(50));
  console.log(`  REFRESH_MARGIN: ${REFRESH_MARGIN_SEC}s (${REFRESH_MARGIN_SEC / 60}min)`);
  console.log(`  CHECK_INTERVAL: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`  TARGET_MODEL:   ${process.env.AUTH_TARGET_MODEL || 'Risa_06'}`);
  console.log(`  USERNAME:       ${process.env.STRIPCHAT_USERNAME ? '***' : '(not set)'}`);
  console.log('');

  // 1. ファイルから復元
  const restored = store.restore();
  if (restored && store.isValid(REFRESH_MARGIN_SEC)) {
    console.log(`[auth-manager] Restored from file (remaining=${store.remainingSeconds()}s, method=${restored.method})`);
  } else {
    // 2. 新規取得
    await acquireAuth();
  }

  // 3. HTTPサーバー起動
  setRefreshCallback(acquireAuth);
  await startServer();

  // 4. 定期チェックループ
  setInterval(checkAndRefresh, CHECK_INTERVAL_MS);

  // 5. Graceful shutdown
  const shutdown = () => {
    console.log('\n[auth-manager] Shutting down...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[auth-manager] Ready. Refresh loop active.');
}

main().catch((err) => {
  console.error('[auth-manager] Fatal error:', err);
  process.exit(1);
});
