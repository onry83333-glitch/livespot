#!/usr/bin/env node
// ============================================================
// Migration 087-095 一括適用スクリプト
//
// 使い方:
//   cd C:\dev\livespot
//   node scripts/apply_migration_087_to_095.js <DB_PASSWORD>
//
// DB_PASSWORD: Supabase Dashboard > Project Settings > Database > Database password
// ============================================================

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_PASSWORD = process.argv[2];
if (!DB_PASSWORD) {
  console.error('Usage: node scripts/apply_migration_087_to_095.js <DB_PASSWORD>');
  console.error('  DB_PASSWORD: Supabase Dashboard > Project Settings > Database');
  process.exit(1);
}

const PROJECT_REF = 'ujgbhkllfeacbgpdbjto';
const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ';
const ACCOUNT_ID = '16b70f53-db5d-4460-9453-3bcc5f4bc4f4';

const files = [
  { name: 'apply_087_to_095.sql', path: path.join(__dirname, '..', 'supabase', 'migrations', 'apply_087_to_095.sql') },
  { name: '095_fix_broken_rpcs.sql', path: path.join(__dirname, '..', 'supabase', 'migrations', '095_fix_broken_rpcs.sql') },
];

async function main() {
  const pool = new Pool({
    host: 'aws-0-ap-northeast-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    statement_timeout: 120000,
  });

  try {
    // 1. 接続テスト
    console.log('Connecting to Supabase PostgreSQL...');
    const testRes = await pool.query('SELECT current_database(), current_user, NOW()');
    console.log('Connected:', testRes.rows[0]);

    // 2. Migration適用
    for (const file of files) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Applying: ${file.name}`);
      console.log('='.repeat(60));

      const sql = fs.readFileSync(file.path, 'utf8');
      await pool.query(sql);
      console.log(`✅ ${file.name} applied successfully`);
    }

    // 3. PostgREST schema cache reload
    await pool.query("NOTIFY pgrst, 'reload schema'");
    console.log('\n✅ PostgREST schema cache refreshed');

    // 4. 検証
    console.log(`\n${'='.repeat(60)}`);
    console.log('検証: RPC存在確認');
    console.log('='.repeat(60));

    const rpcsToCheck = [
      'close_orphan_sessions',
      'get_weekly_coin_stats',
      'check_spy_data_integrity',
      'get_dm_effectiveness_by_segment',
      'get_new_users_by_session',
      'get_session_list_v2',
      'get_session_summary_v2',
      'get_transcript_timeline',
      'calc_churn_risk_score',
      'user_summary',
      'get_session_actions',
    ];

    const funcCheck = await pool.query(`
      SELECT proname, pronargs, proargtypes::TEXT
      FROM pg_proc
      WHERE proname = ANY($1)
        AND pronamespace = 'public'::regnamespace
      ORDER BY proname
    `, [rpcsToCheck]);

    for (const row of funcCheck.rows) {
      console.log(`  ✅ ${row.proname} (${row.pronargs} args)`);
    }

    const found = new Set(funcCheck.rows.map(r => r.proname));
    for (const name of rpcsToCheck) {
      if (!found.has(name)) {
        console.log(`  ❌ ${name} — NOT FOUND`);
      }
    }

    // 5. RPC動作テスト
    console.log(`\n${'='.repeat(60)}`);
    console.log('検証: RPC動作テスト');
    console.log('='.repeat(60));

    // get_session_list_v2
    try {
      const r = await pool.query(
        `SELECT * FROM get_session_list_v2($1, 'hanshakun', 3)`,
        [ACCOUNT_ID]
      );
      console.log(`  ✅ get_session_list_v2: ${r.rows.length} rows`);
    } catch (e) {
      console.log(`  ❌ get_session_list_v2: ${e.message.substring(0, 80)}`);
    }

    // get_new_users_by_session
    try {
      const r = await pool.query(
        `SELECT * FROM get_new_users_by_session($1, 'hanshakun', '2026-02-25')`,
        [ACCOUNT_ID]
      );
      console.log(`  ✅ get_new_users_by_session: ${r.rows.length} rows`);
    } catch (e) {
      console.log(`  ❌ get_new_users_by_session: ${e.message.substring(0, 80)}`);
    }

    // close_orphan_sessions (dry run check)
    try {
      const r = await pool.query(`SELECT close_orphan_sessions()`);
      console.log(`  ✅ close_orphan_sessions: closed ${r.rows[0].close_orphan_sessions} orphans`);
    } catch (e) {
      console.log(`  ❌ close_orphan_sessions: ${e.message.substring(0, 80)}`);
    }

    // check_spy_data_integrity
    try {
      const r = await pool.query(`SELECT check_spy_data_integrity()`);
      console.log(`  ✅ check_spy_data_integrity: returned ${JSON.stringify(r.rows[0]).substring(0, 80)}...`);
    } catch (e) {
      console.log(`  ❌ check_spy_data_integrity: ${e.message.substring(0, 80)}`);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('Migration 087-095 適用完了！');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
