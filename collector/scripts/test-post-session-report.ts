/**
 * テストスクリプト: 配信後レポート生成
 *
 * Usage: npx tsx scripts/test-post-session-report.ts
 */
import 'dotenv/config';
import { generatePostSessionReport } from '../src/reports/post-session-report.js';
import { getSupabase } from '../src/config.js';

const ACCOUNT_ID = '940e7248-1d73-4259-a538-56fdaea9d740';
const CAST_NAME = 'Risa_06';

async function main() {
  const sb = getSupabase();

  // 最新のセッションを取得
  const { data: session, error } = await sb
    .from('sessions')
    .select('session_id, started_at, ended_at, total_messages, total_tokens')
    .eq('account_id', ACCOUNT_ID)
    .eq('cast_name', CAST_NAME)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !session) {
    console.error('セッション取得失敗:', error?.message);
    process.exit(1);
  }

  console.log(`テスト対象セッション: ${session.session_id}`);
  console.log(`  期間: ${session.started_at} → ${session.ended_at}`);
  console.log(`  メッセージ: ${session.total_messages}, チップ: ${session.total_tokens}tk`);

  // レポート生成
  await generatePostSessionReport(
    ACCOUNT_ID,
    CAST_NAME,
    session.session_id,
    session.started_at,
  );

  // 結果確認
  const { data: report } = await sb
    .from('cast_knowledge')
    .select('*')
    .eq('account_id', ACCOUNT_ID)
    .eq('report_type', 'post_session')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (report) {
    console.log('\n✅ レポート生成成功:');
    console.log(JSON.stringify(report.metrics_json, null, 2));
  } else {
    console.log('\n❌ レポートがcast_knowledgeに見つかりません');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
