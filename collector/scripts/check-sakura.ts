import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function main() {
  const names = ['pojipojipoji', 'kantou1234', 'Nekomeem34'];

  // 1. Check paid_users
  const { data: users } = await sb
    .from('paid_users')
    .select('user_name, user_id_stripchat, cast_name')
    .in('user_name', names);
  console.log('paid_users:', JSON.stringify(users, null, 2));

  // 2. Check spy_messages
  const { data: msgs } = await sb
    .from('spy_messages')
    .select('user_name, cast_name')
    .in('user_name', names)
    .limit(10);
  console.log('\nspy_messages:', JSON.stringify(msgs, null, 2));

  // 3. Try Stripchat API for regular users (not models)
  // Get session cookies for authenticated request
  const { data: sessions } = await sb
    .from('stripchat_sessions')
    .select('cookies_json')
    .eq('is_valid', true);
  const cj = sessions![0].cookies_json as Record<string, string>;
  const cookieStr = Object.entries(cj).map(([k, v]) => `${k}=${v}`).join('; ');

  for (const name of names) {
    // Try search-like endpoints
    const endpoints = [
      `https://stripchat.com/api/front/v2/models/username/${name}`,
      `https://ja.stripchat.com/api/front/users/search?query=${name}`,
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json', Cookie: cookieStr, 'User-Agent': UA },
        });
        console.log(`\n${name} @ ${url.split('/').slice(-2).join('/')}: ${res.status}`);
        if (res.ok) {
          const data = await res.json();
          const str = JSON.stringify(data).slice(0, 300);
          console.log('  Response:', str);
        }
      } catch (err) {
        console.log(`  Error: ${err}`);
      }
    }

    // Try the DM conversation lookup (will create conversation if exists)
    // GET conversations for a known userId pair
    try {
      const res = await fetch(
        `https://ja.stripchat.com/api/front/v2/models/username/${name}/cam`,
        { headers: { Accept: 'application/json', 'User-Agent': UA } },
      );
      console.log(`${name} cam endpoint: ${res.status}`);
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        console.log('  user:', JSON.stringify(data?.user).slice(0, 200));
      }
    } catch {}
  }
}

main().catch(console.error);
