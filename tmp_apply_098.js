const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const client = new Client({
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 6543,
    database: 'postgres',
    user: 'postgres.ujgbhkllfeacbgpdbjto',
    password: 'uq+icfqd7m?JSv2',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // Pre-check: sessions with NULL cast_name
  const nullCheck = await client.query(
    "SELECT count(*) as cnt FROM public.sessions WHERE cast_name IS NULL"
  );
  console.log('sessions with NULL cast_name:', nullCheck.rows[0].cnt);

  // Pre-check: sessions duplicates on (cast_name, account_id, started_at)
  const dupeCheck = await client.query(`
    SELECT cast_name, account_id, started_at, count(*) as cnt
    FROM public.sessions
    WHERE cast_name IS NOT NULL
    GROUP BY cast_name, account_id, started_at
    HAVING count(*) > 1
    LIMIT 10
  `);
  console.log('duplicate (cast_name, account_id, started_at):', dupeCheck.rows.length, 'groups');
  if (dupeCheck.rows.length > 0) {
    dupeCheck.rows.forEach(r => console.log(' ', r.cast_name, r.started_at, 'x' + r.cnt));
  }

  // Pre-check: tables that already exist
  const existCheck = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('chat_logs', 'viewer_snapshots', 'user_profiles')
  `);
  console.log('existing v2 tables:', existCheck.rows.map(r => r.tablename));

  if (dupeCheck.rows.length > 0) {
    console.log('\n⚠️ 重複あり — UNIQUE制約の追加前に重複を解消する必要があります');
    console.log('Migration適用を中止します。');
    await client.end();
    return;
  }

  // Pre-check: sessions.session_id の型確認（TEXT であること）
  const typeCheck = await client.query(`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'session_id'
  `);
  const sidType = typeCheck.rows[0]?.data_type;
  console.log('sessions.session_id type:', sidType);
  if (sidType !== 'text') {
    console.log('\n⚠️ sessions.session_id が TEXT ではありません（' + sidType + '）');
    console.log('chat_logs/viewer_snapshots の FK が失敗するため中止します。');
    await client.end();
    return;
  }

  // Apply migration
  console.log('\n--- Migration 098 適用開始 ---');
  const sql = fs.readFileSync(
    path.join(__dirname, 'supabase', 'migrations', '098_v2_schema.sql'),
    'utf-8'
  );
  try {
    await client.query(sql);
    console.log('✅ Migration 098 適用成功');
  } catch (err) {
    console.error('❌ Migration 098 適用失敗:', err.message);
    if (err.detail) console.error('  detail:', err.detail);
    await client.end();
    process.exit(1);
  }

  // Post-check
  const tables = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('chat_logs', 'viewer_snapshots', 'user_profiles')
    ORDER BY tablename
  `);
  console.log('\n--- 確認 ---');
  console.log('作成されたテーブル:', tables.rows.map(r => r.tablename));

  const sessNotNull = await client.query(`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'cast_name'
  `);
  console.log('sessions.cast_name nullable:', sessNotNull.rows[0].is_nullable);

  const uqCheck = await client.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass AND conname = 'uq_sessions_cast_account_started'
  `);
  console.log('sessions UNIQUE(cast,account,started):', uqCheck.rows.length > 0 ? '✅ exists' : '❌ missing');

  // FK check — chat_logs/viewer_snapshots の session_id FK が正しく作成されたか
  const fkCheck = await client.query(`
    SELECT tc.table_name, tc.constraint_name, ccu.column_name AS ref_column, ccu.table_name AS ref_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name IN ('chat_logs', 'viewer_snapshots')
      AND ccu.table_name = 'sessions'
  `);
  console.log('FK to sessions:');
  fkCheck.rows.forEach(r => console.log(' ', r.table_name, '→', r.ref_table + '.' + r.ref_column));

  // RLS check
  const rlsCheck = await client.query(`
    SELECT tablename, rowsecurity FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('chat_logs', 'viewer_snapshots', 'user_profiles')
  `);
  console.log('RLS status:');
  rlsCheck.rows.forEach(r => console.log(' ', r.tablename, r.rowsecurity ? '✅ enabled' : '❌ disabled'));

  await client.end();
  console.log('\n完了');
}

main().catch(e => { console.error(e); process.exit(1); });
