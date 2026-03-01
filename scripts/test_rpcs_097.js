const { Pool } = require('pg');
const pool = new Pool({
  host: 'aws-1-ap-northeast-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.ujgbhkllfeacbgpdbjto',
  password: process.argv[2] || 'uq+icfqd7m?JSv2',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
const AID = '16b70f53-db5d-4460-9453-3bcc5f4bc4f4';

async function main() {
  // Get a real session_id
  const sid = await pool.query(
    "SELECT session_id::TEXT AS sid FROM spy_messages WHERE account_id = $1 AND session_id IS NOT NULL ORDER BY message_time DESC LIMIT 1",
    [AID]
  );
  if (sid.rows.length === 0) {
    console.log('No sessions found');
    await pool.end();
    return;
  }
  const realSessionId = sid.rows[0].sid;
  console.log('Real session_id: ' + realSessionId);

  // Get cast_name for that session
  const castRes = await pool.query(
    "SELECT DISTINCT cast_name FROM spy_messages WHERE session_id = $1::UUID LIMIT 1",
    [realSessionId]
  );
  const cn = castRes.rows[0]?.cast_name || 'hanshakun';
  console.log('Cast: ' + cn);

  // Test get_session_list_v2
  try {
    const r = await pool.query("SELECT broadcast_group_id, cast_name, msg_count, total_revenue FROM get_session_list_v2($1, $2, 3)", [AID, cn]);
    console.log('\n✅ get_session_list_v2: ' + r.rows.length + ' rows');
    if (r.rows[0]) console.log('   → msgs=' + r.rows[0].msg_count + ' revenue=' + r.rows[0].total_revenue);
  } catch(e) { console.log('\n❌ get_session_list_v2: ' + e.message.substring(0,120)); }

  // Test get_session_summary_v2
  try {
    const r = await pool.query("SELECT broadcast_group_id, cast_name, msg_count, coin_tokens, total_revenue FROM get_session_summary_v2($1, $2)", [AID, realSessionId]);
    console.log('✅ get_session_summary_v2: ' + r.rows.length + ' rows');
    if (r.rows[0]) console.log('   → cast=' + r.rows[0].cast_name + ' msgs=' + r.rows[0].msg_count + ' revenue=' + r.rows[0].total_revenue);
  } catch(e) { console.log('❌ get_session_summary_v2: ' + e.message.substring(0,120)); }

  // Test get_transcript_timeline
  try {
    const r = await pool.query("SELECT * FROM get_transcript_timeline($1, $2, $3) LIMIT 5", [AID, cn, realSessionId]);
    console.log('✅ get_transcript_timeline: ' + r.rows.length + ' rows');
  } catch(e) { console.log('❌ get_transcript_timeline: ' + e.message.substring(0,120)); }

  // Test check_spy_data_integrity
  try {
    const r = await pool.query("SELECT check_spy_data_integrity()");
    const data = r.rows[0].check_spy_data_integrity;
    console.log('✅ check_spy_data_integrity:');
    for (const [key, val] of Object.entries(data)) {
      console.log('   ' + key + ': ' + val.count + ' issues');
    }
  } catch(e) { console.log('❌ check_spy_data_integrity: ' + e.message.substring(0,120)); }

  // Test close_orphan_sessions
  try {
    const r = await pool.query("SELECT close_orphan_sessions()");
    console.log('✅ close_orphan_sessions: ' + r.rows[0].close_orphan_sessions + ' orphans');
  } catch(e) { console.log('❌ close_orphan_sessions: ' + e.message.substring(0,120)); }

  // Test get_new_users_by_session
  try {
    const r = await pool.query("SELECT * FROM get_new_users_by_session($1, $2, $3)", [AID, cn, '2026-02-25']);
    console.log('✅ get_new_users_by_session: ' + r.rows.length + ' rows');
  } catch(e) { console.log('❌ get_new_users_by_session: ' + e.message.substring(0,120)); }

  // DM queue status
  const dm = await pool.query("SELECT status, COUNT(*)::INTEGER AS cnt FROM dm_send_log GROUP BY status ORDER BY cnt DESC");
  console.log('\n=== dm_send_log status ===');
  for (const row of dm.rows) {
    console.log('  ' + row.status + ': ' + row.cnt);
  }
  const queued = await pool.query("SELECT COUNT(*)::INTEGER AS cnt FROM dm_send_log WHERE status = 'queued'");
  console.log('\nqueued件数: ' + queued.rows[0].cnt);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
