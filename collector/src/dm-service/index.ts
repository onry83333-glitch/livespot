/**
 * DM Service — サーバーサイド常駐DM送信プロセス
 *
 * Chrome拡張からの移行先。pm2 で常駐し、dm_send_log キューをポーリングして
 * Stripchat HTTP API経由でDM送信する。
 *
 * 起動: npx tsx src/dm-service/index.ts
 * PM2:  pm2 start ecosystem.config.cjs --only dm-service
 *
 * 環境変数:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — 必須
 *   DM_POLL_INTERVAL_MS   — ポーリング間隔 (default: 10000)
 *   DM_SEND_INTERVAL_MS   — 送信間隔 (default: 3000)
 *   DM_DAILY_LIMIT        — 日次上限 (default: 5000)
 *   DM_BATCH_SIZE         — 1ポーリングあたりの取得数 (default: 20)
 *   DM_COOLDOWN_HOURS     — 同一ユーザー再送信ブロック時間 (default: 24)
 *   DM_ACCOUNT_ID         — 対象アカウントID (default: 全アカウント)
 *   DM_CAST_NAME          — 対象キャスト名フィルタ (default: null=全キャスト)
 */
import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { StripchatDMApi, type SessionData } from './stripchat-api.js';
import { fetchQueuedTasks, markSending, markSuccess, markError, markBlockedTestMode, markBlockedNoCampaign, requeue, getQueueCount } from './queue.js';
import { waitForSlot, checkDailyLimit, isUserOnCooldown, SEND_INTERVAL_MS, DAILY_LIMIT } from './rate-limiter.js';
import {
  getActiveSession, invalidateSession,
  buildCastIdentityMap, verifyCastIdentity, isValidCampaign, isMissingCampaign,
  checkTestModeBlock, DM_TEST_MODE, TEST_WHITELIST,
  resolveUserIdCached,
} from './safety.js';

// ============================================================
// Config
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[dm-service] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定');
  process.exit(1);
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const POLL_INTERVAL_MS = parseInt(process.env.DM_POLL_INTERVAL_MS || '10000', 10);
const BATCH_SIZE = parseInt(process.env.DM_BATCH_SIZE || '20', 10);
const ACCOUNT_ID = process.env.DM_ACCOUNT_ID || '';
const CAST_NAME = process.env.DM_CAST_NAME || null;

// ============================================================
// State
// ============================================================

let running = true;
let cycleCount = 0;
let totalSent = 0;
let totalErrors = 0;

// ============================================================
// Logging
// ============================================================

function log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [dm-service] [${level.toUpperCase()}]`;
  if (data) {
    console[level](`${prefix} ${msg}`, JSON.stringify(data));
  } else {
    console[level](`${prefix} ${msg}`);
  }
}

// ============================================================
// Main processing loop
// ============================================================

async function getTargetAccounts(): Promise<string[]> {
  if (ACCOUNT_ID) return [ACCOUNT_ID];

  // 全アカウントのキューを確認
  const { data } = await sb
    .from('dm_send_log')
    .select('account_id')
    .eq('status', 'queued')
    .limit(100);

  if (!data) return [];
  return [...new Set(data.map(d => d.account_id))];
}

async function processBatch(accountId: string): Promise<{ sent: number; errors: number; skipped: number }> {
  let sent = 0;
  let errors = 0;
  let skipped = 0;

  // 1. 日次上限チェック
  const dailyCheck = await checkDailyLimit(sb, accountId);
  if (!dailyCheck.allowed) {
    log('warn', `日次上限到達 (${dailyCheck.sentToday}/${DAILY_LIMIT})`, { accountId });
    return { sent: 0, errors: 0, skipped: 0 };
  }

  // 2. 有効セッション取得
  const session = await getActiveSession(sb, accountId);
  if (!session) {
    log('warn', 'アクティブなセッションなし — スキップ', { accountId });
    return { sent: 0, errors: 0, skipped: 0 };
  }

  // 3. キャスト身元検証マップ構築
  const identity = await buildCastIdentityMap(sb, accountId, session.stripchat_user_id);

  // 4. キュー取得
  const tasks = await fetchQueuedTasks(sb, accountId, CAST_NAME, BATCH_SIZE);
  if (tasks.length === 0) return { sent: 0, errors: 0, skipped: 0 };

  log('info', `${tasks.length}件のタスクを処理開始`, { accountId });

  // 5. StripchatDMApi インスタンス
  const api = new StripchatDMApi(session);

  // 6. 1件ずつ処理
  for (const task of tasks) {
    // 6a-0. キャンペーン必須ゲート（campaign_id NULL → ブロック）
    if (isMissingCampaign(task.campaign)) {
      log('warn', `campaign_id未設定 — ブロック: ${task.user_name}`, { taskId: task.id });
      await markBlockedNoCampaign(sb, task.id);
      skipped++;
      continue;
    }

    // 6a-1. キャンペーンフォーマット検証
    if (!isValidCampaign(task.campaign)) {
      log('warn', `不正なcampaign形式: "${task.campaign}" — ブロック`, { taskId: task.id });
      await markError(sb, task.id, `不正なcampaign形式: "${task.campaign}" — 許可: TEST/pipe/seq/bulk/trigger_/_sched_`);
      skipped++;
      continue;
    }

    // 6a-2. テストモードチェック（ホワイトリスト外 → ブロック）
    const testBlock = checkTestModeBlock(task.user_name);
    if (testBlock) {
      log('warn', testBlock, { taskId: task.id, campaign: task.campaign });
      await markBlockedTestMode(sb, task.id, task.user_name);
      skipped++;
      continue;
    }

    // 6b. キャスト身元検証 (P0-5)
    const identityError = verifyCastIdentity(identity, task.cast_name);
    if (identityError) {
      log('error', identityError, { taskId: task.id });
      await markError(sb, task.id, identityError);
      errors++;
      // 身元不一致は全件停止
      for (const remaining of tasks.slice(tasks.indexOf(task) + 1)) {
        await markError(sb, remaining.id, identityError);
        errors++;
      }
      return { sent, errors, skipped };
    }

    // 6c. ユーザークールダウンチェック
    if (await isUserOnCooldown(sb, accountId, task.cast_name, task.user_name)) {
      log('info', `クールダウン中: ${task.user_name} — スキップ`, { taskId: task.id });
      skipped++;
      continue;
    }

    // 6d. ステータスを sending に
    await markSending(sb, task.id);

    // 6e. userId 解決（キャッシュ → API）
    let targetUserId = task.target_user_id ? String(task.target_user_id) : null;

    if (!targetUserId) {
      targetUserId = await resolveUserIdCached(sb, task.user_name, accountId, task.cast_name);
    }
    if (!targetUserId) {
      const resolved = await api.resolveUserId(task.user_name);
      targetUserId = resolved.userId;
      if (!targetUserId) {
        await markError(sb, task.id, `userId解決失敗: ${resolved.error}`);
        errors++;
        continue;
      }
    }

    // 6f. レート制限待機
    await waitForSlot();

    // 6f-2. 送信前ログ（本番モードはWARN）
    const sendLogLevel = DM_TEST_MODE ? 'info' : 'warn';
    log(sendLogLevel, `SENDING DM: from=${task.cast_name} to=${task.user_name} campaign=${task.campaign} test_mode=${DM_TEST_MODE}`, { taskId: task.id });

    // 6g. DM送信
    try {
      // send_order に応じた送信ロジック
      let result;

      if (task.send_order === 'image_only' && task.image_url) {
        // 画像のみ送信
        const imgBuf = await fetchImage(task.image_url);
        if (imgBuf) {
          const upload = await api.uploadPhoto(imgBuf);
          if (upload.success && upload.mediaId) {
            result = await api.sendDM(targetUserId, '', task.user_name, { mediaId: upload.mediaId });
          } else {
            result = { success: false, error: `画像アップロード失敗: ${upload.error}`, sessionExpired: upload.sessionExpired };
          }
        } else {
          result = { success: false, error: '画像ダウンロード失敗', sessionExpired: false };
        }
      } else if (task.send_order === 'text_then_image' && task.image_url) {
        // テキスト → 画像
        result = await api.sendDM(targetUserId, task.message, task.user_name);
        if (result.success) {
          const imgBuf = await fetchImage(task.image_url);
          if (imgBuf) {
            const upload = await api.uploadPhoto(imgBuf);
            if (upload.success && upload.mediaId) {
              await api.sendDM(targetUserId, '', task.user_name, { mediaId: upload.mediaId });
            }
          }
        }
      } else if (task.send_order === 'image_then_text' && task.image_url) {
        // 画像 → テキスト
        const imgBuf = await fetchImage(task.image_url);
        if (imgBuf) {
          const upload = await api.uploadPhoto(imgBuf);
          if (upload.success && upload.mediaId) {
            await api.sendDM(targetUserId, '', task.user_name, { mediaId: upload.mediaId });
          }
        }
        result = await api.sendDM(targetUserId, task.message, task.user_name);
      } else {
        // text_only (デフォルト)
        result = await api.sendDM(targetUserId, task.message, task.user_name);
      }

      if (result.success) {
        await markSuccess(sb, task.id);
        sent++;
        log('info', `送信成功: ${task.user_name}`, { taskId: task.id, messageId: result.messageId });
      } else {
        await markError(sb, task.id, result.error || 'Unknown error');
        errors++;
        log('warn', `送信失敗: ${task.user_name}: ${result.error}`, { taskId: task.id });

        // セッション切れ → 残りをrequeue して中断
        if (result.sessionExpired) {
          log('error', 'セッション期限切れ — 残りをrequueして中断', { sessionId: session.id });
          await invalidateSession(sb, session.id);
          for (const remaining of tasks.slice(tasks.indexOf(task) + 1)) {
            await requeue(sb, remaining.id);
          }
          return { sent, errors, skipped };
        }
      }
    } catch (err) {
      await markError(sb, task.id, String(err));
      errors++;
      log('error', `例外: ${task.user_name}: ${err}`, { taskId: task.id });
    }
  }

  return { sent, errors, skipped };
}

/**
 * Supabase Storage / 外部URLから画像をダウンロード
 */
async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

// ============================================================
// Polling loop
// ============================================================

async function pollLoop(): Promise<void> {
  log('info', 'DM Service 起動', {
    pollIntervalMs: POLL_INTERVAL_MS,
    sendIntervalMs: SEND_INTERVAL_MS,
    dailyLimit: DAILY_LIMIT,
    batchSize: BATCH_SIZE,
    accountId: ACCOUNT_ID || '(全アカウント)',
    castName: CAST_NAME || '(全キャスト)',
    testMode: DM_TEST_MODE,
    whitelist: DM_TEST_MODE ? [...TEST_WHITELIST] : '(無効)',
  });

  // PM2 ready signal
  if (typeof process.send === 'function') {
    process.send('ready');
  }

  while (running) {
    cycleCount++;

    try {
      const accounts = await getTargetAccounts();

      for (const accountId of accounts) {
        const result = await processBatch(accountId);
        totalSent += result.sent;
        totalErrors += result.errors;

        if (result.sent > 0 || result.errors > 0) {
          log('info', `バッチ完了`, {
            accountId,
            sent: result.sent,
            errors: result.errors,
            skipped: result.skipped,
            totalSent,
            totalErrors,
          });
        }
      }
    } catch (err) {
      log('error', `ポーリングエラー: ${err}`);
    }

    // 次のポーリングまで待機
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  log('info', 'DM Service 停止', { totalSent, totalErrors, cycles: cycleCount });
}

// ============================================================
// Graceful shutdown
// ============================================================

process.on('SIGINT', () => {
  log('info', 'SIGINT 受信 — 停止中...');
  running = false;
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM 受信 — 停止中...');
  running = false;
});

// ============================================================
// Entry point
// ============================================================

pollLoop().catch(err => {
  log('error', `致命的エラー: ${err}`);
  process.exit(1);
});
