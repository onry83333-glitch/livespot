const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://ujgbhkllfeacbgpdbjto.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ'
);

async function check() {
  // spy_viewers全件をsession_idでグループ化
  const {data: all} = await sb.from('spy_viewers').select('id, cast_name, session_id, user_name, first_seen_at').order('session_id');

  console.log('=== spy_viewers 全' + all.length + '件 session_id別 ===');
  const groups = {};
  all.forEach(v => {
    const sid = v.session_id || '(NULL)';
    if (!(sid in groups)) groups[sid] = [];
    groups[sid].push(v);
  });

  let mixedCount = 0;
  Object.entries(groups).forEach(([sid, rows]) => {
    const casts = [...new Set(rows.map(r => r.cast_name))];
    const mixed = casts.length > 1 ? '*** MIXED ***' : '';
    if (casts.length > 1) mixedCount++;
    console.log('');
    console.log('session_id: ' + sid.substring(0,12) + '... (' + rows.length + '件) ' + mixed);
    console.log('  cast_names: ' + casts.join(', '));
    rows.forEach(r => console.log('    id=' + r.id + ' cast=' + r.cast_name + ' user=' + r.user_name));
  });

  console.log('');
  console.log('=== 混在session数: ' + mixedCount + ' / ' + Object.keys(groups).length + ' ===');

  // sessionsテーブルでこのsession_idのcast_nameを確認
  const sessionIds = Object.keys(groups).filter(s => s !== '(NULL)');
  console.log('');
  console.log('=== sessions テーブル突合 ===');
  for (const sid of sessionIds) {
    const {data: sess} = await sb.from('sessions').select('session_id, cast_name, started_at').eq('session_id', sid);
    const viewerCasts = [...new Set(groups[sid].map(r => r.cast_name))];
    if (sess && sess.length > 0) {
      const match = viewerCasts.length === 1 && viewerCasts[0] === sess[0].cast_name ? 'MATCH' : 'MISMATCH';
      console.log('  ' + sid.substring(0,12) + ' sessions.cast=' + sess[0].cast_name + ' viewers.casts=[' + viewerCasts.join(',') + '] ' + match);
    } else {
      console.log('  ' + sid.substring(0,12) + ' NOT FOUND (孤児) viewers.casts=[' + viewerCasts.join(',') + ']');
    }
  }

  // spy_messages: 同一 session_id に複数 cast_name が存在するか（直近1000件サンプル）
  console.log('');
  console.log('=== spy_messages session_id混在チェック ===');
  const {data: msgs} = await sb.from('spy_messages')
    .select('cast_name, message_time')
    .gte('created_at', '2026-02-25')
    .order('message_time', {ascending: false})
    .limit(5000);

  if (msgs) {
    // user_nameが同一で複数cast_nameに出現するユーザーを検出
    const userCasts = {};
    // message_timeベースで5秒以内の連続メッセージでcast_nameが変わるケース
    let rapidSwitch = 0;
    for (let i = 1; i < msgs.length; i++) {
      const curr = msgs[i];
      const prev = msgs[i-1];
      if (curr.cast_name !== prev.cast_name) {
        const dt = Math.abs(new Date(curr.message_time) - new Date(prev.message_time));
        if (dt < 1000) { // 1秒以内
          rapidSwitch++;
          if (rapidSwitch <= 5) {
            console.log('  RAPID: ' + prev.cast_name + ' -> ' + curr.cast_name + ' dt=' + dt + 'ms');
          }
        }
      }
    }
    console.log('  1秒以内のcast_name切替: ' + rapidSwitch + '件 / ' + msgs.length + '件');
  }
}
check().catch(e => console.error(e));
