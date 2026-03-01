/**
 * SLS全ページスクリーンショット撮影スクリプト
 * Usage: npx playwright test --config=screenshots/playwright.config.ts
 *   or:  npx tsx screenshots/capture-all.ts
 */

import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

const BASE_URL = process.env.SLS_BASE_URL || 'http://localhost:3001';
const OUT_DIR = path.resolve(__dirname);
const LOGIN_EMAIL = 'admin@livespot.jp';
const LOGIN_PASSWORD = process.env.SLS_LOGIN_PASSWORD || 'livespot2024';

// ページ定義
const PAGES: { name: string; path: string; waitFor?: string; actions?: string[] }[] = [
  { name: '01_login', path: '/login' },
  { name: '02_casts_dashboard', path: '/casts' },
  { name: '03_cast_risa06_overview', path: '/casts/Risa_06' },
  { name: '04_cast_risa06_segment', path: '/casts/Risa_06', actions: ['click-tab:セグメント'] },
  { name: '05_cast_risa06_dm', path: '/casts/Risa_06', actions: ['click-tab:DM'] },
  { name: '06_cast_risa06_dm_segment', path: '/casts/Risa_06', actions: ['click-tab:DM', 'click-subtab:🎯 セグメント別'] },
  { name: '07_cast_risa06_spy', path: '/casts/Risa_06', actions: ['click-tab:SPY'] },
  { name: '08_cast_risa06_sessions', path: '/casts/Risa_06', actions: ['click-tab:セッション'] },
  { name: '09_cast_risa06_pl', path: '/casts/Risa_06', actions: ['click-tab:P/L'] },
  { name: '10_cast_risa06_competitive', path: '/casts/Risa_06', actions: ['click-tab:競合分析'] },
  { name: '11_spy', path: '/spy' },
  { name: '12_reports', path: '/reports' },
  { name: '13_admin_health', path: '/admin/health' },
  { name: '14_alerts', path: '/alerts' },
  { name: '15_feed', path: '/feed' },
];

async function main() {
  console.log('=== SLS Screenshot Capture ===');
  console.log(`Output: ${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'ja-JP',
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  // 1. ログイン画面スクリーンショット（ログイン前）
  console.log('Capturing: 01_login');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT_DIR, '01_login.png'), fullPage: true });
  console.log('  ✓ 01_login.png');

  // 2. ログイン実行
  console.log('Logging in...');
  try {
    await page.fill('input[type="email"]', LOGIN_EMAIL);
    await page.fill('input[type="password"]', LOGIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/casts**', { timeout: 15000 });
    console.log('  ✓ Logged in successfully');
  } catch (err) {
    console.error('  ✗ Login failed, trying direct Supabase auth...');
    // Supabase直接ログイン
    const supabaseUrl = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
    const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5NjQ5NzcsImV4cCI6MjA4NjU0MDk3N30._vllLuXCU34JMbh0HTM6vIlglGRBX2oP7KBz_5XfKeo';

    const authRes = await page.evaluate(async ({ url, key, email, password }: { url: string; key: string; email: string; password: string }) => {
      const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
      return res.json();
    }, { url: supabaseUrl, key: anonKey, email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    if (authRes.access_token) {
      // Set Supabase session in localStorage
      await page.evaluate((session: Record<string, unknown>) => {
        localStorage.setItem('sb-ujgbhkllfeacbgpdbjto-auth-token', JSON.stringify(session));
      }, authRes);
      await page.goto(`${BASE_URL}/casts`, { waitUntil: 'networkidle' });
      console.log('  ✓ Logged in via Supabase API');
    } else {
      console.error('  ✗ Supabase auth also failed:', authRes);
    }
  }
  await page.waitForTimeout(2000);

  // 3. 各ページのスクリーンショット
  for (const pg of PAGES) {
    if (pg.name === '01_login') continue; // already captured

    console.log(`Capturing: ${pg.name}`);
    try {
      await page.goto(`${BASE_URL}${pg.path}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      // タブクリックアクション
      if (pg.actions) {
        for (const action of pg.actions) {
          if (action.startsWith('click-tab:')) {
            const tabName = action.replace('click-tab:', '');
            // タブボタンをテキストで検索
            const tabBtn = page.locator(`button, [role="tab"]`).filter({ hasText: tabName }).first();
            if (await tabBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await tabBtn.click();
              await page.waitForTimeout(2000);
            } else {
              console.log(`    ⚠ Tab "${tabName}" not found, trying text match...`);
              const altBtn = page.getByText(tabName, { exact: false }).first();
              if (await altBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await altBtn.click();
                await page.waitForTimeout(2000);
              } else {
                console.log(`    ✗ Tab "${tabName}" not found at all`);
              }
            }
          } else if (action.startsWith('click-subtab:')) {
            const subName = action.replace('click-subtab:', '');
            const subBtn = page.getByText(subName, { exact: false }).first();
            if (await subBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await subBtn.click();
              await page.waitForTimeout(2000);
            } else {
              console.log(`    ⚠ Subtab "${subName}" not found`);
            }
          }
        }
      }

      await page.screenshot({ path: path.join(OUT_DIR, `${pg.name}.png`), fullPage: true });
      console.log(`  ✓ ${pg.name}.png`);
    } catch (err) {
      console.error(`  ✗ ${pg.name} failed:`, (err as Error).message?.substring(0, 100));
      // Take whatever we can see
      try {
        await page.screenshot({ path: path.join(OUT_DIR, `${pg.name}_error.png`), fullPage: true });
      } catch { /* ignore */ }
    }
  }

  await browser.close();
  console.log('\n=== Done ===');

  // List captured files
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png'));
  console.log(`${files.length} screenshots captured:`);
  for (const f of files) {
    const size = fs.statSync(path.join(OUT_DIR, f)).size;
    console.log(`  ${f} (${(size / 1024).toFixed(1)} KB)`);
  }
}

main().catch(console.error);
