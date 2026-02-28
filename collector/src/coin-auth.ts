/**
 * coin-auth.ts — Stripchat認証セッション取得ツール
 *
 * Playwright（表示モード）でStripchatログインページを開き、
 * ユーザーが手動でログイン → 認証cookieを自動キャプチャ。
 *
 * 保存先:
 *   1. collector/.auth/stripchat-state.json（Playwright storageState）
 *   2. Supabase stripchat_sessions テーブル
 *
 * 使い方:
 *   npm run coin-auth
 *   → ブラウザが開く → Stripchatにログイン → 自動でcookie保存 → ブラウザ閉じる
 *
 * 以降の coin-sync は保存済みセッションを自動読み込み。
 */

import { getSupabase } from './config.js';
import { createLogger } from './utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const log = createLogger('coin-auth');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '..', '.auth');
export const STATE_FILE = path.join(AUTH_DIR, 'stripchat-state.json');

/**
 * 保存済みセッション（storageState）からcookieヘッダーとuserIdを取得
 * coin-sync から呼ばれる
 */
export function loadSavedSession(): { cookieHeader: string; userId: string } | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const cookies: Array<{ name: string; value: string; domain: string }> = state.cookies || [];

    // stripchat.com ドメインのcookieのみ
    const scCookies = cookies.filter(c => c.domain.includes('stripchat'));
    if (scCookies.length === 0) return null;

    const userIdCookie = scCookies.find(c => c.name === 'stripchat_com_userId');
    const isLoggedCookie = scCookies.find(c => c.name === 'isLogged');
    const sessionIdCookie = scCookies.find(c => c.name === 'stripchat_com_sessionId');

    // userId取得: Cookie → 保存済みファイルのメタデータ
    let userId = userIdCookie?.value;

    if (!userId) {
      // isLogged=1 + sessionId があれば認証済みセッション（Stripchat API仕様変更対応）
      if (isLoggedCookie?.value === '1' && sessionIdCookie?.value) {
        // state.jsonにuserId保存されていればそちらから取得
        if (state.userId) {
          userId = String(state.userId);
        }
        if (!userId) {
          log.warn('保存済みセッションにuserIdなし（isLogged=1だが stripchat_com_userId Cookie なし）');
          return null;
        }
      } else {
        log.warn('保存済みセッションにstripchat_com_userIdなし — ゲストセッション');
        return null;
      }
    }

    const cookieHeader = scCookies.map(c => `${c.name}=${c.value}`).join('; ');
    return { cookieHeader, userId };
  } catch (err) {
    log.warn('保存済みセッション読み込み失敗', err);
    return null;
  }
}

/**
 * 対話的にStripchatにログインしてセッションを保存
 */
async function main() {
  console.log('=== Stripchat認証セッション取得 ===\n');
  console.log('ブラウザが開きます。Stripchatにログインしてください。');
  console.log('ログイン完了後、自動的にcookieが保存されます。\n');

  let chromium: typeof import('playwright').chromium;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    console.error('Playwright未インストール。実行: npm install playwright && npx playwright install chromium');
    process.exit(1);
  }

  // .auth ディレクトリ作成
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  // 既存のセッションがあれば読み込んで再利用
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
  };

  // 保存済みストレージがあればコンテキストに適用
  if (fs.existsSync(STATE_FILE)) {
    console.log('既存の保存済みセッションを検出 → 再利用を試行\n');
    (launchOptions as Record<string, unknown>).storageState = STATE_FILE;
  }

  const userDataDir = path.join(AUTH_DIR, 'browser-data');
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

  const page = context.pages()[0] || await context.newPage();

  // earningsページに直接アクセス（ログイン済みならそのまま表示される）
  console.log('Stripchat earningsページにアクセス中...');
  await page.goto('https://stripchat.com/earnings/tokens-history', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // 年齢確認突破
  try {
    for (const sel of [
      'button:has-text("18")',
      'button:has-text("I am 18")',
      'button:has-text("Enter")',
    ]) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(2000);
        break;
      }
    }
  } catch { /* no gate */ }

  // ログイン完了を待つ（stripchat_com_userId cookieが出現するまで）
  console.log('\nログインを待っています...');
  console.log('（ログインページが表示されたら、メールアドレスとパスワードでログインしてください）\n');

  const MAX_WAIT_MS = 5 * 60 * 1000; // 最大5分
  const startTime = Date.now();
  let authenticated = false;

  while (Date.now() - startTime < MAX_WAIT_MS) {
    const cookies = await context.cookies('https://stripchat.com');
    const userIdCookie = cookies.find(c => c.name === 'stripchat_com_userId');
    if (userIdCookie && userIdCookie.value) {
      console.log(`\n✓ ログイン検出! userId=${userIdCookie.value}`);
      authenticated = true;
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!authenticated) {
    console.error('\n✗ タイムアウト — 5分以内にログインしてください');
    await context.close();
    process.exit(1);
  }

  // セッション保存
  console.log('セッションを保存中...');
  await context.storageState({ path: STATE_FILE });

  // cookiesをSupabaseにも保存
  const cookies = await context.cookies('https://stripchat.com');
  const cookiesJson: Record<string, string> = {};
  for (const c of cookies) {
    cookiesJson[c.name] = c.value;
  }

  const userId = cookiesJson['stripchat_com_userId'];
  const cookieHeader = Object.entries(cookiesJson).map(([k, v]) => `${k}=${v}`).join('; ');

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
      stripchat_user_id: userId,
      is_valid: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });
    console.log(`✓ Supabase stripchat_sessions 更新完了 (userId=${userId})`);
  }

  // Earnings API疎通テスト
  console.log('\nEarnings API疎通テスト...');
  try {
    const resp = await fetch(`https://stripchat.com/api/front/users/${userId}/transactions?page=1&limit=1`, {
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
      console.warn(`✗ Earnings API: ${resp.status}`);
    }
  } catch (err) {
    console.warn(`✗ Earnings API接続エラー:`, err);
  }

  console.log('\n=== 認証セッション保存完了 ===');
  console.log(`保存先: ${STATE_FILE}`);
  console.log('次回のcoin-syncから自動的にこのセッションが使用されます。\n');

  await context.close();
}

// 直接実行時のみmain()を起動（import時はスキップ）
const isDirectRun = process.argv[1]?.includes('coin-auth');
if (isDirectRun) {
  main().catch(err => {
    console.error('エラー:', err);
    process.exit(1);
  });
}
