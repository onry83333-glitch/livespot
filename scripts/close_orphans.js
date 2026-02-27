// One-off script to close orphan sessions older than 24h
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const env = fs.readFileSync('frontend/.env.local', 'utf8');
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)[1].trim();
const skey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)[1].trim();
const sb = createClient(url, skey);

async function main() {
  const cutoff = new Date(Date.now() - 24*60*60*1000).toISOString();
  const { data: orphans } = await sb
    .from('sessions')
    .select('session_id, started_at')
    .is('ended_at', null)
    .lt('started_at', cutoff);

  console.log('Orphan sessions (>24h old):', orphans ? orphans.length : 0);

  if (orphans && orphans.length > 0) {
    let updated = 0;
    for (const s of orphans) {
      const endedAt = new Date(new Date(s.started_at).getTime() + 4*60*60*1000).toISOString();
      const { error } = await sb
        .from('sessions')
        .update({ ended_at: endedAt })
        .eq('session_id', s.session_id);
      if (error) {
        console.log('Error:', s.session_id, error.message);
      } else {
        updated++;
      }
    }
    console.log('Updated:', updated);
  }

  // Verify
  const { count: stillOpen } = await sb.from('sessions').select('session_id', { count: 'exact', head: true }).is('ended_at', null);
  const { count: total } = await sb.from('sessions').select('session_id', { count: 'exact', head: true });
  console.log('\n=== After cleanup ===');
  console.log('Total:', total);
  console.log('Still open:', stillOpen);
  console.log('Closed:', total - stillOpen);
  console.log('Open rate:', ((stillOpen / total) * 100).toFixed(1) + '%');
}

main().catch(err => { console.error(err); process.exit(1); });
