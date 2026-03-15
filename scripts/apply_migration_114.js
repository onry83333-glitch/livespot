#!/usr/bin/env node
// ============================================================
// Migration 114 適用スクリプト
//
// 使い方:
//   cd C:\dev\livespot
//   node scripts/apply_migration_114.js <DB_PASSWORD>
//
// DB_PASSWORD: Supabase Dashboard > Project Settings > Database > Database password
// ============================================================

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_PASSWORD = process.argv[2];
if (!DB_PASSWORD) {
  console.error('Usage: node scripts/apply_migration_114.js <DB_PASSWORD>');
  console.error('  DB_PASSWORD: Supabase Dashboard > Project Settings > Database');
  process.exit(1);
}

const PROJECT_REF = 'ujgbhkllfeacbgpdbjto';
const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';
const SK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ';

const sqlFile = path.join(__dirname, '..', 'supabase', 'migrations', '114_fix_tip_count_greatest.sql');

async function main() {
  const pool = new Pool({
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 6543,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log('1. Connecting to Supabase PostgreSQL...');
    const client = await pool.connect();
    console.log('   ✅ Connected');

    console.log('2. Reading migration SQL...');
    const sql = fs.readFileSync(sqlFile, 'utf-8');
    console.log(`   Read ${sql.length} bytes`);

    console.log('3. Applying migration 114...');
    await client.query(sql);
    console.log('   ✅ Migration applied');

    console.log('4. Verifying get_session_list_v2...');
    const { rows } = await client.query(`
      SELECT broadcast_group_id, tip_count, chat_tokens, coin_tokens, total_revenue
      FROM get_session_list_v2($1::UUID, 'fantasy_JP', 5, 0)
    `, [ACCOUNT_ID]);

    console.log('   Results:');
    for (const r of rows) {
      console.log(`   ${r.broadcast_group_id?.slice(0,8)} | tip=${r.tip_count} | chat=${r.chat_tokens} | coin=${r.coin_tokens} | revenue=${r.total_revenue}`);
    }

    client.release();
    console.log('\n✅ Migration 114 applied and verified successfully');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
