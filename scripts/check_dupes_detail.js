const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const envContent = fs.readFileSync('frontend/.env.local', 'utf8');
const serviceKey = envContent.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1];
const sb = createClient('https://ujgbhkllfeacbgpdbjto.supabase.co', serviceKey);

(async () => {
  // sessionsテーブルの全カラム確認
  const { data: sample } = await sb
    .from('sessions')
    .select('*')
    .limit(1);
  console.log('=== sessions columns ===');
  if (sample && sample[0]) console.log(Object.keys(sample[0]).join(', '));

  // 全セッション数
  const { count: totalCount } = await sb
    .from('sessions')
    .select('*', { count: 'exact', head: true });
  console.log('\nTotal sessions:', totalCount);

  // ended_at IS NULL の件数
  const { count: openCount } = await sb
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .is('ended_at', null);
  console.log('Open sessions (ended_at IS NULL):', openCount);

  // total_messages = 0 AND ended_at IS NULL
  const { count: emptyOpenCount } = await sb
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .is('ended_at', null)
    .eq('total_messages', 0);
  console.log('Empty open sessions (no msgs, not ended):', emptyOpenCount);

  // 正常なセッション（メッセージあり OR 終了済み）
  console.log('Legitimate sessions:', totalCount - emptyOpenCount);

  // 同一分に複数作成されたセッション（全キャスト）
  const { data: allSessions } = await sb
    .from('sessions')
    .select('session_id, cast_name, account_id, started_at, ended_at, total_messages, total_coins, peak_viewers')
    .order('started_at', { ascending: true })
    .limit(3000);

  // started_atを分単位でグルーピング
  const byMinute = {};
  allSessions.forEach(s => {
    const min = s.cast_name + '|' + (s.started_at ? s.started_at.substring(0, 16) : 'null');
    if (!byMinute[min]) byMinute[min] = [];
    byMinute[min].push(s);
  });

  const minuteDupes = Object.entries(byMinute).filter(([, v]) => v.length > 1);
  console.log('\n=== Duplicate groups (same cast + same minute) ===');
  console.log('Groups:', minuteDupes.length);

  minuteDupes.forEach(([key, sessions]) => {
    const hasData = sessions.filter(s => s.total_messages > 0 || s.ended_at);
    const empty = sessions.filter(s => s.total_messages === 0 && !s.ended_at);
    console.log(key + ': total=' + sessions.length + '  withData=' + hasData.length + '  empty=' + empty.length);
  });

  // 既存のUNIQUE制約確認
  console.log('\n=== Check if any session_id is primary key ===');
  const idSet = new Set();
  let dupeIds = 0;
  allSessions.forEach(s => {
    if (idSet.has(s.session_id)) dupeIds++;
    idSet.add(s.session_id);
  });
  console.log('Duplicate session_ids:', dupeIds);
})();
