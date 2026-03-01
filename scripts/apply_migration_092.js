#!/usr/bin/env node
// ============================================================
// Migration 092 適用スクリプト
// get_dm_campaign_cvr に来場CVR（spy_messages突合）を追加
//
// 使い方:
//   node scripts/apply_migration_092.js <DB_PASSWORD>
//
// DB_PASSWORD は Supabase Dashboard > Settings > Database で確認
// ============================================================

const { Pool } = require('pg');
const fs = require('fs');

const DB_PASSWORD = process.argv[2];
if (!DB_PASSWORD) {
  console.error('Usage: node scripts/apply_migration_092.js <DB_PASSWORD>');
  console.error('  DB_PASSWORD: Supabase Dashboard > Settings > Database > Connection string');
  process.exit(1);
}

const PROJECT_REF = 'ujgbhkllfeacbgpdbjto';
const sql = fs.readFileSync('supabase/migrations/092_dm_cvr_visit_tracking.sql', 'utf8');

async function main() {
  const pool = new Pool({
    host: `aws-0-ap-northeast-1.pooler.supabase.com`,
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  try {
    console.log('Connecting to Supabase PostgreSQL...');
    const testRes = await pool.query('SELECT current_database(), current_user');
    console.log('Connected:', testRes.rows[0]);

    console.log('\nApplying migration 092...');
    await pool.query(sql);
    console.log('Migration 092 applied successfully!');

    // Verify
    const verify = await pool.query(`
      SELECT proname, pronargs
      FROM pg_proc
      WHERE proname = 'get_dm_campaign_cvr'
    `);
    console.log('\nVerification:', verify.rows);

    // Test the new function
    const test = await pool.query(`
      SELECT * FROM get_dm_campaign_cvr(NULL, NULL, '2026-02-01'::DATE) LIMIT 1
    `);
    if (test.rows.length > 0) {
      const cols = Object.keys(test.rows[0]);
      console.log('Return columns:', cols);
      const hasVisit = cols.includes('visited_after') && cols.includes('visit_cvr_pct');
      console.log('visit_cvr_pct column:', hasVisit ? 'OK' : 'MISSING');
    }

    // Notify PostgREST to refresh schema cache
    await pool.query("NOTIFY pgrst, 'reload schema'");
    console.log('\nPostgREST schema cache refreshed.');

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
