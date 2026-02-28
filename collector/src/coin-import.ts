/**
 * coin-import.ts — DevToolsからのcookie直接インポート
 *
 * ChromeでStripchatにモデルとしてログインし、
 * DevToolsコンソールで document.cookie をコピーして貼り付けるだけ。
 *
 * 使い方:
 *   1. ChromeでStripchatにモデルのアカウントでログイン
 *   2. F12 → Console → document.cookie を実行 → 結果をコピー
 *   3. npm run coin-import
 *   4. プロンプトにcookie文字列を貼り付けてEnter
 *
 * または引数で直接渡す:
 *   npm run coin-import -- "cookie文字列"
 */

import { getSupabase } from './config.js';
import { createLogger } from './utils/logger.js';
import { STATE_FILE } from './coin-auth.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const log = createLogger('coin-import');
const AUTH_DIR = path.dirname(STATE_FILE);

async function main() {
  console.log('=== Stripchat Cookie インポート ===\n');

  let cookieString = process.argv[2];

  if (!cookieString) {
    console.log('手順:');
    console.log('  1. ChromeでStripchatにモデルのアカウントでログイン');
    console.log('  2. F12 → Console → document.cookie を実行');
    console.log('  3. 出力された文字列をコピー');
    console.log('  4. 以下のプロンプトに貼り付けてEnter\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    cookieString = await new Promise<string>((resolve) => {
      rl.question('Cookie文字列を貼り付け: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!cookieString) {
    console.error('Cookie文字列が空です');
    process.exit(1);
  }

  // Cookie文字列をパース
  const cookiesJson: Record<string, string> = {};
  for (const pair of cookieString.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const name = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      cookiesJson[name] = value;
    }
  }

  console.log(`\n${Object.keys(cookiesJson).length}個のcookieを検出`);

  // 認証チェック
  const userId = cookiesJson['stripchat_com_userId'];
  const isLogged = cookiesJson['isLogged'];
  const sessionId = cookiesJson['stripchat_com_sessionId'];

  console.log(`  stripchat_com_userId: ${userId || 'なし'}`);
  console.log(`  isLogged: ${isLogged || 'なし'}`);
  console.log(`  sessionId: ${sessionId ? sessionId.substring(0, 20) + '...' : 'なし'}`);

  const isAuthenticated = !!userId || (isLogged === '1' && !!sessionId);
  if (!isAuthenticated) {
    console.error('\n✗ 認証cookieが見つかりません。モデルのアカウントでログインしてください。');
    process.exit(1);
  }

  // userId解決
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    // registered_castsから取得
    const sb = getSupabase();
    const { data: casts } = await sb
      .from('registered_casts')
      .select('stripchat_user_id, stripchat_model_id, cast_name')
      .eq('is_active', true)
      .limit(1);
    const fallbackId = casts?.[0]?.stripchat_user_id || casts?.[0]?.stripchat_model_id;
    if (fallbackId) {
      resolvedUserId = String(fallbackId);
      console.log(`  registered_castsからuserId解決: ${resolvedUserId} (${casts?.[0]?.cast_name})`);
    }
  }

  if (!resolvedUserId) {
    console.error('\n✗ userIdを解決できません');
    process.exit(1);
  }

  // Earnings API疎通テスト
  const cookieHeader = Object.entries(cookiesJson).map(([k, v]) => `${k}=${v}`).join('; ');
  console.log('\nEarnings API疎通テスト...');
  try {
    const resp = await fetch(`https://stripchat.com/api/front/users/${resolvedUserId}/transactions?page=1&limit=1`, {
      headers: {
        Cookie: cookieHeader,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    if (resp.ok) {
      const data = await resp.json() as { transactions?: unknown[] };
      console.log(`✓ Earnings API: ${resp.status} OK (${(data.transactions || []).length}件取得)`);
    } else {
      console.warn(`✗ Earnings API: ${resp.status} — このcookieではEarnings APIにアクセスできません`);
      console.warn('  モデル本人のアカウントでログインしているか確認してください');
      process.exit(1);
    }
  } catch (err) {
    console.warn('✗ Earnings API接続エラー:', err);
    process.exit(1);
  }

  // state.json保存
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  const stateData = {
    cookies: Object.entries(cookiesJson).map(([name, value]) => ({
      name,
      value,
      domain: '.stripchat.com',
      path: '/',
    })),
    userId: resolvedUserId,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
  console.log(`✓ ${STATE_FILE} に保存`);

  // Supabase更新
  const sb = getSupabase();
  const { data: accounts } = await sb
    .from('registered_casts')
    .select('account_id')
    .eq('is_active', true)
    .limit(1);

  if (accounts && accounts.length > 0) {
    const accountId = accounts[0].account_id;
    await sb.from('stripchat_sessions').upsert({
      account_id: accountId,
      cookies_json: cookiesJson,
      stripchat_user_id: resolvedUserId,
      is_valid: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });
    console.log(`✓ Supabase stripchat_sessions 更新完了`);
  }

  console.log('\n=== インポート完了 ===');
  console.log('次回のcoin-syncから自動的にこのセッションが使用されます。');
  console.log('Collectorを再起動してください: npm start');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
