/**
 * refresh-cookies.ts — Playwright headlessでセッションcookieをリフレッシュ
 *
 * ss_cookies.json のセッションcookie (isLogged, sessionId) を使って
 * headlessブラウザでStripchatにアクセスし、新しい__cf_bmを取得。
 * 有効であればstate.jsonに保存してcoin-syncから使えるようにする。
 *
 * Usage: npx tsx src/refresh-cookies.ts
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { getSupabase } from './config.js';
import { STATE_FILE } from './coin-auth.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SS_COOKIES_JSON_FILE = path.join(__dirname, '..', '..', 'ss_cookies.json');
const COOKIE_HEADER_FILE = path.join(__dirname, '..', '..', 'cookie_header.txt');
const USER_ID = '186865131'; // hanshakun

async function main() {
  console.log('=== Cookie リフレッシュ ===\n');

  // ss_cookies.json からセッションcookie読み込み
  let cookies: Record<string, string> = {};

  if (fs.existsSync(SS_COOKIES_JSON_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SS_COOKIES_JSON_FILE, 'utf-8'));
    cookies = Array.isArray(raw)
      ? raw[0]?.cookies_json || raw[0]?.cookies || {}
      : raw.cookies_json || raw.cookies || {};
    console.log(`ss_cookies.json: ${Object.keys(cookies).length}個のcookie`);
  } else if (fs.existsSync(COOKIE_HEADER_FILE)) {
    const headerStr = fs.readFileSync(COOKIE_HEADER_FILE, 'utf-8').trim();
    for (const pair of headerStr.split('; ')) {
      const idx = pair.indexOf('=');
      if (idx > 0) cookies[pair.substring(0, idx)] = pair.substring(idx + 1);
    }
    console.log(`cookie_header.txt: ${Object.keys(cookies).length}個のcookie`);
  } else {
    console.error('cookie元ファイルが見つかりません (ss_cookies.json / cookie_header.txt)');
    process.exit(1);
  }

  if (!cookies['isLogged'] && !cookies['stripchat_com_sessionId']) {
    console.error('セッションcookieなし — ログインが必要');
    process.exit(1);
  }

  // Playwright headless でcookieをセットしてアクセス
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  });

  // セッション系cookieをセット（__cf_bm等は除外 — Cloudflareが新規発行する）
  const cookiesToSet = Object.entries(cookies)
    .filter(([name]) => !name.startsWith('__cf') && name !== '_ga' && !name.startsWith('_ga_'))
    .map(([name, value]) => ({ name, value, domain: '.stripchat.com', path: '/' }));
  await context.addCookies(cookiesToSet);
  console.log(`${cookiesToSet.length}個のcookieをブラウザにセット`);

  const page = await context.newPage();

  // Stripchatにアクセスして新しいCloudflare cookieを取得
  try {
    const resp = await page.goto('https://stripchat.com/api/front/v2/config', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
    console.log(`Config API: ${resp?.status()}`);
  } catch (e) {
    console.log(`Navigation: ${(e as Error).message.substring(0, 100)}`);
  }

  // 更新されたcookieを取得
  const allCookies = await context.cookies('https://stripchat.com');
  console.log(`取得cookie数: ${allCookies.length}`);

  const cfBm = allCookies.find(c => c.name === '__cf_bm');
  console.log(`__cf_bm: ${cfBm ? '新規取得' : '未取得'}`);

  // userId解決
  let userId = USER_ID;
  const uidCookie = allCookies.find(c => c.name === 'stripchat_com_userId');
  if (uidCookie?.value) {
    userId = uidCookie.value;
    console.log(`userId (cookie): ${userId}`);
  } else {
    // registered_castsから取得
    const sb = getSupabase();
    const { data } = await sb.from('registered_casts')
      .select('stripchat_user_id')
      .eq('is_active', true)
      .limit(1);
    if (data?.[0]?.stripchat_user_id) {
      userId = String(data[0].stripchat_user_id);
    }
    console.log(`userId (fallback): ${userId}`);
  }

  // Earnings APIテスト
  const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log('\nEarnings APIテスト...');

  const r = await fetch(`https://stripchat.com/api/front/users/${userId}/transactions?page=1&limit=1`, {
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  console.log(`Earnings API: ${r.status}`);

  if (r.ok) {
    const d = await r.json() as { transactions?: unknown[] };
    console.log(`成功! ${(d.transactions || []).length}件取得`);

    // state.jsonに保存
    const authDir = path.dirname(STATE_FILE);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    const stateData = {
      cookies: allCookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
      userId,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateData, null, 2));
    console.log(`保存: ${STATE_FILE}`);

    // Supabase更新
    const sb = getSupabase();
    const { data: accounts } = await sb.from('registered_casts')
      .select('account_id')
      .eq('is_active', true)
      .limit(1);
    if (accounts?.[0]) {
      const cookiesJson: Record<string, string> = {};
      for (const c of allCookies) cookiesJson[c.name] = c.value;
      await sb.from('stripchat_sessions').upsert({
        account_id: accounts[0].account_id,
        cookies_json: cookiesJson,
        stripchat_user_id: userId,
        is_valid: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'account_id' });
      console.log('Supabase stripchat_sessions 更新完了');
    }

    console.log('\n=== リフレッシュ成功 — coin-syncが使えるようになりました ===');
  } else {
    const body = await r.text();
    console.log(`失敗: ${body.substring(0, 200)}`);
    console.log('\nセッションcookieが完全に期限切れです。');
    console.log('以下のいずれかを実行してください:');
    console.log('  1. npm run coin-auth  (ブラウザでログイン)');
    console.log('  2. npm run coin-import (DevToolsからcookie貼り付け)');
  }

  await browser.close();
}

main().catch(e => {
  console.error('エラー:', e);
  process.exit(1);
});
