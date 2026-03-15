const { Pool } = require('pg');
const pool = new Pool({
  host: 'aws-1-ap-northeast-1.pooler.supabase.com',
  port: 5432, database: 'postgres',
  user: 'postgres.ujgbhkllfeacbgpdbjto',
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
pool.connect().then(async c => {
  const r1 = await c.query("SELECT cast_name, COUNT(*) as total, MAX(created_at) as latest FROM spy_messages GROUP BY cast_name ORDER BY latest DESC");
  console.log("=== spy_messages by cast_name ===");
  for (const r of r1.rows) {
    console.log("  " + String(r.cast_name || "NULL").padEnd(25) + " total=" + String(r.total).padStart(7) + " latest=" + r.latest);
  }

  const r2 = await c.query("SELECT cast_name, COUNT(*) as last_24h FROM spy_messages WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY cast_name");
  console.log("\n=== spy_messages last 24h ===");
  if (r2.rows.length === 0) console.log("  (none)");
  for (const r of r2.rows) console.log("  " + r.cast_name + ": " + r.last_24h);

  const r3 = await c.query("SELECT session_id, cast_name, started_at, ended_at, peak_viewers, total_tokens, created_at FROM sessions ORDER BY created_at DESC LIMIT 5");
  console.log("\n=== sessions (latest 5) ===");
  for (const r of r3.rows) {
    console.log("  " + String(r.cast_name || "").padEnd(15) + " started=" + r.started_at + " ended=" + r.ended_at + " peak=" + r.peak_viewers + " tokens=" + r.total_tokens);
  }

  const r4 = await c.query("SELECT cast_name, COUNT(*) as total, MAX(created_at) as latest FROM viewer_stats GROUP BY cast_name");
  console.log("\n=== viewer_stats by cast_name ===");
  if (r4.rows.length === 0) console.log("  (none)");
  for (const r of r4.rows) {
    console.log("  " + String(r.cast_name || "NULL").padEnd(25) + " total=" + String(r.total).padStart(7) + " latest=" + r.latest);
  }

  c.release(); pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
