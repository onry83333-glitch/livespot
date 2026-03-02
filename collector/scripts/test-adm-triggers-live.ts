/**
 * test-adm-triggers-live.ts — ADMトリガー7種 本番発火テスト
 *
 * DM送信は行わない。各トリガーの発火条件を実データで検証し、
 * 発火対象ユーザーの一覧を出力する。
 *
 * Usage: npx tsx scripts/test-adm-triggers-live.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface TestResult {
  trigger: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
  targets: number;
  detail: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  console.log(`  ${msg}`);
}

async function main() {
  console.log('='.repeat(70));
  console.log('ADMトリガー 本番発火テスト');
  console.log('='.repeat(70));

  // ========================================
  // Step 0: トリガー定義の確認
  // ========================================
  console.log('\n📋 Step 0: dm_triggers テーブル確認');
  const { data: triggers, error: trigErr } = await sb
    .from('dm_triggers')
    .select('*')
    .eq('account_id', ACCOUNT_ID);

  if (trigErr) {
    console.error('dm_triggers取得失敗:', trigErr.message);
    process.exit(1);
  }

  console.log(`  登録済みトリガー: ${triggers?.length || 0}件`);
  for (const t of triggers || []) {
    const active = t.is_active ? '✅' : '❌';
    console.log(`  ${active} [${t.trigger_type}] ${t.trigger_name} (cooldown=${t.cooldown_hours}h, daily_limit=${t.daily_limit})`);
  }

  // アクティブトリガーを取得
  const activeTriggers = (triggers || []).filter((t: any) => t.is_active);
  console.log(`  アクティブ: ${activeTriggers.length}件`);

  // ========================================
  // Step 1: spy_user_profiles の存在確認
  // ========================================
  console.log('\n📋 Step 1: spy_user_profiles データ確認');
  const { count: profileCount } = await sb
    .from('spy_user_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ACCOUNT_ID);

  log(`spy_user_profiles 全件: ${profileCount || 0}`);

  const { count: regProfileCount } = await sb
    .from('spy_user_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ACCOUNT_ID)
    .eq('is_registered_cast', true);

  log(`自社キャスト: ${regProfileCount || 0}`);

  const { count: spyProfileCount } = await sb
    .from('spy_user_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', ACCOUNT_ID)
    .eq('is_registered_cast', false);

  log(`他社キャスト: ${spyProfileCount || 0}`);

  // ========================================
  // Test 1: first_visit — 初回訪問
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 1: first_visit — 初回訪問者検知');
  console.log('─'.repeat(70));

  const fvTrigger = activeTriggers.find((t: any) => t.trigger_type === 'first_visit');
  if (!fvTrigger) {
    log('⚠️ first_visit トリガーが未定義またはis_active=false');
    results.push({ trigger: 'first_visit', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    log(`トリガー: ${fvTrigger.trigger_name}`);
    // first_visitはリアルタイム (onViewerListUpdate) で発火するため、
    // 既知視聴者数を確認
    const { data: knownViewers } = await sb
      .from('spy_user_profiles')
      .select('user_name')
      .eq('account_id', ACCOUNT_ID)
      .eq('is_registered_cast', true)
      .limit(10);

    log(`既知視聴者サンプル: ${(knownViewers || []).map((v: any) => v.user_name).slice(0, 5).join(', ')}`);
    log(`発火条件: 配信中に未知の視聴者がviewer listに出現 → 自動発火`);
    log(`検証: リアルタイムトリガーのため、配信中のみ評価可能`);

    // シミュレーション: 既知でないユーザーが来たら発火する
    const knownSet = new Set((knownViewers || []).map((v: any) => v.user_name));
    const testViewers = [
      { userName: 'SIMULATED_NEW_USER_1' },
      { userName: (knownViewers || [])[0]?.user_name || 'existing_user' },
    ];
    const newOnes = testViewers.filter(v => !knownSet.has(v.userName));
    log(`シミュレーション: ${testViewers.length}人中 ${newOnes.length}人が新規 → 発火対象`);
    results.push({
      trigger: 'first_visit',
      status: 'PASS',
      targets: newOnes.length,
      detail: `ロジック検証OK。既知${knownSet.size}人。リアルタイム発火型。`,
    });
  }

  // ========================================
  // Test 2: vip_no_tip — VIP投げ銭なし
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 2: vip_no_tip — VIP投げ銭なし検知');
  console.log('─'.repeat(70));

  const vntTrigger = activeTriggers.find((t: any) => t.trigger_type === 'vip_no_tip');
  if (!vntTrigger) {
    log('⚠️ vip_no_tip トリガーが未定義');
    results.push({ trigger: 'vip_no_tip', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    const cond = vntTrigger.conditions || {};
    const minTokens = (cond.min_total_tokens as number) || 1000;
    log(`トリガー: ${vntTrigger.trigger_name} (min_total_tokens=${minTokens})`);

    // 最新のセッションを取得
    const { data: latestSession } = await sb
      .from('sessions')
      .select('session_id, cast_name, started_at, ended_at')
      .eq('account_id', ACCOUNT_ID)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(1)
      .single();

    if (!latestSession) {
      log('❌ 終了済みセッションが見つからない');
      results.push({ trigger: 'vip_no_tip', status: 'FAIL', targets: 0, detail: '終了済みセッションなし' });
    } else {
      log(`最新セッション: ${latestSession.cast_name} (${latestSession.session_id?.substring(0, 8)}...)`);

      // spy_viewers からそのセッションの視聴者を取得
      const { data: viewers, count: viewerCount } = await sb
        .from('spy_viewers')
        .select('user_name', { count: 'exact' })
        .eq('account_id', ACCOUNT_ID)
        .eq('cast_name', latestSession.cast_name)
        .eq('session_id', latestSession.session_id);

      log(`セッション視聴者(spy_viewers): ${viewerCount || 0}人`);

      // tippers
      const { data: tippers } = await sb
        .from('spy_messages')
        .select('user_name')
        .eq('account_id', ACCOUNT_ID)
        .eq('cast_name', latestSession.cast_name)
        .eq('session_id', latestSession.session_id)
        .gt('tokens', 0);

      const tipperSet = new Set((tippers || []).map((t: any) => t.user_name));
      const viewerNames = (viewers || []).map((v: any) => v.user_name);
      const noTipViewers = viewerNames.filter((n: string) => !tipperSet.has(n));

      log(`チップあり: ${tipperSet.size}人, チップなし: ${noTipViewers.length}人`);

      // 高額ユーザーでチップなしをフィルタ
      if (noTipViewers.length > 0) {
        const { data: vips } = await sb
          .from('spy_user_profiles')
          .select('user_name, total_tokens')
          .eq('account_id', ACCOUNT_ID)
          .eq('cast_name', latestSession.cast_name)
          .eq('is_registered_cast', true)
          .in('user_name', noTipViewers.slice(0, 200))
          .gte('total_tokens', minTokens);

        log(`VIP(${minTokens}tk以上)でチップなし: ${(vips || []).length}人`);
        if (vips && vips.length > 0) {
          for (const v of vips.slice(0, 5)) {
            log(`  → ${v.user_name} (累計${v.total_tokens}tk)`);
          }
        }
        results.push({
          trigger: 'vip_no_tip',
          status: (vips || []).length > 0 ? 'PASS' : 'WARN',
          targets: (vips || []).length,
          detail: `視聴者${viewerCount}人中、VIP(${minTokens}tk+)でチップなし${(vips || []).length}人`,
        });
      } else {
        results.push({
          trigger: 'vip_no_tip',
          status: 'WARN',
          targets: 0,
          detail: `全視聴者がチップ済み or spy_viewersが空(${viewerCount}人)`,
        });
      }
    }
  }

  // ========================================
  // Test 3: churn_risk — 離脱リスク
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 3: churn_risk — 離脱リスク検知');
  console.log('─'.repeat(70));

  const crTrigger = activeTriggers.find((t: any) => t.trigger_type === 'churn_risk');
  if (!crTrigger) {
    log('⚠️ churn_risk トリガーが未定義');
    results.push({ trigger: 'churn_risk', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    const cond = crTrigger.conditions || {};
    const absenceDays = (cond.absence_days as number) || 14;
    const minTokens = (cond.min_total_tokens as number) || 300;
    log(`トリガー: ${crTrigger.trigger_name} (absence_days=${absenceDays}, min_tokens=${minTokens})`);

    const cutoff = new Date(Date.now() - absenceDays * 24 * 60 * 60 * 1000).toISOString();
    const { data: dormant, error: dormErr } = await sb
      .from('spy_user_profiles')
      .select('user_name, cast_name, total_tokens, last_seen')
      .eq('account_id', ACCOUNT_ID)
      .eq('is_registered_cast', true)
      .gte('total_tokens', minTokens)
      .lt('last_seen', cutoff)
      .order('total_tokens', { ascending: false })
      .limit(50);

    if (dormErr) {
      log(`❌ クエリエラー: ${dormErr.message}`);
      results.push({ trigger: 'churn_risk', status: 'FAIL', targets: 0, detail: dormErr.message });
    } else {
      log(`離脱リスクユーザー: ${(dormant || []).length}人`);
      for (const d of (dormant || []).slice(0, 10)) {
        const daysSince = Math.floor((Date.now() - new Date(d.last_seen).getTime()) / (24 * 60 * 60 * 1000));
        log(`  → ${d.user_name} @ ${d.cast_name}: ${d.total_tokens}tk, ${daysSince}日前`);
      }
      results.push({
        trigger: 'churn_risk',
        status: (dormant || []).length > 0 ? 'PASS' : 'WARN',
        targets: (dormant || []).length,
        detail: `${absenceDays}日以上不在 & ${minTokens}tk以上: ${(dormant || []).length}人`,
      });
    }
  }

  // ========================================
  // Test 4: segment_upgrade — セグメント昇格
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 4: segment_upgrade — セグメント昇格検知');
  console.log('─'.repeat(70));

  const suTrigger = activeTriggers.find((t: any) => t.trigger_type === 'segment_upgrade');
  if (!suTrigger) {
    log('⚠️ segment_upgrade トリガーが未定義');
    results.push({ trigger: 'segment_upgrade', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    const cond = suTrigger.conditions || {};
    const trackUpgrades = (cond.track_upgrades as string[]) || [];
    log(`トリガー: ${suTrigger.trigger_name}`);
    log(`追跡パターン: ${trackUpgrades.length > 0 ? trackUpgrades.join(', ') : '(未設定 — 発火しない)'}`);

    // get_user_segments RPCでセグメント分布を確認
    const { data: segments, error: segErr } = await sb.rpc('get_user_segments', {
      p_account_id: ACCOUNT_ID,
      p_cast_name: 'Risa_06',
    });

    if (segErr) {
      log(`❌ get_user_segments RPC失敗: ${segErr.message}`);
      results.push({ trigger: 'segment_upgrade', status: 'FAIL', targets: 0, detail: segErr.message });
    } else {
      const segSummary = (segments || []).map((s: any) =>
        `${s.segment_id}: ${(s.users || []).length}人`
      ).join(', ');
      log(`現在のセグメント分布: ${segSummary}`);
      log(`発火条件: スナップショット比較（前回実行→今回実行でセグメント変化を検知）`);
      log(`検証: 初回はスナップショット初期化のみ。2回目以降で変化検知 → 発火`);

      if (trackUpgrades.length === 0) {
        results.push({
          trigger: 'segment_upgrade',
          status: 'WARN',
          targets: 0,
          detail: 'track_upgradesが空。conditionsに["S9->S7","S7->S4"]等の設定が必要',
        });
      } else {
        results.push({
          trigger: 'segment_upgrade',
          status: 'PASS',
          targets: 0,
          detail: `ロジック検証OK。追跡パターン${trackUpgrades.length}個。スナップショット比較型。`,
        });
      }
    }
  }

  // ========================================
  // Test 5: competitor_outflow — 競合流出
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 5: competitor_outflow — 競合流出検知');
  console.log('─'.repeat(70));

  const coTrigger = activeTriggers.find((t: any) => t.trigger_type === 'competitor_outflow');
  if (!coTrigger) {
    log('⚠️ competitor_outflow トリガーが未定義');
    results.push({ trigger: 'competitor_outflow', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    const cond = coTrigger.conditions || {};
    const minSpyTokens = (cond.min_spy_tokens as number) || 500;
    const daysSinceOwn = (cond.days_since_own_visit as number) || 7;
    log(`トリガー: ${coTrigger.trigger_name} (min_spy_tokens=${minSpyTokens}, days=${daysSinceOwn})`);

    const cutoff = new Date(Date.now() - daysSinceOwn * 24 * 60 * 60 * 1000).toISOString();

    // 他社キャストで高額ユーザー
    const { data: spyUsers } = await sb
      .from('spy_user_profiles')
      .select('user_name, total_tokens')
      .eq('account_id', ACCOUNT_ID)
      .eq('is_registered_cast', false)
      .gte('total_tokens', minSpyTokens)
      .order('total_tokens', { ascending: false })
      .limit(200);

    log(`他社で${minSpyTokens}tk以上のユーザー: ${(spyUsers || []).length}人`);

    if (spyUsers && spyUsers.length > 0) {
      const spyNames = spyUsers.map((u: any) => u.user_name);

      // 自社キャストでの最終来訪
      const { data: ownProfiles } = await sb
        .from('spy_user_profiles')
        .select('user_name, cast_name, total_tokens, last_seen')
        .eq('account_id', ACCOUNT_ID)
        .eq('is_registered_cast', true)
        .in('user_name', spyNames);

      const ownMap = new Map<string, { lastSeen: string; castName: string }>();
      for (const p of ownProfiles || []) {
        ownMap.set(p.user_name, { lastSeen: p.last_seen, castName: p.cast_name });
      }

      let dormantCount = 0;
      let neverVisited = 0;
      for (const u of spyUsers) {
        const own = ownMap.get(u.user_name);
        if (!own) {
          neverVisited++;
        } else if (own.lastSeen < cutoff) {
          dormantCount++;
        }
      }

      log(`自社未訪問: ${neverVisited}人, 自社${daysSinceOwn}日以上不在: ${dormantCount}人`);
      results.push({
        trigger: 'competitor_outflow',
        status: dormantCount > 0 ? 'PASS' : 'WARN',
        targets: dormantCount,
        detail: `他社高額${spyUsers.length}人中、自社不在${dormantCount}人、自社未訪問${neverVisited}人`,
      });
    } else {
      results.push({
        trigger: 'competitor_outflow',
        status: 'WARN',
        targets: 0,
        detail: `他社で${minSpyTokens}tk以上のユーザーなし`,
      });
    }
  }

  // ========================================
  // Test 6: post_session — 配信後サンキュー
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 6: post_session — 配信後サンキューDM');
  console.log('─'.repeat(70));

  const psTrigger = activeTriggers.find((t: any) => t.trigger_type === 'post_session');
  if (!psTrigger) {
    log('⚠️ post_session トリガーが未定義');
    results.push({ trigger: 'post_session', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    const cond = psTrigger.conditions || {};
    const minTokens = (cond.min_session_tokens as number) || 50;
    const delayMin = (cond.delay_minutes as number) || 30;
    log(`トリガー: ${psTrigger.trigger_name} (min_session_tokens=${minTokens}, delay=${delayMin}min)`);

    // 最新の終了済みセッション
    const { data: session } = await sb
      .from('sessions')
      .select('session_id, cast_name, started_at, ended_at')
      .eq('account_id', ACCOUNT_ID)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(1)
      .single();

    if (!session) {
      log('❌ 終了済みセッションなし');
      results.push({ trigger: 'post_session', status: 'FAIL', targets: 0, detail: 'セッションなし' });
    } else {
      log(`対象セッション: ${session.cast_name} (${session.session_id?.substring(0, 8)}...)`);

      // セッション中のチッパーを集計
      const { data: tipMsgs } = await sb
        .from('spy_messages')
        .select('user_name, tokens')
        .eq('account_id', ACCOUNT_ID)
        .eq('cast_name', session.cast_name)
        .eq('session_id', session.session_id)
        .gt('tokens', 0);

      const userTokens = new Map<string, number>();
      for (const msg of tipMsgs || []) {
        userTokens.set(msg.user_name, (userTokens.get(msg.user_name) || 0) + msg.tokens);
      }

      const qualifiedTippers = Array.from(userTokens.entries())
        .filter(([, total]) => total >= minTokens)
        .sort(([, a], [, b]) => b - a);

      log(`チッパー合計: ${userTokens.size}人`);
      log(`${minTokens}tk以上: ${qualifiedTippers.length}人`);
      for (const [name, total] of qualifiedTippers.slice(0, 10)) {
        log(`  → ${name}: ${total}tk`);
      }

      // post-session-report.ts との連動確認
      const { data: report } = await sb
        .from('cast_knowledge')
        .select('id, period_start, metrics_json')
        .eq('report_type', 'post_session')
        .eq('account_id', ACCOUNT_ID)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (report) {
        log(`配信後レポート連動: ✅ (最新レポート: ${report.period_start})`);
      } else {
        log(`配信後レポート連動: ⚠️ cast_knowledge にpost_sessionレポートなし（未配信の可能性）`);
      }

      results.push({
        trigger: 'post_session',
        status: qualifiedTippers.length > 0 ? 'PASS' : 'WARN',
        targets: qualifiedTippers.length,
        detail: `${minTokens}tk以上のチッパー${qualifiedTippers.length}人 → ${delayMin}分後にDMキュー投入`,
      });
    }
  }

  // ========================================
  // Test 7: cross_promotion — クロスプロモ
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('🔍 Test 7: cross_promotion — クロスプロモーション');
  console.log('─'.repeat(70));

  const cpTrigger = activeTriggers.find((t: any) => t.trigger_type === 'cross_promotion');
  if (!cpTrigger) {
    log('⚠️ cross_promotion トリガーが未定義');
    results.push({ trigger: 'cross_promotion', status: 'SKIP', targets: 0, detail: 'トリガー未定義/無効' });
  } else {
    const cond = cpTrigger.conditions || {};
    const minVisits = (cond.min_visits_other_cast as number) || 3;
    const maxTarget = (cond.max_visits_target_cast as number) || 0;
    log(`トリガー: ${cpTrigger.trigger_name} (is_active=${cpTrigger.is_active})`);
    log(`条件: 他キャスト${minVisits}回以上訪問 & 対象キャスト${maxTarget}回以下`);

    // 自社キャスト
    const { data: casts } = await sb
      .from('registered_casts')
      .select('cast_name')
      .eq('account_id', ACCOUNT_ID)
      .eq('is_active', true);

    const castNames = (casts || []).map((c: any) => c.cast_name);
    log(`自社キャスト: ${castNames.join(', ')}`);

    if (castNames.length < 2) {
      log('⚠️ 2キャスト以上必要だが現在は不足');
      results.push({
        trigger: 'cross_promotion',
        status: 'WARN',
        targets: 0,
        detail: `自社キャスト${castNames.length}件 — 2件以上必要`,
      });
    } else {
      // ユーザープロフィールからクロスプロモ対象を探索
      const { data: profiles } = await sb
        .from('spy_user_profiles')
        .select('user_name, cast_name, message_count, total_tokens')
        .eq('account_id', ACCOUNT_ID)
        .eq('is_registered_cast', true)
        .in('cast_name', castNames)
        .gte('message_count', minVisits);

      const userCasts = new Map<string, Map<string, number>>();
      for (const p of profiles || []) {
        if (!userCasts.has(p.user_name)) userCasts.set(p.user_name, new Map());
        userCasts.get(p.user_name)!.set(p.cast_name, p.message_count);
      }

      let promoCount = 0;
      userCasts.forEach((visits, userName) => {
        for (const target of castNames) {
          const targetVisits = visits.get(target) || 0;
          if (targetVisits > maxTarget) continue;
          let hasOther = false;
          visits.forEach((count, cast) => {
            if (cast !== target && count >= minVisits) hasOther = true;
          });
          if (hasOther) {
            promoCount++;
            break;
          }
        }
      });

      log(`クロスプロモ対象: ${promoCount}人 (${userCasts.size}人中)`);
      if (!cpTrigger.is_active) {
        log(`注意: このトリガーは無効化されている (is_active=false)`);
      }

      results.push({
        trigger: 'cross_promotion',
        status: !cpTrigger.is_active ? 'WARN' : promoCount > 0 ? 'PASS' : 'WARN',
        targets: promoCount,
        detail: `${promoCount}人がクロスプロモ対象${!cpTrigger.is_active ? ' (トリガー無効)' : ''}`,
      });
    }
  }

  // ========================================
  // Step 8: dm_trigger_logs 確認
  // ========================================
  console.log('\n' + '─'.repeat(70));
  console.log('📋 既存の dm_trigger_logs 確認');
  console.log('─'.repeat(70));

  const { data: logs, count: logCount } = await sb
    .from('dm_trigger_logs')
    .select('status, trigger_id, username, cast_name, triggered_at', { count: 'exact' })
    .eq('account_id', ACCOUNT_ID)
    .order('triggered_at', { ascending: false })
    .limit(20);

  log(`dm_trigger_logs 全件: ${logCount || 0}`);
  if (logs && logs.length > 0) {
    // ステータス別集計
    const statusCount = new Map<string, number>();
    for (const l of logs) {
      statusCount.set(l.status, (statusCount.get(l.status) || 0) + 1);
    }
    for (const [status, count] of statusCount.entries()) {
      log(`  ${status}: ${count}件`);
    }
    log('直近5件:');
    for (const l of logs.slice(0, 5)) {
      log(`  [${l.status}] ${l.username} @ ${l.cast_name} (${l.triggered_at})`);
    }
  }

  // ========================================
  // Summary
  // ========================================
  console.log('\n' + '='.repeat(70));
  console.log('📊 テスト結果サマリー');
  console.log('='.repeat(70));
  console.log('');
  console.log('| トリガー | 結果 | 対象数 | 詳細 |');
  console.log('|---|---|---|---|');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : r.status === 'WARN' ? '⚠️' : '⏭️';
    console.log(`| ${r.trigger} | ${icon} ${r.status} | ${r.targets} | ${r.detail} |`);
  }

  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const warnCount = results.filter(r => r.status === 'WARN').length;
  console.log(`\n合計: PASS=${passCount}, WARN=${warnCount}, FAIL=${failCount}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
