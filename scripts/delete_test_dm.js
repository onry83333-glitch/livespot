// テストDMデータ削除スクリプト
// 対象: campaign が bulk_*, pipe3_bulk_*, 20250217_test_* のレコード
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const env = fs.readFileSync('frontend/.env.local', 'utf8');
const url = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)[1].trim();
const skey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)[1].trim();
const sb = createClient(url, skey);

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

async function main() {
  if (!DRY_RUN && !EXECUTE) {
    console.log('Usage: node scripts/delete_test_dm.js --dry-run   (カウントのみ)');
    console.log('       node scripts/delete_test_dm.js --execute   (実際に削除)');
    process.exit(1);
  }

  console.log(`モード: ${DRY_RUN ? 'DRY-RUN（カウントのみ）' : '⚠️ 実行（削除します）'}\n`);

  // パターン別カウント
  const patterns = [
    { label: 'bulk_%', filter: 'bulk_%' },
    { label: 'pipe3_bulk_%', filter: 'pipe3_bulk_%' },
    { label: '20250217_test_%', filter: '20250217_test_%' },
  ];

  let totalCount = 0;

  for (const p of patterns) {
    const { count, error } = await sb
      .from('dm_send_log')
      .select('*', { count: 'exact', head: true })
      .like('campaign', p.filter);

    if (error) {
      console.error(`カウントエラー (${p.label}):`, error.message);
      continue;
    }
    console.log(`  ${p.label}: ${count} 件`);
    totalCount += count;
  }

  // pipe3_bulk_ は bulk_ に含まれるので重複分を確認
  const { count: overlapCount } = await sb
    .from('dm_send_log')
    .select('*', { count: 'exact', head: true })
    .like('campaign', 'pipe3_bulk_%');

  console.log(`\n合計: ${totalCount} 件 (bulk_ に pipe3_bulk_ ${overlapCount}件 を含む)`);
  console.log(`実削除対象: ${totalCount - overlapCount} 件 (重複除外)\n`);

  // campaign値のサンプル表示
  const { data: samples } = await sb
    .from('dm_send_log')
    .select('campaign, status, created_at')
    .or('campaign.like.bulk_%,campaign.like.20250217_test_%')
    .order('created_at', { ascending: false })
    .limit(10);

  if (samples && samples.length > 0) {
    console.log('サンプル (直近10件):');
    for (const s of samples) {
      console.log(`  campaign=${s.campaign}  status=${s.status}  created=${s.created_at}`);
    }
    console.log();
  }

  if (EXECUTE) {
    console.log('削除を実行します...\n');

    // パターン1: bulk_% (pipe3_bulk_% も含む)
    const { error: err1, count: del1 } = await sb
      .from('dm_send_log')
      .delete({ count: 'exact' })
      .like('campaign', 'bulk_%');

    if (err1) {
      console.error('削除エラー (bulk_%):',  err1.message);
    } else {
      console.log(`  bulk_% 削除完了: ${del1} 件`);
    }

    // パターン2: 20250217_test_%
    const { error: err2, count: del2 } = await sb
      .from('dm_send_log')
      .delete({ count: 'exact' })
      .like('campaign', '20250217_test_%');

    if (err2) {
      console.error('削除エラー (20250217_test_%):',  err2.message);
    } else {
      console.log(`  20250217_test_% 削除完了: ${del2} 件`);
    }

    const totalDel = (del1 || 0) + (del2 || 0);
    console.log(`\n✅ 合計 ${totalDel} 件削除完了`);

    // 削除後の残件数確認
    const { count: remaining } = await sb
      .from('dm_send_log')
      .select('*', { count: 'exact', head: true });
    console.log(`dm_send_log 残件数: ${remaining} 件`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
