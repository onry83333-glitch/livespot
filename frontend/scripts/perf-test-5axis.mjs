/**
 * collect5AxisData の処理時間を計測するスクリプト
 * Usage: node scripts/perf-test-5axis.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env.local を読み込み
const envPath = resolve(__dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY?.replace(/[\s\r\n]+/g, '');

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const castName = 'Risa_06';
const accountId = '940e7248-1d73-4259-a538-56fdaea9d740';

async function main() {
  console.log('=== FB Report Performance Test ===\n');

  // 1. get_coin_sessions RPC
  let t0 = Date.now();
  const { data: sessions, error: sessErr } = await sb.rpc('get_coin_sessions', {
    p_account_id: accountId,
    p_cast_name: castName,
    p_limit: 10,
  });
  let t1 = Date.now();
  console.log(`[1] get_coin_sessions: ${t1 - t0}ms  (${sessions?.length || 0} sessions, error: ${sessErr?.message || 'none'})`);

  if (!sessions || sessions.length === 0) {
    console.log('No sessions found. Exiting.');
    return;
  }

  const latest = sessions[0];
  console.log(`    Latest session: ${JSON.stringify(latest).slice(0, 200)}`);

  // 2. coin_transactions for latest session
  t0 = Date.now();
  const sessionStart = latest.session_start || latest.start_time;
  const sessionEnd = latest.session_end || latest.end_time;
  const { data: txRows, error: txErr } = await sb
    .from('coin_transactions')
    .select('user_name, tokens, date, type')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .gte('date', sessionStart)
    .lte('date', sessionEnd)
    .gt('tokens', 0)
    .order('tokens', { ascending: false })
    .limit(1000);
  t1 = Date.now();
  console.log(`[2] coin_transactions (session): ${t1 - t0}ms  (${txRows?.length || 0} rows, error: ${txErr?.message || 'none'})`);

  const allTipperNames = [...new Set((txRows || []).map(r => r.user_name))];
  console.log(`    Unique tippers: ${allTipperNames.length}`);

  // 3. Per-tipper history check (the N*4 query pattern)
  if (allTipperNames.length > 0) {
    const sampleSize = Math.min(allTipperNames.length, 5);
    t0 = Date.now();

    // Test with 5 tippers first to estimate
    for (let i = 0; i < sampleSize; i++) {
      const name = allTipperNames[i];
      await sb
        .from('coin_transactions')
        .select('date')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .eq('user_name', name)
        .lt('date', sessionStart)
        .gt('tokens', 0)
        .order('date', { ascending: true })
        .limit(1);
    }
    t1 = Date.now();
    const perUserMs = (t1 - t0) / sampleSize;
    console.log(`[3] Per-tipper history (${sampleSize} sample): ${t1 - t0}ms  (${perUserMs.toFixed(0)}ms/user)`);
    console.log(`    ESTIMATED for all ${allTipperNames.length} tippers × 4 queries: ${(allTipperNames.length * 4 * perUserMs / 1000).toFixed(1)}s`);

    // Full run for all tippers (1 query each, not 4)
    t0 = Date.now();
    await Promise.all(allTipperNames.map(name =>
      sb.from('coin_transactions')
        .select('date')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .eq('user_name', name)
        .lt('date', sessionStart)
        .gt('tokens', 0)
        .order('date', { ascending: true })
        .limit(1)
    ));
    t1 = Date.now();
    console.log(`[3b] All ${allTipperNames.length} tippers (parallel, 1 query each): ${t1 - t0}ms`);
  }

  // 4. chat_logs query
  t0 = Date.now();
  const { data: chatRows, error: chatErr } = await sb
    .from('chat_logs')
    .select('username, message, timestamp')
    .eq('cast_name', castName)
    .gte('timestamp', sessionStart)
    .lte('timestamp', sessionEnd)
    .order('timestamp', { ascending: false })
    .limit(500);
  t1 = Date.now();
  console.log(`[4] chat_logs (session): ${t1 - t0}ms  (${chatRows?.length || 0} rows, error: ${chatErr?.message || 'none'})`);

  // 5. Group D - session history (past sessions tipper maps)
  t0 = Date.now();
  let sessionQueryCount = 0;
  for (let si = 1; si < Math.min(sessions.length, 6); si++) {
    const s = sessions[si];
    const sStart = s.session_start || s.start_time;
    const sEnd = s.session_end || s.end_time;
    await sb
      .from('coin_transactions')
      .select('user_name')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('date', sStart)
      .lte('date', sEnd)
      .gt('tokens', 0)
      .limit(1000);
    sessionQueryCount++;
  }
  t1 = Date.now();
  console.log(`[5] Group D session history: ${t1 - t0}ms  (${sessionQueryCount} session queries)`);

  // 6. Group C - cross competitor
  if (allTipperNames.length > 0) {
    const fanSlice = allTipperNames.slice(0, 50);
    t0 = Date.now();
    const { data: crossRows } = await sb
      .from('chat_logs')
      .select('username, cast_name, timestamp')
      .in('username', fanSlice)
      .neq('cast_name', castName)
      .order('timestamp', { ascending: false })
      .limit(500);
    t1 = Date.now();
    console.log(`[6] Group C chat_logs cross: ${t1 - t0}ms  (${crossRows?.length || 0} rows, batch=${fanSlice.length})`);

    t0 = Date.now();
    const { data: spyRows } = await sb
      .from('spy_messages')
      .select('user_name, cast_name, message_time')
      .in('user_name', fanSlice)
      .neq('cast_name', castName)
      .eq('msg_type', 'chat')
      .order('message_time', { ascending: false })
      .limit(500);
    t1 = Date.now();
    console.log(`[6b] Group C spy_messages cross: ${t1 - t0}ms  (${spyRows?.length || 0} rows)`);

    t0 = Date.now();
    const { data: goalRows } = await sb
      .from('spy_messages')
      .select('cast_name, message_time, message')
      .eq('msg_type', 'goal')
      .order('message_time', { ascending: false })
      .limit(200);
    t1 = Date.now();
    console.log(`[6c] Group C spy_messages goals: ${t1 - t0}ms  (${goalRows?.length || 0} rows)`);
  }

  // 7. Anthropic API test (minimal)
  if (ANTHROPIC_API_KEY) {
    t0 = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
      }),
    });
    const data = await res.json();
    t1 = Date.now();
    console.log(`[7] Anthropic API (100 tokens): ${t1 - t0}ms  (status: ${res.status})`);

    // Estimate for 8000 tokens
    console.log(`    ESTIMATED for 8000 max_tokens: ~${((t1 - t0) * 20).toFixed(0)}ms (rough 20x)`);
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
