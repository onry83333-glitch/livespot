/**
 * LiveSpot Collector — Entry point
 *
 * Node.js resident process for Stripchat data collection.
 * Polls REST APIs for cast status and viewer lists.
 * Writes to Supabase (spy_messages, spy_viewers, paid_users).
 *
 * Usage:
 *   npm run dev   — development (tsx watch)
 *   npm start     — production (tsx)
 */

import { loadTargets, getSupabase, POLL_INTERVALS, BATCH_CONFIG } from './config.js';
import { registerTarget, startCollector, stopCollector, closeAllActiveSessions, getRegisteredCount, getStatus } from './collector.js';
import { startBatchFlush, stopBatchFlush, closeOrphanSessions } from './storage/supabase.js';
import { flushProfiles, getProfileCount } from './storage/spy-profiles.js';
import { createLogger, setLogLevel } from './utils/logger.js';
import { getAuth } from './auth/index.js';
import { TriggerEngine } from './triggers/index.js';
import { evaluateAlerts } from './alerts/index.js';
import { runCoinSync } from './coin-sync.js';

const log = createLogger('main');

// Set log level from env
const envLevel = process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined;
if (envLevel) setLogLevel(envLevel);

async function main(): Promise<void> {
  log.info('========================================');
  log.info('LiveSpot Collector starting...');
  log.info(`Status poll: ${POLL_INTERVALS.statusSec}s, Viewer poll: ${POLL_INTERVALS.viewerSec}s`);
  log.info(`Batch: ${BATCH_CONFIG.maxSize} rows / ${BATCH_CONFIG.flushIntervalMs}ms`);
  log.info('========================================');

  // 0. Pre-fetch auth (JWT + cf_clearance)
  try {
    const auth = await getAuth();
    log.info(`Auth: method=${auth.method}, jwt=${auth.jwt ? 'yes' : 'no'}, cf_clearance=${auth.cfClearance ? 'yes' : 'no'}`);
    if (!auth.jwt) {
      log.warn('No JWT token — WebSocket connections will fail (3501)');
      log.warn('Set STRIPCHAT_JWT in .env or enable AUTH_AUTO_REFRESH');
    }
  } catch (err) {
    log.warn('Auth pre-fetch failed — REST polling still works, WS may fail', err);
  }

  // 1. Load targets from spy_casts + registered_casts
  const targets = await loadTargets();

  if (targets.length === 0) {
    log.warn('No monitoring targets found. Add casts to registered_casts or spy_casts.');
    log.info('Waiting for targets... (will reload every 60s)');

    // Keep alive and retry
    const retryInterval = setInterval(async () => {
      const newTargets = await loadTargets();
      if (newTargets.length > 0) {
        clearInterval(retryInterval);
        for (const t of newTargets) registerTarget(t);
        startBatchFlush();
        startCollector();
      }
    }, 60000);

    return;
  }

  // 2. Register all targets
  for (const t of targets) {
    registerTarget(t);
  }

  log.info(`Registered ${getRegisteredCount()} targets`);

  // 2.5. Close orphan sessions from previous runs
  try {
    const closed = await closeOrphanSessions(6);
    if (closed > 0) {
      log.info(`Closed ${closed} orphan session(s) from previous runs`);
    }
  } catch (err) {
    log.warn('Orphan session cleanup failed (RPC may not exist yet)', err);
  }

  // 3. Start batch flush timer
  startBatchFlush();

  // 4. Periodic target reload (every 5 minutes — pick up new casts)
  setInterval(async () => {
    try {
      const freshTargets = await loadTargets();
      for (const t of freshTargets) {
        registerTarget(t); // no-op if already registered
      }
    } catch (err) {
      log.error('Failed to reload targets', err);
    }
  }, 5 * 60 * 1000);

  // 5. Periodic profile flush (every 10 minutes)
  setInterval(async () => {
    const count = getProfileCount();
    if (count === 0) return;

    // Flush for each unique account
    const accountIds = new Set(targets.map((t) => t.accountId));
    for (const accountId of accountIds) {
      await flushProfiles(accountId);
    }
  }, 10 * 60 * 1000);

  // 5.5. spy_user_profiles 定期更新 (6時間ごと + 起動時1回)
  const refreshSpyUserProfiles = async () => {
    const accountIds = new Set(targets.map((t) => t.accountId));
    const supabase = getSupabase();
    for (const accountId of accountIds) {
      try {
        const { data, error } = await supabase.rpc('refresh_spy_user_profiles', {
          p_account_id: accountId,
          p_days: 30,
        });
        if (error) {
          log.error(`spy_user_profiles refresh failed for ${accountId}: ${error.message}`);
        } else {
          log.info(`spy_user_profiles refreshed for ${accountId}: ${data} rows`);
        }
      } catch (err) {
        log.error(`spy_user_profiles refresh error for ${accountId}`, err);
      }
    }
  };

  // 初回実行（起動30秒後 — DB接続安定後）
  setTimeout(() => refreshSpyUserProfiles(), 30 * 1000);

  // 6時間ごとに再実行
  setInterval(() => refreshSpyUserProfiles(), 6 * 60 * 60 * 1000);

  // 6. Status report (every 1 minute) + Supabase health write
  setInterval(async () => {
    const statuses = getStatus();
    const online = statuses.filter((s) => s.status === 'public' || s.status === 'private' || s.status === 'p2p');
    const wsConnected = statuses.filter((s) => s.wsConnected);
    const totalMsgs = statuses.reduce((sum, s) => sum + s.wsMessages, 0);
    const totalTips = statuses.reduce((sum, s) => sum + s.wsTips, 0);

    log.info(`[HEALTH] ${online.length}/${statuses.length} online, ${wsConnected.length} WS, ${totalMsgs} msgs, ${totalTips}tk, ${getProfileCount()} profiles`);
    for (const s of online) {
      log.info(`  ${s.castName}: ${s.status} (${s.viewerCount} viewers) WS=${s.wsConnected ? 'ON' : 'off'} ${s.wsMessages}msg ${s.wsTips}tk`);
    }

    // Write health to pipeline_status (pipeline_name = 'Collector')
    try {
      const sb = getSupabase();
      const detailParts = [
        `${online.length}/${statuses.length}配信中`,
        `WS=${wsConnected.length}`,
        `${totalMsgs}msg`,
        `${totalTips}tk`,
      ];
      await sb.from('pipeline_status').upsert({
        pipeline_name: 'Collector',
        status: 'auto',
        source: 'Stripchat WS+REST',
        destination: 'spy_messages',
        detail: detailParts.join(', '),
        last_run_at: new Date().toISOString(),
        last_success: true,
      }, { onConflict: 'pipeline_name' });
    } catch (err) {
      log.debug('Health write failed', err);
    }
  }, 60 * 1000);

  // 7. Alert evaluation (every 1 hour + 起動2分後に初回)
  const accountIds = [...new Set(targets.map((t) => t.accountId))];

  const runAlerts = async () => {
    try {
      await evaluateAlerts(accountIds);
    } catch (err) {
      log.error('Alert evaluation failed', err);
    }
  };

  // 初回: 起動2分後（DB接続安定後）
  setTimeout(() => runAlerts(), 2 * 60 * 1000);
  // 定期: 1時間ごと
  setInterval(() => runAlerts(), 60 * 60 * 1000);

  // 8. Initialize Trigger Engine
  const triggerEngine = new TriggerEngine();
  try {
    await triggerEngine.refreshTriggers();
    // Initialize segment snapshots for scheduled evaluations
    for (const accountId of accountIds) {
      await triggerEngine.initSnapshots(accountId);
    }
    log.info('TriggerEngine initialized');
  } catch (err) {
    log.warn('TriggerEngine init failed (triggers disabled)', err);
  }

  // 8.1. Scheduled trigger evaluation (every 1 hour)
  setInterval(async () => {
    try {
      await triggerEngine.evaluateScheduled();
    } catch (err) {
      log.error('Scheduled trigger evaluation failed', err);
    }
  }, 60 * 60 * 1000);

  // 8.2. Post-session queue processing (every 1 minute)
  setInterval(async () => {
    try {
      await triggerEngine.processPostSessionQueue();
    } catch (err) {
      log.error('Post-session queue processing failed', err);
    }
  }, 60 * 1000);

  // 8.3. Trigger definition refresh (every 5 minutes)
  setInterval(async () => {
    try {
      await triggerEngine.refreshTriggers();
    } catch (err) {
      log.error('Trigger refresh failed', err);
    }
  }, 5 * 60 * 1000);

  // 9. Coin sync (every 2 hours + 起動1分後に初回)
  const runCoinSyncSafe = async () => {
    try {
      await runCoinSync();
    } catch (err) {
      log.error('Coin sync failed', err);
    }
  };

  // 初回: 起動1分後（DB安定後）
  setTimeout(() => runCoinSyncSafe(), 60 * 1000);
  // 定期: 2時間ごと
  setInterval(() => runCoinSyncSafe(), 2 * 60 * 60 * 1000);
  log.info('Coin sync scheduled (2h interval)');

  // 10. Start main polling loop
  log.info('Starting collector loop...');
  startCollector(triggerEngine);
}

// ----- Graceful shutdown -----
async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received — shutting down...`);
  stopCollector();

  // Close all active sessions in DB before exiting
  try {
    const closed = await closeAllActiveSessions();
    log.info(`Shutdown: closed ${closed} active session(s)`);
  } catch (err) {
    log.error('Shutdown: failed to close active sessions', err);
  }

  stopBatchFlush();
  log.info('Collector stopped. Goodbye.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ----- Run -----
main().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
