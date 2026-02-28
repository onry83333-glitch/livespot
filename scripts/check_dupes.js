const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const envContent = fs.readFileSync('frontend/.env.local', 'utf8');
const serviceKey = envContent.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1];

const sb = createClient('https://ujgbhkllfeacbgpdbjto.supabase.co', serviceKey);

(async () => {
  // 0o_MOMO_o0 の全セッション
  const { data, error } = await sb
    .from('sessions')
    .select('session_id, cast_name, started_at, ended_at, total_messages, total_coins, peak_viewers, account_id')
    .eq('cast_name', '0o_MOMO_o0')
    .order('started_at', { ascending: false })
    .limit(500);

  if (error) { console.error('ERROR:', error); return; }
  console.log('Total sessions for 0o_MOMO_o0:', data.length);

  // 同一秒に作成されたセッションをグループ化
  const bySecond = {};
  data.forEach(s => {
    const sec = s.started_at ? s.started_at.substring(0, 19) : 'null';
    if (!bySecond[sec]) bySecond[sec] = [];
    bySecond[sec].push(s);
  });

  // 重複（同一秒に2件以上）を表示
  const dupes = Object.entries(bySecond).filter(([, v]) => v.length > 1);
  console.log('Duplicate groups (same second):', dupes.length);
  dupes.slice(0, 10).forEach(([sec, sessions]) => {
    console.log('\n--- ' + sec + ' (' + sessions.length + ' sessions) ---');
    sessions.forEach(s => {
      console.log('  id=' + s.session_id + '  ended=' + (s.ended_at ? 'yes' : 'no') + '  msgs=' + s.total_messages + '  tokens=' + s.total_coins + '  viewers=' + s.peak_viewers);
    });
  });

  // 全キャストの重複も確認
  console.log('\n\n=== All casts duplicate check ===');
  const { data: allSessions, error: err2 } = await sb
    .from('sessions')
    .select('session_id, cast_name, started_at, ended_at, total_messages, total_coins, peak_viewers')
    .order('started_at', { ascending: false })
    .limit(3000);

  if (err2) { console.error('ERROR:', err2); return; }
  console.log('Total sessions across all casts:', allSessions.length);

  const byCastSecond = {};
  allSessions.forEach(s => {
    const key = s.cast_name + '|' + (s.started_at ? s.started_at.substring(0, 19) : 'null');
    if (!byCastSecond[key]) byCastSecond[key] = [];
    byCastSecond[key].push(s);
  });

  const allDupes = Object.entries(byCastSecond).filter(([, v]) => v.length > 1);
  console.log('All duplicate groups:', allDupes.length);

  // Cast別集計
  const castDupeCounts = {};
  allDupes.forEach(([key, sessions]) => {
    const cast = key.split('|')[0];
    if (!castDupeCounts[cast]) castDupeCounts[cast] = 0;
    castDupeCounts[cast] += sessions.length - 1; // 余剰分
  });

  Object.entries(castDupeCounts).sort((a, b) => b[1] - a[1]).forEach(([cast, count]) => {
    console.log('  ' + cast + ': ' + count + ' duplicate sessions');
  });

  // 0o_MOMO_o0の同一session_idの重複チェック
  console.log('\n=== Same session_id duplicates (0o_MOMO_o0) ===');
  const byId = {};
  data.forEach(s => {
    if (!byId[s.session_id]) byId[s.session_id] = [];
    byId[s.session_id].push(s);
  });
  const idDupes = Object.entries(byId).filter(([, v]) => v.length > 1);
  console.log('session_id duplicates:', idDupes.length);

  // session_idの生成パターン確認
  console.log('\n=== Session ID pattern (first 10) ===');
  data.slice(0, 10).forEach(s => {
    console.log('  id=' + s.session_id.substring(0, 8) + '...  started=' + s.started_at);
  });
})();
