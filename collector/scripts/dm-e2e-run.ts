/**
 * DM E2E Test — dm-serviceロジックを1回だけ実行してすぐ終了
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { StripchatDMApi, type SessionData } from '../src/dm-service/stripchat-api.js';
import { fetchQueuedTasks, markSending, markSuccess, markError } from '../src/dm-service/queue.js';
import { checkDailyLimit, isUserOnCooldown, waitForSlot } from '../src/dm-service/rate-limiter.js';
import { getActiveSession, buildCastIdentityMap, verifyCastIdentity, isValidCampaign, resolveUserIdCached } from '../src/dm-service/safety.js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

async function main() {
  console.log('=== DM E2E Test — Single Run ===\n');

  // 1. Daily limit check
  const daily = await checkDailyLimit(sb, ACCOUNT_ID);
  console.log('Daily limit:', JSON.stringify(daily));

  // 2. Active session
  const session = await getActiveSession(sb, ACCOUNT_ID);
  if (!session) {
    console.error('ERROR: No active session found');
    process.exit(1);
  }
  console.log('Session found:', {
    id: session.id.slice(0, 8),
    userId: session.stripchat_user_id,
    csrf: session.csrf_token ? 'OK' : 'MISSING',
    cookieKeys: Object.keys(session.cookies_json).length,
  });

  // 3. Cast identity map
  const identity = await buildCastIdentityMap(sb, ACCOUNT_ID, session.stripchat_user_id);
  console.log('Cast identity map:', Object.fromEntries(identity.map));
  console.log('Session userId:', identity.sessionUserId);

  // 4. Fetch queued tasks
  const tasks = await fetchQueuedTasks(sb, ACCOUNT_ID, null, 20);
  console.log('\nQueued tasks:', tasks.length);

  if (tasks.length === 0) {
    console.log('No queued tasks found');
    process.exit(0);
  }

  for (const t of tasks) {
    console.log(`  ID=${t.id} user=${t.user_name} cast=${t.cast_name} campaign=${t.campaign} target=${t.target_user_id}`);
  }

  // 5. Process each task
  const api = new StripchatDMApi(session);

  // Test connection first
  console.log('\nTesting Stripchat API connection...');
  const connTest = await api.testConnection();
  console.log('Connection test:', JSON.stringify(connTest));

  if (!connTest.ok) {
    console.error('Connection test failed — session may be expired');
  }

  console.log('\n=== Processing tasks ===\n');

  for (const task of tasks) {
    console.log(`--- Task ${task.id}: ${task.user_name} ---`);

    // Campaign validation
    if (!isValidCampaign(task.campaign)) {
      console.log('  SKIP: Invalid campaign format');
      continue;
    }
    console.log('  Campaign: OK');

    // Cast identity check
    const identityErr = verifyCastIdentity(identity, task.cast_name);
    if (identityErr) {
      console.log('  ERROR: ' + identityErr);
      await markError(sb, task.id, identityErr);
      continue;
    }
    console.log('  Identity: OK');

    // Cooldown check
    const onCooldown = await isUserOnCooldown(sb, ACCOUNT_ID, task.cast_name, task.user_name);
    if (onCooldown) {
      console.log('  SKIP: User on cooldown');
      continue;
    }
    console.log('  Cooldown: OK');

    // Mark as sending
    await markSending(sb, task.id);
    console.log('  Status → sending');

    // Resolve userId
    let targetUserId = task.target_user_id ? String(task.target_user_id) : null;

    if (!targetUserId) {
      console.log('  Resolving userId from paid_users cache...');
      targetUserId = await resolveUserIdCached(sb, task.user_name, ACCOUNT_ID, task.cast_name);
      if (targetUserId) {
        console.log('  Resolved from cache: ' + targetUserId);
      }
    }

    if (!targetUserId) {
      console.log('  Resolving userId from Stripchat API...');
      const resolved = await api.resolveUserId(task.user_name);
      targetUserId = resolved.userId;
      if (!targetUserId) {
        console.log('  FAILED: ' + resolved.error);
        await markError(sb, task.id, 'userId解決失敗: ' + resolved.error);
        continue;
      }
      console.log('  Resolved from API: ' + targetUserId);
    }

    console.log('  Target userId: ' + targetUserId);

    // Rate limit wait
    await waitForSlot();

    // Send DM
    console.log('  Sending DM...');
    try {
      const result = await api.sendDM(targetUserId, task.message, task.user_name);
      console.log('  Result:', JSON.stringify(result));

      if (result.success) {
        await markSuccess(sb, task.id);
        console.log('  ✅ Status → success (messageId: ' + result.messageId + ')');
      } else {
        await markError(sb, task.id, result.error || 'Unknown error');
        console.log('  ❌ Status → error: ' + result.error);

        if (result.sessionExpired) {
          console.log('  ⚠️ Session expired — stopping');
          break;
        }
      }
    } catch (err) {
      await markError(sb, task.id, String(err));
      console.log('  ❌ Exception: ' + err);
    }

    console.log('');
  }

  // 6. Check final status
  console.log('\n=== Final Status ===');
  const { data: results } = await sb
    .from('dm_send_log')
    .select('id, user_name, status, error, sent_at, sent_via')
    .in('id', tasks.map(t => t.id));

  for (const r of results!) {
    console.log(`  ID=${r.id} user=${r.user_name} status=${r.status} sent_via=${r.sent_via} error=${r.error || '-'}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
