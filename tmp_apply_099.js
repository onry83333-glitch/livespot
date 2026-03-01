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
  console.log('Connected to Supabase');

  // Capture NOTICE messages
  client.on('notice', (msg) => {
    console.log('[NOTICE]', msg.message);
  });

  // Pre-check: current counts
  const preChecks = await Promise.all([
    client.query('SELECT COUNT(*) as cnt FROM public.spy_messages'),
    client.query('SELECT COUNT(*) as cnt FROM public.spy_viewers'),
    client.query('SELECT COUNT(*) as cnt FROM public.paid_users'),
    client.query('SELECT COUNT(*) as cnt FROM public.chat_logs'),
    client.query('SELECT COUNT(*) as cnt FROM public.viewer_snapshots'),
    client.query('SELECT COUNT(*) as cnt FROM public.user_profiles'),
  ]);

  console.log('\n=== Pre-migration counts ===');
  console.log('spy_messages:      ', preChecks[0].rows[0].cnt);
  console.log('spy_viewers:       ', preChecks[1].rows[0].cnt);
  console.log('paid_users:        ', preChecks[2].rows[0].cnt);
  console.log('chat_logs:         ', preChecks[3].rows[0].cnt);
  console.log('viewer_snapshots:  ', preChecks[4].rows[0].cnt);
  console.log('user_profiles:     ', preChecks[5].rows[0].cnt);

  // Read and execute migration
  const sql = fs.readFileSync(
    path.join(__dirname, 'supabase/migrations/099_data_migration.sql'),
    'utf-8'
  );

  console.log('\n=== Executing migration 099 ===');
  const startTime = Date.now();

  try {
    await client.query(sql);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nMigration completed in ${elapsed}s`);
  } catch (err) {
    console.error('\nMigration FAILED:', err.message);
    if (err.detail) console.error('Detail:', err.detail);
    if (err.hint) console.error('Hint:', err.hint);
    if (err.position) console.error('Position:', err.position);
    await client.end();
    process.exit(1);
  }

  // Post-check
  const postChecks = await Promise.all([
    client.query('SELECT COUNT(*) as cnt FROM public.chat_logs'),
    client.query('SELECT COUNT(*) as cnt FROM public.viewer_snapshots'),
    client.query('SELECT COUNT(*) as cnt FROM public.user_profiles'),
  ]);

  console.log('\n=== Post-migration counts ===');
  console.log('chat_logs:         ', postChecks[0].rows[0].cnt);
  console.log('viewer_snapshots:  ', postChecks[1].rows[0].cnt);
  console.log('user_profiles:     ', postChecks[2].rows[0].cnt);

  // Detailed checks
  const msgTypeCheck = await client.query(
    "SELECT message_type, COUNT(*) as cnt FROM public.chat_logs GROUP BY message_type ORDER BY cnt DESC"
  );
  console.log('\n=== chat_logs message_type distribution ===');
  msgTypeCheck.rows.forEach(r => console.log(`  ${r.message_type}: ${r.cnt}`));

  const segmentCheck = await client.query(
    "SELECT segment, COUNT(*) as cnt FROM public.user_profiles GROUP BY segment ORDER BY cnt DESC"
  );
  console.log('\n=== user_profiles segment distribution ===');
  segmentCheck.rows.forEach(r => console.log(`  ${r.segment || 'NULL'}: ${r.cnt}`));

  const tokenCheck = await client.query(`
    SELECT
      (SELECT COALESCE(SUM(GREATEST(tokens, 0)), 0) FROM public.spy_messages
       WHERE account_id IS NOT NULL AND cast_name IS NOT NULL AND cast_name != ''
         AND user_name IS NOT NULL AND TRIM(user_name) != ''
         AND LOWER(TRIM(user_name)) NOT IN ('unknown', 'undefined', 'null')) as spy_tokens,
      (SELECT COALESCE(SUM(tokens), 0) FROM public.chat_logs) as chat_tokens
  `);
  console.log('\n=== Token integrity ===');
  console.log('spy_messages tokens:', tokenCheck.rows[0].spy_tokens);
  console.log('chat_logs tokens:   ', tokenCheck.rows[0].chat_tokens);
  console.log('Difference:         ', BigInt(tokenCheck.rows[0].spy_tokens) - BigInt(tokenCheck.rows[0].chat_tokens));

  await client.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
