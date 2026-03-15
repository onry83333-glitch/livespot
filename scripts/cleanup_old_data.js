#!/usr/bin/env node
// ============================================================
// Supabase old data cleanup script
// Delete all records with created_at < 2026-03-05T00:00:00+09:00
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CUTOFF = '2026-03-05T00:00:00+09:00';

// Tables to clean up (order matters for foreign key constraints)
// Delete child/dependent tables first, then parent tables
const TABLES = [
  'spy_messages',
  'chat_logs',
  'viewer_logs',
  'dm_send_log',
  'coin_transactions',
  'cast_knowledge',
  'ai_deep_analysis',
  'sessions',  // parent table last (sessions may be referenced by others)
];

async function getCount(table, filter) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filter) {
    query = query.lt('created_at', CUTOFF);
  }
  const { count, error } = await query;
  if (error) return { count: null, error: error.message };
  return { count, error: null };
}

async function step1() {
  console.log('=== Step 1: Record count check ===');
  console.log(`Cutoff: ${CUTOFF}\n`);
  console.log('Table                  | Total     | To Delete | Remaining');
  console.log('-'.repeat(70));

  const results = [];
  for (const table of TABLES) {
    const total = await getCount(table, false);
    const toDelete = await getCount(table, true);

    const totalStr = total.error ? `ERR: ${total.error}` : String(total.count).padStart(9);
    const delStr = toDelete.error ? `ERR: ${toDelete.error}` : String(toDelete.count).padStart(9);
    const remStr = (total.error || toDelete.error) ? '   N/A' : String(total.count - toDelete.count).padStart(9);

    console.log(`${table.padEnd(22)} | ${totalStr} | ${delStr} | ${remStr}`);
    results.push({
      table,
      total: total.count,
      toDelete: toDelete.count,
      remaining: (total.count != null && toDelete.count != null) ? total.count - toDelete.count : null,
      error: total.error || toDelete.error
    });
  }
  console.log();
  return results;
}

async function deleteFromTable(table) {
  // Supabase JS client requires a filter for delete
  // Delete in batches to avoid timeout
  const BATCH_SIZE = 10000;
  let totalDeleted = 0;

  while (true) {
    const { data, error, count } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .lt('created_at', CUTOFF)
      .limit(BATCH_SIZE);

    if (error) {
      return { deleted: totalDeleted, error: error.message };
    }

    const batchDeleted = count || 0;
    totalDeleted += batchDeleted;

    if (batchDeleted === 0) break;

    process.stdout.write(`  ${table}: deleted ${totalDeleted} so far...\r`);

    if (batchDeleted < BATCH_SIZE) break;
  }

  return { deleted: totalDeleted, error: null };
}

async function step2() {
  console.log('=== Step 2: Deleting old data ===\n');

  const results = [];
  for (const table of TABLES) {
    process.stdout.write(`  Deleting from ${table}...`);
    const result = await deleteFromTable(table);
    if (result.error) {
      console.log(` ERROR: ${result.error}`);
    } else {
      console.log(` deleted ${result.deleted} rows`);
    }
    results.push({ table, ...result });
  }
  console.log();
  return results;
}

async function step4() {
  console.log('=== Step 4: Post-deletion record counts ===\n');
  console.log('Table                  | Remaining');
  console.log('-'.repeat(40));

  const results = [];
  for (const table of TABLES) {
    const total = await getCount(table, false);
    const str = total.error ? `ERR: ${total.error}` : String(total.count).padStart(9);
    console.log(`${table.padEnd(22)} | ${str}`);
    results.push({ table, remaining: total.count, error: total.error });
  }
  console.log();
  return results;
}

async function main() {
  console.log('Supabase Old Data Cleanup');
  console.log('========================\n');

  // Step 1
  const step1Results = await step1();

  // Confirm
  const totalToDelete = step1Results.reduce((sum, r) => sum + (r.toDelete || 0), 0);
  console.log(`Total records to delete: ${totalToDelete}\n`);

  if (totalToDelete === 0) {
    console.log('Nothing to delete. Exiting.');
    return;
  }

  // Step 2
  const step2Results = await step2();

  // Step 4
  const step4Results = await step4();

  // Summary for Notion
  console.log('=== Summary for Notion ===');
  console.log('```');
  console.log('Table                  | Before    | Deleted   | After');
  console.log('-'.repeat(65));
  for (const table of TABLES) {
    const s1 = step1Results.find(r => r.table === table);
    const s2 = step2Results.find(r => r.table === table);
    const s4 = step4Results.find(r => r.table === table);
    console.log(
      `${table.padEnd(22)} | ${String(s1?.total ?? 'N/A').padStart(9)} | ${String(s2?.deleted ?? 'N/A').padStart(9)} | ${String(s4?.remaining ?? 'N/A').padStart(9)}`
    );
  }
  console.log('```');
}

main().catch(console.error);
