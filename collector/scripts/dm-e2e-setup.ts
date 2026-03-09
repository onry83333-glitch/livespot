/**
 * DM E2E Test Setup — Phase 2
 * SAKURAアカウント3名のuserIdを解決し、dm_send_logにテストレコードを挿入
 *
 * 前提: extract-csrf.ts で stripchat_sessions.stripchat_user_id と csrf_token は設定済み
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SAKURA_USERS = ['pojipojipoji', 'kantou1234', 'Nekomeem34'];
const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';
const CAST_NAME = 'Risa_06'; // session userId=178845750 に一致するキャスト

async function resolveUserId(name: string, cookieStr: string): Promise<string | null> {
  // Method 1: /cam endpoint (no auth needed)
  try {
    const res = await fetch(
      `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(name)}/cam`,
      { headers: { Accept: 'application/json', 'User-Agent': UA } },
    );
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const user = data.user as Record<string, unknown> | undefined;
      const innerUser = user?.user as Record<string, unknown> | undefined;
      const id = innerUser?.id || user?.id;
      if (id) return String(id);
    }
  } catch {}

  // Method 2: /models/username (with cookies)
  try {
    const res = await fetch(
      `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(name)}`,
      { headers: { Accept: 'application/json', Cookie: cookieStr, 'User-Agent': UA } },
    );
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const user = data.user as Record<string, unknown> | undefined;
      if (user?.id) return String(user.id);
    }
  } catch {}

  return null;
}

async function main() {
  // 1. Verify session is ready
  const { data: sessions } = await sb
    .from('stripchat_sessions')
    .select('id, account_id, stripchat_user_id, csrf_token, cookies_json')
    .eq('is_valid', true);

  if (!sessions || sessions.length === 0) {
    console.error('No valid sessions found');
    process.exit(1);
  }

  const session = sessions[0];
  console.log('Session check:');
  console.log('  stripchat_user_id:', session.stripchat_user_id);
  console.log('  csrf_token:', session.csrf_token ? session.csrf_token.slice(0, 20) + '...' : 'NULL');

  if (!session.stripchat_user_id || !session.csrf_token) {
    console.error('Session not ready - run extract-csrf.ts first');
    process.exit(1);
  }

  const cj = session.cookies_json as Record<string, string>;
  const cookieStr = Object.entries(cj).map(([k, v]) => `${k}=${v}`).join('; ');

  // 2. Resolve SAKURA userIds
  console.log('\n=== Resolving SAKURA userIds ===');
  const resolved: { name: string; id: string | null }[] = [];

  for (const name of SAKURA_USERS) {
    const id = await resolveUserId(name, cookieStr);
    console.log(`  ${name}: ${id ? 'userId=' + id : 'FAILED'}`);
    resolved.push({ name, id });
  }

  // 3. Insert test records
  const validUsers = resolved.filter(u => u.id !== null);

  if (validUsers.length === 0) {
    console.error('No SAKURA users resolved');
    process.exit(1);
  }

  console.log(`\n=== Inserting ${validUsers.length} test records ===`);

  const testRecords = validUsers.map(u => ({
    account_id: ACCOUNT_ID,
    user_name: u.name,
    message: `[E2Eテスト] dm-service送信テスト ${new Date().toISOString().slice(0, 19)}`,
    cast_name: CAST_NAME,
    status: 'queued',
    campaign: 'pipe_e2e_test_20260302',
    target_user_id: parseInt(u.id!, 10),
    send_order: 'text_only',
    image_url: null,
    image_sent: false,
    profile_url: null,
    template_name: 'e2e_test',
    created_at: new Date(Date.now() - 120000).toISOString(), // 2分前（グレースピリオド回避）
  }));

  const { data: inserted, error: insertErr } = await sb
    .from('dm_send_log')
    .insert(testRecords)
    .select('id, user_name, status, target_user_id, cast_name');

  if (insertErr) {
    console.error('Insert error:', insertErr.message);
    process.exit(1);
  }

  console.log('Inserted test records:');
  for (const r of inserted!) {
    console.log(`  ID=${r.id} user=${r.user_name} target=${r.target_user_id} cast=${r.cast_name}`);
  }

  console.log(`\n=== Setup Complete ===`);
  console.log(`Inserted ${inserted!.length} test DM records (campaign=pipe_e2e_test_20260302)`);
  console.log('Next: npx tsx src/dm-service/index.ts');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
