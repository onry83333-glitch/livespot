/**
 * coin-backfill.ts — 指定期間のコイントランザクションを遡及取得
 *
 * 用途: coin-sync停止などによるデータ欠損を復旧する
 *
 * 使い方:
 *   npx tsx src/coin-backfill.ts --from 2026-03-02T15:00:00Z --to 2026-03-03T15:00:00Z
 *   npx tsx src/coin-backfill.ts --from 2026-03-02T15:00:00Z --to 2026-03-03T15:00:00Z --dry-run
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EARNINGS_API = 'https://stripchat.com/api/front/users';
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // 最大10,000件（通常の20ページより多く遡る）
const REQUEST_DELAY_MS = 600;
const BATCH_SIZE = 500;

interface Transaction {
  id?: number;
  userName?: string;
  user_name?: string;
  username?: string;
  userId?: number;
  tokens?: number;
  amount?: number;
  type?: string;
  source?: string;
  date?: string;
  createdAt?: string;
  created_at?: string;
  description?: string;
  sourceDetail?: string;
  isAnonymous?: boolean | number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(): { from: string; to: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let from = '', to = '', dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) from = args[++i];
    else if (args[i] === '--to' && args[i + 1]) to = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
  }
  if (!from || !to) {
    console.error('Usage: npx tsx src/coin-backfill.ts --from <ISO8601> --to <ISO8601> [--dry-run]');
    process.exit(1);
  }
  return { from, to, dryRun };
}

async function main() {
  const { from, to, dryRun } = parseArgs();
  const fromDate = new Date(from);
  const toDate = new Date(to);

  console.log(`=== コイン バックフィル ===`);
  console.log(`期間: ${fromDate.toISOString()} ~ ${toDate.toISOString()}`);
  console.log(`モード: ${dryRun ? 'DRY RUN（書き込みなし）' : '本番'}`);

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // 1. Cookie取得
  const accountId = '940e7248-1d73-4259-a538-56fdaea9d740';
  const { data: sess } = await sb.from('stripchat_sessions')
    .select('cookies_json')
    .eq('account_id', accountId)
    .limit(1);

  if (!sess?.[0]?.cookies_json) {
    console.error('有効なcookieが見つかりません');
    process.exit(1);
  }

  const cookieHeader = Object.entries(sess[0].cookies_json)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  // 2. キャスト情報取得
  const { data: casts } = await sb.from('registered_casts')
    .select('cast_name, stripchat_user_id')
    .eq('account_id', accountId)
    .eq('is_active', true);

  if (!casts || casts.length === 0) {
    console.error('アクティブなキャストが見つかりません');
    process.exit(1);
  }

  // 3. userId解決（AMP cookie → registered_casts フォールバック）
  let userId = '';
  const ampCookie = sess[0].cookies_json['AMP_19a23394ad'];
  if (ampCookie) {
    try {
      let decoded = Buffer.from(ampCookie, 'base64').toString('utf-8');
      if (decoded.includes('%7B') || decoded.includes('%22')) decoded = decodeURIComponent(decoded);
      const json = JSON.parse(decoded);
      if (json.userId) userId = String(json.userId);
    } catch { /* ignore */ }
  }
  if (!userId) {
    userId = String(casts[0].stripchat_user_id);
  }
  console.log(`\nAPI userId: ${userId}`);

  // 4. Stripchat APIからトランザクション取得（offset-basedページネーション）
  const allTx: Transaction[] = [];
  let offset = 0;
  let reachedBefore = false;
  let fetchCount = 0;
  const MAX_ITEMS = PAGE_SIZE * MAX_PAGES; // 安全上限

  while (offset < MAX_ITEMS && !reachedBefore) {
    const url = `${EARNINGS_API}/${userId}/transactions?offset=${offset}&limit=${PAGE_SIZE}`;
    const resp = await fetch(url, {
      headers: {
        Cookie: cookieHeader,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      console.error(`認証エラー ${resp.status} — cookieが期限切れ`);
      process.exit(1);
    }
    if (resp.status === 429) {
      console.log('レート制限 — 10秒待機');
      await sleep(10000);
      continue;
    }
    if (!resp.ok) {
      console.error(`API ${resp.status} offset=${offset}`);
      break;
    }

    const data = (await resp.json()) as { transactions?: Transaction[]; items?: Transaction[] };
    const items = data.transactions || data.items || [];
    if (items.length === 0) break;
    fetchCount += items.length;

    for (const tx of items) {
      const txDate = new Date(tx.date || tx.createdAt || tx.created_at || '');
      if (isNaN(txDate.getTime())) continue;

      if (txDate < fromDate) {
        reachedBefore = true;
        break;
      }
      if (txDate >= fromDate && txDate < toDate) {
        allTx.push(tx);
      }
      // txDate >= toDate → まだ対象期間に到達していない、次のオフセットへ
    }

    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    if (offset % (PAGE_SIZE * 10) === 0) {
      const lastItem = items[items.length - 1];
      const lastDate = lastItem?.date || lastItem?.createdAt || '';
      console.log(`  offset ${offset}: 最古 ${lastDate} (対象期間 ${allTx.length}件)`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\n取得結果: ${allTx.length}件 (${fetchCount}件スキャン, offset=${offset})`);

  if (allTx.length === 0) {
    console.log('対象期間のトランザクションはありません');
    process.exit(0);
  }

  // 5. タイプ別集計表示
  const typeCount: Record<string, { count: number; tokens: number }> = {};
  for (const tx of allTx) {
    const t = tx.type || tx.source || 'unknown';
    if (!typeCount[t]) typeCount[t] = { count: 0, tokens: 0 };
    typeCount[t].count++;
    typeCount[t].tokens += Math.abs(tx.tokens || tx.amount || 0);
  }
  console.log('\nタイプ別集計:');
  for (const [type, stats] of Object.entries(typeCount).sort((a, b) => b[1].tokens - a[1].tokens)) {
    console.log(`  ${type}: ${stats.count}件 / ${stats.tokens}tk`);
  }

  // 6. キャスト名マッピング（registered_castsから）
  const castNames = casts.map(c => c.cast_name);
  // APIの各トランザクションにはcast_nameがない。
  // coin-syncではキャストごとにAPIを叩くのでcast_nameを決定できるが、
  // バックフィルでは全体を1回で取るため、既存のcoin_transactionsのcast_name割当ロジックを流用。
  // → 2キャスト以上の場合、全キャストに同じデータをINSERTし、既存レコードとの重複で自動スキップ

  if (dryRun) {
    console.log('\n=== DRY RUN — 書き込みをスキップ ===');
    process.exit(0);
  }

  // 7. coin_transactionsにUPSERT
  const now = new Date().toISOString();
  let insertedTotal = 0;
  let skippedTotal = 0;

  for (const castName of castNames) {
    const rows: Record<string, unknown>[] = [];
    for (const tx of allTx) {
      const userName = tx.userName || tx.user_name || tx.username || '';
      const tokens = parseInt(String(tx.tokens || tx.amount || 0), 10);
      const txType = tx.type || tx.source || 'unknown';
      const txDate = tx.date || tx.createdAt || tx.created_at || now;

      // 負数トークン（modelRefund等）はスキップ
      if (!userName || tokens <= 0) continue;

      rows.push({
        account_id: accountId,
        cast_name: castName,
        stripchat_tx_id: tx.id ? String(tx.id) : null,
        user_name: userName,
        user_id: tx.userId ? String(tx.userId) : null,
        tokens,
        type: txType,
        date: txDate,
        source_detail: tx.description || tx.sourceDetail || '',
        is_anonymous: tx.isAnonymous === true || tx.isAnonymous === 1,
        synced_at: now,
      });
    }

    console.log(`\n[${castName}] UPSERT ${rows.length}件...`);

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error, count } = await sb
        .from('coin_transactions')
        .upsert(batch, {
          onConflict: 'account_id,stripchat_tx_id',
          ignoreDuplicates: true,
          count: 'exact',
        });

      if (error) {
        // stripchat_tx_idがnullの場合、dedup indexにフォールバック
        // 個別INSERTで重複を無視
        let fallbackInserted = 0;
        for (const row of batch) {
          const { error: singleErr } = await sb
            .from('coin_transactions')
            .upsert([row], {
              onConflict: 'account_id,stripchat_tx_id',
              ignoreDuplicates: true,
            });
          if (!singleErr) fallbackInserted++;
        }
        console.log(`  バッチエラー → 個別INSERT: ${fallbackInserted}/${batch.length}件`);
        insertedTotal += fallbackInserted;
      } else {
        insertedTotal += batch.length;
        console.log(`  ${batch.length}件 UPSERT完了`);
      }
    }
  }

  console.log(`\n合計: ${insertedTotal}件 UPSERT完了`);

  // 8. refresh_paying_users + refresh_segments
  console.log('\nMV + セグメント更新中...');
  try {
    await sb.rpc('refresh_paying_users');
    console.log('refresh_paying_users 完了');
  } catch (e) {
    console.error('refresh_paying_users エラー:', e);
  }

  for (const castName of castNames) {
    try {
      await sb.rpc('refresh_segments', { p_account_id: accountId, p_cast_name: castName });
      console.log(`refresh_segments(${castName}) 完了`);
    } catch (e) {
      console.error(`refresh_segments(${castName}) エラー:`, e);
    }
  }

  // 9. 復旧確認
  const { count: gapCount } = await sb.from('coin_transactions')
    .select('*', { count: 'exact', head: true })
    .gte('date', from)
    .lt('date', to);
  console.log(`\n検証: 対象期間のトランザクション数 = ${gapCount}件`);

  console.log('\n=== バックフィル完了 ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
