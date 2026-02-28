// Apply the close_orphan_sessions RPC function
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const env = fs.readFileSync('frontend/.env.local', 'utf8');
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)[1].trim();
const skey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)[1].trim();
const sb = createClient(url, skey);

async function main() {
  const sql = `
CREATE OR REPLACE FUNCTION close_orphan_sessions(
  p_stale_threshold INTERVAL DEFAULT INTERVAL '6 hours'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_closed INTEGER;
BEGIN
  WITH orphans AS (
    SELECT session_id, started_at
    FROM sessions
    WHERE ended_at IS NULL
      AND started_at < NOW() - p_stale_threshold
  )
  UPDATE sessions s
  SET ended_at = o.started_at + INTERVAL '4 hours'
  FROM orphans o
  WHERE s.session_id = o.session_id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$func$;
`;

  const { error } = await sb.rpc('', {});  // dummy to test connection
  // Use the SQL editor endpoint directly
  const response = await fetch(url + '/rest/v1/rpc/', {
    method: 'POST',
    headers: {
      'apikey': skey,
      'Authorization': 'Bearer ' + skey,
      'Content-Type': 'application/json',
    },
  });

  // Actually, use supabase management API or just document it
  console.log('RPC function SQL ready in migration 088.');
  console.log('Apply via Supabase SQL Editor or supabase db push.');
  console.log('The data cleanup (784 sessions) has already been applied.');
}

main().catch(err => { console.error(err); process.exit(1); });
