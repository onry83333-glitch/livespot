const { Client } = require('pg');
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

  // Check sessions constraints
  const res = await client.query(`
    SELECT conname, contype, pg_get_constraintdef(oid) as def
    FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass
    ORDER BY conname;
  `);
  console.log('=== sessions constraints ===');
  res.rows.forEach(r => console.log(r.conname, '|', r.contype, '|', r.def));

  // Check sessions indexes
  const idx = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'sessions' AND schemaname = 'public'
    ORDER BY indexname;
  `);
  console.log('\n=== sessions indexes ===');
  idx.rows.forEach(r => console.log(r.indexname, '|', r.indexdef));

  // Check if cast_name is nullable
  const col = await client.query(`
    SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_name = 'sessions' AND table_schema = 'public'
    ORDER BY ordinal_position;
  `);
  console.log('\n=== sessions columns ===');
  col.rows.forEach(r => console.log(r.column_name, '|', r.is_nullable, '|', r.data_type));

  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
