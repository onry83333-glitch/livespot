/**
 * DM E2E Test — テストレコード挿入
 * paid_usersからuserIdを取得済みの2名 + 未解決1名 = 3件挿入
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';
const CAST_NAME = 'Risa_06';

async function main() {
  // Verify session is ready
  const { data: sessions } = await sb
    .from('stripchat_sessions')
    .select('stripchat_user_id, csrf_token')
    .eq('is_valid', true);

  if (!sessions || sessions.length === 0) {
    console.error('No valid sessions');
    process.exit(1);
  }

  console.log('Session: userId=' + sessions[0].stripchat_user_id + ', csrf=' + (sessions[0].csrf_token ? 'OK' : 'MISSING'));

  // SAKURA users with known IDs from paid_users
  const testUsers = [
    { name: 'pojipojipoji', targetUserId: 170655196 },
    { name: 'kantou1234', targetUserId: 228076661 },
    { name: 'Nekomeem34', targetUserId: null }, // will test userId resolution path
  ];

  const now = new Date().toISOString().slice(0, 19);
  const testRecords = testUsers.map(u => ({
    account_id: ACCOUNT_ID,
    user_name: u.name,
    message: `[E2Eテスト] dm-service送信テスト ${now}`,
    cast_name: CAST_NAME,
    status: 'queued',
    campaign: 'pipe_e2e_test_20260302',
    target_user_id: u.targetUserId,
    send_order: 'text_only',
    image_url: null,
    image_sent: false,
    profile_url: null,
    template_name: 'e2e_test',
    created_at: new Date(Date.now() - 120000).toISOString(), // 2分前（グレースピリオド回避）
  }));

  console.log('\nInserting ' + testRecords.length + ' test records...');

  const { data: inserted, error: insertErr } = await sb
    .from('dm_send_log')
    .insert(testRecords)
    .select('id, user_name, status, target_user_id, cast_name');

  if (insertErr) {
    console.error('Insert error:', insertErr.message);
    process.exit(1);
  }

  console.log('\nInserted test records:');
  for (const r of inserted!) {
    console.log(`  ID=${r.id}  user=${r.user_name}  target=${r.target_user_id || 'UNRESOLVED'}  cast=${r.cast_name}`);
  }

  console.log('\n=== Ready for dm-service ===');
  console.log('Record IDs: ' + inserted!.map(r => r.id).join(', '));
  console.log('Campaign: pipe_e2e_test_20260302');
  console.log('\nNext: npx tsx src/dm-service/index.ts');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
