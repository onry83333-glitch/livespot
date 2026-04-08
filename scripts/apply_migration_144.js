#!/usr/bin/env node
// ============================================================
// Migration 144: cast_calendar_notes
//
// 使い方:
//   cd C:\dev\livespot
//   node scripts/apply_migration_144.js <DB_PASSWORD>
// ============================================================

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_PASSWORD = process.argv[2] || process.env.SUPABASE_DB_PASSWORD;
if (!DB_PASSWORD) {
  console.error('Usage: node scripts/apply_migration_144.js <DB_PASSWORD>');
  process.exit(1);
}

const PROJECT_REF = 'ujgbhkllfeacbgpdbjto';
const sqlFile = path.join(__dirname, '..', 'supabase', 'migrations', '144_cast_calendar_notes.sql');

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

    console.log('3. Applying migration 144...');
    await client.query(sql);
    console.log('   ✅ Migration applied');

    console.log('4. Verifying cast_calendar_notes table...');
    const { rows } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'cast_calendar_notes'
      ORDER BY ordinal_position
    `);
    console.log('   Columns:');
    for (const r of rows) console.log(`   - ${r.column_name}: ${r.data_type}`);

    const { rows: buckets } = await client.query(`
      SELECT id, name, public FROM storage.buckets WHERE id = 'cast-calendar-notes'
    `);
    console.log('   Storage bucket:', buckets[0] || 'NOT FOUND');

    client.release();
    console.log('\n✅ Migration 144 applied and verified successfully');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
