const { createClient } = require('@supabase/supabase-js');
const sb = createClient(
  'https://ujgbhkllfeacbgpdbjto.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ'
);

async function check() {
  // 1. 登録キャスト一覧取得
  const {data: rc} = await sb.from('registered_casts').select('cast_name, account_id').eq('is_active', true);
  const {data: sc} = await sb.from('spy_casts').select('cast_name, account_id').eq('is_active', true);
  const allCasts = new Set([...rc.map(r=>r.cast_name), ...sc.map(s=>s.cast_name)]);

  console.log('=== 登録キャスト ===');
  console.log('自社:', rc.map(r=>r.cast_name).join(', '));
  console.log('他社:', sc.map(s=>s.cast_name).join(', '));
  console.log('合計:', allCasts.size, '件');

  // 2. spy_messages 直近10000件のcast_name分布
  const {data: recentCasts, error: e1} = await sb.from('spy_messages')
    .select('cast_name')
    .gte('created_at', '2026-02-01')
    .order('created_at', {ascending: false})
    .limit(10000);

  if (e1) { console.log('ERROR recentCasts:', e1.message); return; }

  const castCounts = {};
  recentCasts.forEach(r => {
    castCounts[r.cast_name || '(NULL)'] = (castCounts[r.cast_name || '(NULL)'] || 0) + 1;
  });

  console.log('\n=== spy_messages cast_name 分布（2月以降 直近10000件） ===');
  Object.entries(castCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
    const registered = allCasts.has(k) ? 'OK' : 'UNKNOWN';
    console.log(`  ${k}: ${v}件 [${registered}]`);
  });

  // 3. spy_messages で cast_name=NULL or 空文字
  const {count: nullCount} = await sb.from('spy_messages').select('*', {count: 'exact', head: true}).is('cast_name', null);
  const {count: emptyCount} = await sb.from('spy_messages').select('*', {count: 'exact', head: true}).eq('cast_name', '');
  console.log('\n=== spy_messages 異常値 ===');
  console.log('  cast_name=NULL:', nullCount, '件');
  console.log('  cast_name=空文字:', emptyCount, '件');

  // 4. spy_viewers データ検証
  const {data: viewers, error: e2} = await sb.from('spy_viewers').select('cast_name, session_id').limit(5000);
  if (e2) { console.log('spy_viewers ERROR:', e2.message); }
  else {
    const viewerCastCounts = {};
    let nullSession = 0;
    let emptySession = 0;
    viewers.forEach(v => {
      viewerCastCounts[v.cast_name || '(NULL)'] = (viewerCastCounts[v.cast_name || '(NULL)'] || 0) + 1;
      if (v.session_id === null || v.session_id === undefined) nullSession++;
      if (v.session_id === '') emptySession++;
    });
    console.log('\n=== spy_viewers cast_name 分布 ===');
    Object.entries(viewerCastCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
      const registered = allCasts.has(k) ? 'OK' : 'UNKNOWN';
      console.log(`  ${k}: ${v}件 [${registered}]`);
    });
    console.log(`  session_id=NULL: ${nullSession}件 / ${viewers.length}件`);
    console.log(`  session_id=空文字: ${emptySession}件`);
  }

  // 5. viewer_stats データ検証
  const {data: vstats, error: e3} = await sb.from('viewer_stats').select('cast_name').limit(5000);
  if (e3) { console.log('viewer_stats ERROR:', e3.message); }
  else {
    const vstatsCounts = {};
    vstats.forEach(v => {
      vstatsCounts[v.cast_name || '(NULL)'] = (vstatsCounts[v.cast_name || '(NULL)'] || 0) + 1;
    });
    console.log('\n=== viewer_stats cast_name 分布 ===');
    Object.entries(vstatsCounts).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
      const registered = allCasts.has(k) ? 'OK' : 'UNKNOWN';
      console.log(`  ${k}: ${v}件 [${registered}]`);
    });
  }

  // 6. spy_viewers で session_id と sessions テーブルの突合
  const {data: viewerSessions, error: e4} = await sb.from('spy_viewers')
    .select('session_id, cast_name')
    .not('session_id', 'is', null)
    .neq('session_id', '')
    .limit(1000);

  if (e4) { console.log('viewerSessions ERROR:', e4.message); }
  else if (viewerSessions.length > 0) {
    const uniqueSessionIds = [...new Set(viewerSessions.map(v => v.session_id))];
    console.log(`\n=== spy_viewers session_id 突合（${uniqueSessionIds.length}件のユニークsession_id） ===`);

    // sessionsテーブルに存在するか確認（最大50件サンプル）
    const sampleIds = uniqueSessionIds.slice(0, 50);
    const {data: existingSessions, error: e5} = await sb.from('sessions')
      .select('session_id, cast_name')
      .in('session_id', sampleIds);

    if (e5) { console.log('sessions突合 ERROR:', e5.message); }
    else {
      const existingSet = new Set(existingSessions.map(s => s.session_id));
      let orphaned = 0;
      let mismatch = 0;

      sampleIds.forEach(sid => {
        if (!existingSet.has(sid)) {
          orphaned++;
        } else {
          // session_idのcast_nameとspy_viewersのcast_nameが一致するか
          const sessionCast = existingSessions.find(s => s.session_id === sid);
          const viewerCast = viewerSessions.find(v => v.session_id === sid);
          if (sessionCast && viewerCast && sessionCast.cast_name !== viewerCast.cast_name) {
            mismatch++;
            console.log(`  MISMATCH: session_id=${sid} sessions.cast=${sessionCast.cast_name} vs viewers.cast=${viewerCast.cast_name}`);
          }
        }
      });

      console.log(`  サンプル${sampleIds.length}件中: 孤児=${orphaned}件, cast_name不一致=${mismatch}件`);
    }
  }

  // 7. spy_messages で同一 message_time + user_name に異なる cast_name が紐づくケース
  const {data: crossCheck, error: e6} = await sb.rpc('check_data_integrity', {p_valid_since: '2025-02-15'}).catch(() => ({data: null, error: {message: 'RPC不可'}}));
  if (crossCheck) {
    console.log('\n=== check_data_integrity RPC結果 ===');
    if (typeof crossCheck === 'object') {
      Object.entries(crossCheck).forEach(([k, v]) => {
        if (v && typeof v === 'object' && v.status) {
          const icon = v.status === 'ok' ? 'OK' : 'WARN';
          console.log(`  [${icon}] ${k}: ${JSON.stringify(v).substring(0, 120)}`);
        }
      });
    }
  }
}

check().catch(e => console.error(e));
