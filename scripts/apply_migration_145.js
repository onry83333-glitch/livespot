#!/usr/bin/env node
// ============================================================
// Migration 145: cast_sticky_notes rich text support
//
// 使い方:
//   cd C:\dev\livespot
//   node scripts/apply_migration_145.js <DB_PASSWORD>
// ============================================================

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_PASSWORD = process.argv[2] || process.env.SUPABASE_DB_PASSWORD;
if (!DB_PASSWORD) {
  console.error('Usage: node scripts/apply_migration_145.js <DB_PASSWORD>');
  process.exit(1);
}

const PROJECT_REF = 'ujgbhkllfeacbgpdbjto';
const sqlFile = path.join(__dirname, '..', 'supabase', 'migrations', '145_cast_sticky_notes_rich.sql');

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

    console.log('3. Applying migration 145...');
    await client.query(sql);
    console.log('   ✅ Migration applied');

    console.log('4. Verifying cast_sticky_notes columns...');
    const { rows } = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'cast_sticky_notes'
      ORDER BY ordinal_position
    `);
    for (const r of rows) console.log(`   - ${r.column_name}: ${r.data_type}`);

    console.log('5. Verifying content_rich migration for existing rows...');
    const { rows: stats } = await client.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE content_rich IS NOT NULL) AS with_rich,
        COUNT(*) FILTER (WHERE category IS NOT NULL) AS with_category
      FROM cast_sticky_notes
    `);
    console.log('   Stats:', stats[0]);

    client.release();
    console.log('\n✅ Migration 145 applied and verified successfully');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
