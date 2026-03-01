/**
 * ADM (Automatic DM) Trigger Engine E2E Test
 * P0-11 分割 3/3: フルフロー検証
 *
 * DB actual columns (verified 2026-03-01):
 *   dm_triggers: id, account_id, trigger_name, trigger_type, is_active,
 *     conditions (JSONB), dm_template_id, dm_content_template,
 *     cooldown_hours, daily_limit, target_segment (TEXT/JSON string),
 *     created_at, updated_at
 *
 *   dm_trigger_logs: id, trigger_id, account_id, user_id, username,
 *     cast_name, triggered_at, dm_sent_at, status, reason
 *
 * テスト項目:
 *   T1: テストトリガー登録 → TriggerEngine読込 → dm_send_log投入 → dm_trigger_logs記録
 *   T2: クールダウン検証（同一ユーザーに短時間で2回発火しない）
 *   T3: 日次上限検証
 *   T4: cast_name分離検証（conditions.cast_name で独立動作）
 *   T5: セグメントフィルタ検証
 *   Cleanup: テストデータ削除
 */

import 'dotenv/config';
import { getSupabase } from './config.js';
import { TriggerEngine } from './triggers/index.js';
import { isInCooldown, isDailyLimitReached, isSegmentAllowed } from './triggers/cooldown.js';
import { renderTemplate } from './triggers/template.js';
import type { TriggerContext } from './triggers/types.js';

const TEST_PREFIX = 'adm_e2e_test_';
const TEST_ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';
const TEST_CAST_A = 'test_cast_alpha';
const TEST_CAST_B = 'test_cast_beta';

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
    errors.push(label);
  }
}

// ============================================================
// Cleanup helper
// ============================================================
async function cleanup(): Promise<void> {
  const sb = getSupabase();

  // dm_trigger_logs (テストトリガーIDで削除)
  const { data: testTriggers } = await sb
    .from('dm_triggers')
    .select('id')
    .like('trigger_name', `${TEST_PREFIX}%`);

  const triggerIds = (testTriggers || []).map((t: { id: string }) => t.id);

  if (triggerIds.length > 0) {
    const { error: logErr } = await sb
      .from('dm_trigger_logs')
      .delete()
      .in('trigger_id', triggerIds);
    if (logErr) console.warn('  cleanup dm_trigger_logs:', logErr.message);
  }

  // dm_send_log (テストキャストで削除)
  const { error: dmErr } = await sb
    .from('dm_send_log')
    .delete()
    .in('cast_name', [TEST_CAST_A, TEST_CAST_B]);
  if (dmErr) console.warn('  cleanup dm_send_log:', dmErr.message);

  // dm_triggers (テスト名で削除)
  const { error: trigErr } = await sb
    .from('dm_triggers')
    .delete()
    .like('trigger_name', `${TEST_PREFIX}%`);
  if (trigErr) console.warn('  cleanup dm_triggers:', trigErr.message);

  console.log(`  cleaned up ${triggerIds.length} test triggers`);
}

// ============================================================
// T1: フルフロー — トリガー登録→Engine読込→DM投入→ログ記録
// ============================================================
async function testFullFlow(): Promise<void> {
  console.log('\n=== T1: フルフロー ===');
  const sb = getSupabase();

  // 1. テストトリガーを登録 (actual DB columns)
  const { data: trigger, error: insertErr } = await sb
    .from('dm_triggers')
    .insert({
      account_id: TEST_ACCOUNT_ID,
      trigger_name: `${TEST_PREFIX}first_visit_a`,
      trigger_type: 'first_visit',
      is_active: true,
      conditions: { source: 'viewer_list', priority: 1 },
      dm_template_id: null,
      dm_content_template: '{username}さん、テストDMです！cast={cast_name}',
      cooldown_hours: 1,
      daily_limit: 100,
      target_segment: '[]',
    })
    .select('id')
    .single();

  assert(!insertErr && !!trigger, `テストトリガー登録 (err=${insertErr?.message || 'none'})`);
  if (!trigger) return;

  const triggerId = trigger.id;

  // 2. TriggerEngine で refreshTriggers → テストトリガーが読み込まれるか確認
  const engine = new TriggerEngine();
  (engine as unknown as { lastRefresh: number }).lastRefresh = 0;
  await engine.refreshTriggers();

  const triggers = (engine as unknown as { triggers: { id: string }[] }).triggers;
  const loaded = triggers.some((t: { id: string }) => t.id === triggerId);
  assert(loaded, 'TriggerEngine.refreshTriggers でテストトリガー読み込み');

  // 3. テンプレートレンダリング確認
  const ctx: TriggerContext = {
    accountId: TEST_ACCOUNT_ID,
    castName: TEST_CAST_A,
    userName: `${TEST_PREFIX}user_01`,
    totalTokens: 500,
    segment: 'S5',
  };

  const rendered = renderTemplate('{username}さん、テストDMです！cast={cast_name}', ctx);
  assert(
    rendered === `${TEST_PREFIX}user_01さん、テストDMです！cast=${TEST_CAST_A}`,
    `テンプレートレンダリング: "${rendered}"`,
  );

  // 4. dm_send_log にINSERT（fireTriggerの動作をシミュレート）
  const { data: dmRow, error: dmInsertErr } = await sb
    .from('dm_send_log')
    .insert({
      account_id: TEST_ACCOUNT_ID,
      cast_name: TEST_CAST_A,
      user_name: ctx.userName,
      message: rendered,
      status: 'queued',
      campaign: `trigger_first_visit_${triggerId.substring(0, 8)}`,
      template_name: `${TEST_PREFIX}first_visit_a`,
    })
    .select('id')
    .single();

  assert(!dmInsertErr && !!dmRow, `dm_send_log INSERT (err=${dmInsertErr?.message || 'none'})`);

  // 5. dm_trigger_logs にINSERT（logTriggerActionの動作をシミュレート）
  //    actual columns: trigger_id, account_id, username, cast_name, status, reason
  const { error: logInsertErr } = await sb
    .from('dm_trigger_logs')
    .insert({
      trigger_id: triggerId,
      account_id: TEST_ACCOUNT_ID,
      cast_name: TEST_CAST_A,
      user_id: 0,
      username: ctx.userName,
      status: 'dm_queued',
      reason: 'first_visit: segment=S5, tokens=500',
    });

  assert(!logInsertErr, `dm_trigger_logs INSERT (err=${logInsertErr?.message || 'none'})`);

  // 6. 記録の確認
  const { data: logs } = await sb
    .from('dm_trigger_logs')
    .select('*')
    .eq('trigger_id', triggerId)
    .eq('username', ctx.userName);

  assert((logs?.length ?? 0) === 1, `dm_trigger_logs に1件記録あり (件数=${logs?.length})`);

  if (logs && logs[0]) {
    assert(logs[0].status === 'dm_queued', `status = dm_queued (実際=${logs[0].status})`);
    assert(logs[0].cast_name === TEST_CAST_A, `cast_name = ${TEST_CAST_A} (実際=${logs[0].cast_name})`);
  }
}

// ============================================================
// T2: クールダウン検証
// ============================================================
async function testCooldown(): Promise<void> {
  console.log('\n=== T2: クールダウン検証 ===');
  const sb = getSupabase();

  // テストトリガーのIDを取得
  const { data: triggers } = await sb
    .from('dm_triggers')
    .select('id')
    .eq('trigger_name', `${TEST_PREFIX}first_visit_a`)
    .single();

  if (!triggers) {
    assert(false, 'テストトリガーが見つからない');
    return;
  }

  const triggerId = triggers.id;
  const testUser = `${TEST_PREFIX}user_01`;

  // T1で既にdm_trigger_logsに記録済み（直前に発火）
  // cooldown_hours=1 なので、同一ユーザーはクールダウン中のはず
  const inCooldown = await isInCooldown(triggerId, testUser, 1);
  assert(inCooldown === true, `クールダウン中（1時間以内に発火済み） → isInCooldown=true`);

  // 別ユーザーはクールダウンされない
  const otherUser = `${TEST_PREFIX}user_02`;
  const otherCooldown = await isInCooldown(triggerId, otherUser, 1);
  assert(otherCooldown === false, `別ユーザーはクールダウンなし → isInCooldown=false`);
}

// ============================================================
// T3: 日次上限検証
// ============================================================
async function testDailyLimit(): Promise<void> {
  console.log('\n=== T3: 日次上限検証 ===');
  const sb = getSupabase();

  // 日次上限1件のテストトリガーを登録
  const { data: trigger, error: trigInsertErr } = await sb
    .from('dm_triggers')
    .insert({
      account_id: TEST_ACCOUNT_ID,
      trigger_name: `${TEST_PREFIX}daily_limit_test`,
      trigger_type: 'first_visit',
      is_active: true,
      conditions: { priority: 99 },
      dm_content_template: 'daily limit test',
      cooldown_hours: 0,
      daily_limit: 1,
      target_segment: '[]',
    })
    .select('id')
    .single();

  if (!trigger) {
    assert(false, `日次上限テストトリガー登録失敗 (err=${trigInsertErr?.message})`);
    return;
  }

  // まだ今日のログ0件 → 上限未到達
  const beforeInsert = await isDailyLimitReached(trigger.id, 1);
  assert(beforeInsert === false, `日次上限テスト前: 0件/1件 → isDailyLimitReached=false`);

  // 1件ログをINSERT (actual columns)
  await sb.from('dm_trigger_logs').insert({
    trigger_id: trigger.id,
    account_id: TEST_ACCOUNT_ID,
    cast_name: TEST_CAST_A,
    user_id: 0,
    username: `${TEST_PREFIX}daily_user`,
    status: 'dm_queued',
    reason: 'daily limit test',
  });

  // 今日のログ1件 → 上限到達
  const afterInsert = await isDailyLimitReached(trigger.id, 1);
  assert(afterInsert === true, `日次上限テスト後: 1件/1件 → isDailyLimitReached=true`);

  // daily_limit=2 なら未到達
  const withHigherLimit = await isDailyLimitReached(trigger.id, 2);
  assert(withHigherLimit === false, `日次上限2件: 1件/2件 → isDailyLimitReached=false`);
}

// ============================================================
// T4: cast_name分離検証
// ============================================================
async function testCastNameSeparation(): Promise<void> {
  console.log('\n=== T4: cast_name分離検証 ===');
  const sb = getSupabase();

  // cast_a専用トリガー (cast_name in conditions)
  const { data: triggerA } = await sb
    .from('dm_triggers')
    .insert({
      account_id: TEST_ACCOUNT_ID,
      trigger_name: `${TEST_PREFIX}cast_a_only`,
      trigger_type: 'first_visit',
      is_active: true,
      conditions: { cast_name: TEST_CAST_A, priority: 5 },
      dm_content_template: 'cast_a only DM',
      cooldown_hours: 1,
      daily_limit: 100,
      target_segment: '[]',
    })
    .select('id')
    .single();

  // cast_b専用トリガー
  const { data: triggerB } = await sb
    .from('dm_triggers')
    .insert({
      account_id: TEST_ACCOUNT_ID,
      trigger_name: `${TEST_PREFIX}cast_b_only`,
      trigger_type: 'first_visit',
      is_active: true,
      conditions: { cast_name: TEST_CAST_B, priority: 5 },
      dm_content_template: 'cast_b only DM',
      cooldown_hours: 1,
      daily_limit: 100,
      target_segment: '[]',
    })
    .select('id')
    .single();

  if (!triggerA || !triggerB) {
    assert(false, 'cast分離テストトリガー登録失敗');
    return;
  }

  // TriggerEngineでフィルタ確認
  const engine = new TriggerEngine();
  (engine as unknown as { lastRefresh: number }).lastRefresh = 0;
  await engine.refreshTriggers();

  const allTriggers = (engine as unknown as { triggers: { id: string; cast_name: string | null; trigger_type: string }[] }).triggers;

  // cast_a用トリガーがcast_aで取得でき、cast_bでは取得できない
  const forCastA = allTriggers.filter(
    t => t.trigger_type === 'first_visit' && (!t.cast_name || t.cast_name === TEST_CAST_A),
  );
  const forCastB = allTriggers.filter(
    t => t.trigger_type === 'first_visit' && (!t.cast_name || t.cast_name === TEST_CAST_B),
  );

  const castAHasTriggerA = forCastA.some(t => t.id === triggerA.id);
  const castAHasTriggerB = forCastA.some(t => t.id === triggerB.id);
  const castBHasTriggerA = forCastB.some(t => t.id === triggerA.id);
  const castBHasTriggerB = forCastB.some(t => t.id === triggerB.id);

  assert(castAHasTriggerA, `cast_aフィルタ: triggerA (cast_a専用) が含まれる`);
  assert(!castAHasTriggerB, `cast_aフィルタ: triggerB (cast_b専用) が含まれない`);
  assert(!castBHasTriggerA, `cast_bフィルタ: triggerA (cast_a専用) が含まれない`);
  assert(castBHasTriggerB, `cast_bフィルタ: triggerB (cast_b専用) が含まれる`);

  // dm_trigger_logs のcast_name分離確認
  await sb.from('dm_trigger_logs').insert({
    trigger_id: triggerA.id,
    account_id: TEST_ACCOUNT_ID,
    cast_name: TEST_CAST_A,
    user_id: 0,
    username: `${TEST_PREFIX}cast_sep_user`,
    status: 'dm_queued',
    reason: 'cast_separation test',
  });

  // cast_bでの検索 → 0件
  const { data: logsB } = await sb
    .from('dm_trigger_logs')
    .select('id')
    .eq('trigger_id', triggerA.id)
    .eq('cast_name', TEST_CAST_B);

  assert((logsB?.length ?? 0) === 0, `cast_bではtriggerAのログが見つからない (件数=${logsB?.length})`);

  // cast_aでの検索 → 1件
  const { data: logsA } = await sb
    .from('dm_trigger_logs')
    .select('id')
    .eq('trigger_id', triggerA.id)
    .eq('cast_name', TEST_CAST_A);

  assert((logsA?.length ?? 0) === 1, `cast_aではtriggerAのログが1件 (件数=${logsA?.length})`);
}

// ============================================================
// T5: セグメントフィルタ検証
// ============================================================
async function testSegmentFilter(): Promise<void> {
  console.log('\n=== T5: セグメントフィルタ検証 ===');

  // 空配列 → 全セグメント許可
  assert(isSegmentAllowed([], 'S1') === true, '空target_segments → 全許可');
  assert(isSegmentAllowed([], undefined) === true, '空target_segments + undefined → 全許可');

  // 特定セグメント指定
  assert(isSegmentAllowed(['S1', 'S2', 'S4'], 'S1') === true, 'S1 in [S1,S2,S4] → 許可');
  assert(isSegmentAllowed(['S1', 'S2', 'S4'], 'S3') === false, 'S3 not in [S1,S2,S4] → 拒否');
  assert(isSegmentAllowed(['S1', 'S2', 'S4'], 'S4') === true, 'S4 in [S1,S2,S4] → 許可');

  // セグメント未設定のユーザー → 許可（info不足は通す）
  assert(isSegmentAllowed(['S1', 'S2'], undefined) === true, 'target指定あり + userSegment未設定 → 許可');
}

// ============================================================
// Main
// ============================================================
async function main(): Promise<void> {
  console.log('=== ADM Trigger Engine E2E Test ===');
  console.log(`Account: ${TEST_ACCOUNT_ID}`);
  console.log(`Cast A: ${TEST_CAST_A}`);
  console.log(`Cast B: ${TEST_CAST_B}`);
  console.log(`Prefix: ${TEST_PREFIX}`);

  const sb = getSupabase();

  // DB接続確認
  const { data: connCheck, error: connErr } = await sb
    .from('dm_triggers')
    .select('id')
    .limit(1);

  if (connErr) {
    console.error('❌ DB接続失敗:', connErr.message);
    process.exit(1);
  }
  console.log('✅ DB接続OK');

  // 事前クリーンアップ
  console.log('\n--- 事前クリーンアップ ---');
  await cleanup();

  try {
    await testFullFlow();
    await testCooldown();
    await testDailyLimit();
    await testCastNameSeparation();
    await testSegmentFilter();
  } finally {
    // 最終クリーンアップ
    console.log('\n--- テストデータクリーンアップ ---');
    await cleanup();
  }

  // 結果サマリー
  console.log('\n========================================');
  console.log(`  テスト結果: ${passed} passed, ${failed} failed`);
  if (errors.length > 0) {
    console.log('  失敗項目:');
    errors.forEach(e => console.log(`    - ${e}`));
  }
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ テスト実行エラー:', err);
  process.exit(1);
});
