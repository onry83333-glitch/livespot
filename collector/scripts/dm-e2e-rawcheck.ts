import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  const { data } = await sb
    .from('dm_send_log')
    .select('id, user_name, status, error, sent_at, sent_via')
    .in('id', [8307, 8308, 8309]);

  // Raw JSON output
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
