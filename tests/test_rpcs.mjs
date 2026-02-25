/**
 * RPC疎通テスト + コスト設定テストデータ投入
 * Usage: node tests/test_rpcs.mjs
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const results = [];

async function testRpc(name, params) {
  try {
    const { data, error } = await sb.rpc(name, params);
    if (error) {
      results.push({ name, status: 'FAIL', error: error.message, rows: 0 });
      console.log(`  FAIL  ${name}: ${error.message}`);
    } else {
      const rows = Array.isArray(data) ? data.length : (data !== null ? 1 : 0);
      results.push({ name, status: 'PASS', error: null, rows });
      console.log(`  PASS  ${name}: ${rows} rows`);
    }
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.message, rows: 0 });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

async function testTable(tableName, filter) {
  try {
    let q = sb.from(tableName).select('*').limit(3);
    if (filter) {
      Object.entries(filter).forEach(([k, v]) => { q = q.eq(k, v); });
    }
    const { data, error } = await q;
    if (error) {
      results.push({ name: `table:${tableName}`, status: 'FAIL', error: error.message, rows: 0 });
      console.log(`  FAIL  table:${tableName}: ${error.message}`);
    } else {
      const rows = data ? data.length : 0;
      results.push({ name: `table:${tableName}`, status: 'PASS', error: null, rows });
      console.log(`  PASS  table:${tableName}: ${rows} rows`);
    }
  } catch (e) {
    results.push({ name: `table:${tableName}`, status: 'FAIL', error: e.message, rows: 0 });
    console.log(`  FAIL  table:${tableName}: ${e.message}`);
  }
}

async function main() {
  console.log('========================================');
  console.log('Step 1: RPC疎通テスト');
  console.log('========================================\n');

  // --- 065 SPY分析 ---
  console.log('[065] SPY分析RPC:');
  await testRpc('get_spy_cast_schedule_pattern', { p_account_id: ACCOUNT_ID });
  await testRpc('get_user_payment_pattern', { p_account_id: ACCOUNT_ID });
  await testRpc('get_cast_growth_curve', { p_account_id: ACCOUNT_ID, p_cast_name: null, p_days: 30 });
  await testRpc('get_goal_achievement_analysis', { p_account_id: ACCOUNT_ID });
  await testRpc('get_market_trend', { p_account_id: ACCOUNT_ID });

  // --- 066 P/L (before cost data) ---
  console.log('\n[066] P/L RPC (before cost data):');
  await testRpc('get_session_pl', { p_account_id: ACCOUNT_ID });
  await testRpc('get_monthly_pl', { p_account_id: ACCOUNT_ID });

  // --- 068 スコアリング ---
  console.log('\n[068] スコアリングRPC:');
  await testRpc('calc_churn_risk_score', { p_account_id: ACCOUNT_ID });
  await testRpc('calc_session_quality_score', { p_account_id: ACCOUNT_ID });
  await testRpc('calc_cast_health_score', { p_account_id: ACCOUNT_ID });

  // --- 064 DMトリガー ---
  console.log('\n[064] DMトリガー:');
  await testTable('dm_triggers', { account_id: ACCOUNT_ID });
  await testTable('dm_trigger_logs', { account_id: ACCOUNT_ID });

  // --- 067 アラート ---
  console.log('\n[067] アラート:');
  await testTable('alerts', { account_id: ACCOUNT_ID });

  // =============================================
  console.log('\n========================================');
  console.log('Step 2: コスト設定テストデータ投入');
  console.log('========================================\n');

  const costData = [
    { account_id: ACCOUNT_ID, cast_name: 'Risa_06', hourly_rate: 2000, monthly_fixed_cost: 0, platform_fee_rate: 40.00, token_to_jpy: 5.5, bonus_rate: 0, effective_from: '2025-01-01' },
    { account_id: ACCOUNT_ID, cast_name: 'hanshakun', hourly_rate: 1500, monthly_fixed_cost: 0, platform_fee_rate: 40.00, token_to_jpy: 5.5, bonus_rate: 0, effective_from: '2025-01-01' },
  ];

  const { data: costResult, error: costError } = await sb
    .from('cast_cost_settings')
    .upsert(costData, { onConflict: 'account_id,cast_name,effective_from', ignoreDuplicates: true })
    .select();

  if (costError) {
    console.log(`  FAIL  cast_cost_settings INSERT: ${costError.message}`);
    results.push({ name: 'cost_settings_insert', status: 'FAIL', error: costError.message, rows: 0 });
  } else {
    console.log(`  PASS  cast_cost_settings INSERT: ${costResult?.length ?? 0} rows`);
    results.push({ name: 'cost_settings_insert', status: 'PASS', error: null, rows: costResult?.length ?? 0 });
  }

  // Verify cost data exists
  const { data: costCheck } = await sb
    .from('cast_cost_settings')
    .select('cast_name, hourly_rate, token_to_jpy')
    .eq('account_id', ACCOUNT_ID);
  console.log(`  Verify: ${costCheck?.length ?? 0} cost settings found`);
  if (costCheck) costCheck.forEach(c => console.log(`    ${c.cast_name}: ¥${c.hourly_rate}/h, ${c.token_to_jpy}円/tk`));

  // --- Re-test P/L RPCs after cost data ---
  console.log('\n[066] P/L RPC (after cost data):');
  await testRpc('get_session_pl', { p_account_id: ACCOUNT_ID });
  await testRpc('get_monthly_pl', { p_account_id: ACCOUNT_ID });

  // =============================================
  console.log('\n========================================');
  console.log('Summary');
  console.log('========================================\n');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total: ${results.length} | PASS: ${passed} | FAIL: ${failed}\n`);

  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✅' : '❌';
    const detail = r.status === 'FAIL' ? ` — ${r.error}` : ` (${r.rows} rows)`;
    console.log(`${icon} ${r.name}${detail}`);
  });

  if (failed > 0) {
    console.log('\n⚠️  FAILURES DETECTED — see errors above');
    process.exit(1);
  } else {
    console.log('\n🎉 ALL TESTS PASSED');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
