import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  // Check test records
  const { data: records } = await sb
    .from('dm_send_log')
    .select('id, user_name, status, created_at, campaign, cast_name, target_user_id')
    .eq('campaign', 'pipe_e2e_test_20260302')
    .order('id', { ascending: true });

  console.log('Test records:');
  const now = new Date();
  for (const r of records!) {
    const age = Math.round((now.getTime() - new Date(r.created_at).getTime()) / 1000);
    console.log(`  ID=${r.id} user=${r.user_name} status=${r.status} created=${r.created_at} age=${age}s target=${r.target_user_id}`);
  }

  // Grace threshold check
  const graceThreshold = new Date(Date.now() - 30 * 1000).toISOString();
  console.log('\nGrace threshold:', graceThreshold);
  console.log('Current time:', now.toISOString());
}

main().catch(console.error);
