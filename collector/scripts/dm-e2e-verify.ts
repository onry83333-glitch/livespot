import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  // Full details of test records
  const { data: records } = await sb
    .from('dm_send_log')
    .select('id, user_name, status, error, sent_at, sent_via, created_at, target_user_id, cast_name, campaign, message')
    .eq('campaign', 'pipe_e2e_test_20260302')
    .order('id', { ascending: true });

  console.log('=== E2E Test Results ===\n');
  let successCount = 0;
  let errorCount = 0;

  for (const r of records!) {
    const sentDelay = r.sent_at ? Math.round((new Date(r.sent_at).getTime() - new Date(r.created_at).getTime()) / 1000) : null;
    console.log(`ID: ${r.id}`);
    console.log(`  User: ${r.user_name}`);
    console.log(`  Cast: ${r.cast_name}`);
    console.log(`  Status: ${r.status}`);
    console.log(`  Sent via: ${r.sent_via}`);
    console.log(`  Target userId: ${r.target_user_id || 'UNRESOLVED'}`);
    console.log(`  Created: ${r.created_at}`);
    console.log(`  Sent at: ${r.sent_at}`);
    console.log(`  Send delay: ${sentDelay !== null ? sentDelay + 's' : 'N/A'}`);
    console.log(`  Error: ${r.error || 'none'}`);
    console.log(`  Message: ${r.message.slice(0, 60)}`);
    console.log('');

    if (r.status === 'success') successCount++;
    else errorCount++;
  }

  console.log('=== Summary ===');
  console.log(`Total: ${records!.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Error: ${errorCount}`);
  console.log(`Send method: ${records![0]?.sent_via || 'unknown'}`);

  // Check rate limiting: time between sends
  const sentTimes = records!
    .filter(r => r.sent_at)
    .map(r => new Date(r.sent_at).getTime())
    .sort();

  if (sentTimes.length >= 2) {
    console.log('\n=== Rate Limiting ===');
    for (let i = 1; i < sentTimes.length; i++) {
      const gap = (sentTimes[i] - sentTimes[i - 1]) / 1000;
      console.log(`  Gap ${i}: ${gap.toFixed(1)}s ${gap >= 3 ? '✅' : '⚠️ < 3s'}`);
    }
  }
}

main().catch(console.error);
