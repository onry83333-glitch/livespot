import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const BASE_URL = 'http://localhost:3000';
const EMAIL = 'admin@livespot.jp';
const PASSWORD = 'livespot2024';

// Ensure screenshots dir
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function ssPath(name: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  return path.join(SCREENSHOTS_DIR, `${name}_${ts}.png`);
}

async function screenshot(page: Page, name: string): Promise<string> {
  const p = ssPath(name);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

// ============================================================
// 1. Login
// ============================================================
test('01_login', async ({ page }) => {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Fill login form
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await screenshot(page, '01_login_form');

  // Click login button
  await page.click('button[type="submit"]');

  // Wait for redirect to dashboard
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const path1 = await screenshot(page, '01_login_success');
  console.log(`  Screenshot: ${path1}`);

  // Should be on dashboard
  expect(page.url()).not.toContain('/login');
});

// ============================================================
// 2. Dashboard
// ============================================================
test('02_dashboard', async ({ page }) => {
  // Login first
  await login(page);

  await page.goto(`${BASE_URL}/`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const p = await screenshot(page, '02_dashboard');
  console.log(`  Screenshot: ${p}`);

  // Check some content exists
  const body = await page.textContent('body');
  expect(body).toBeTruthy();
});

// ============================================================
// 3. SPY → 自社キャスト → 分析タブ → 4サブタブ
// ============================================================
test('03_spy_analysis_tabs', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/spy`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await screenshot(page, '03a_spy_realtime');

  // Click 分析 tab (own sub-tab)
  const analysisBtn = page.locator('button', { hasText: '分析' });
  if (await analysisBtn.count() > 0) {
    await analysisBtn.first().click();
    await page.waitForTimeout(3000);
    await screenshot(page, '03b_spy_analysis_schedule');

    // Click 課金パターン
    const paymentBtn = page.locator('button', { hasText: '課金パターン' });
    if (await paymentBtn.count() > 0) {
      await paymentBtn.first().click();
      await page.waitForTimeout(3000);
      await screenshot(page, '03c_spy_analysis_payment');
    }

    // Click 成長曲線
    const growthBtn = page.locator('button', { hasText: '成長曲線' });
    if (await growthBtn.count() > 0) {
      await growthBtn.first().click();
      await page.waitForTimeout(3000);
      await screenshot(page, '03d_spy_analysis_growth');
    }

    // Click マーケットトレンド
    const marketBtn = page.locator('button', { hasText: 'マーケットトレンド' });
    if (await marketBtn.count() > 0) {
      await marketBtn.first().click();
      await page.waitForTimeout(3000);
      await screenshot(page, '03e_spy_analysis_market');
    }
  } else {
    console.log('  WARN: 分析 tab not found');
  }
});

// ============================================================
// 4. Settings → コスト設定タブ
// ============================================================
test('04_settings_cost', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/settings`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Click コスト tab
  const costBtn = page.locator('button', { hasText: 'コスト' });
  if (await costBtn.count() > 0) {
    await costBtn.first().click();
    await page.waitForTimeout(2000);
  }

  const p = await screenshot(page, '04_settings_cost');
  console.log(`  Screenshot: ${p}`);
});

// ============================================================
// 5. Settings → DMトリガータブ
// ============================================================
test('05_settings_triggers', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/settings`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Click DMトリガー tab
  const triggerBtn = page.locator('button', { hasText: 'DMトリガー' });
  if (await triggerBtn.count() > 0) {
    await triggerBtn.first().click();
    await page.waitForTimeout(2000);
  }

  const p = await screenshot(page, '05_settings_triggers');
  console.log(`  Screenshot: ${p}`);
});

// ============================================================
// 6. Casts detail → 健全性/スコアリング
// ============================================================
test('06_cast_detail', async ({ page }) => {
  await login(page);

  // Go to casts page first to find a cast
  await page.goto(`${BASE_URL}/casts`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await screenshot(page, '06a_casts_list');

  // Try navigating to Risa_06 detail
  await page.goto(`${BASE_URL}/casts/Risa_06`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  const p = await screenshot(page, '06b_cast_detail');
  console.log(`  Screenshot: ${p}`);
});

// ============================================================
// 7. Alerts page
// ============================================================
test('07_alerts', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE_URL}/alerts`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const p = await screenshot(page, '07_alerts');
  console.log(`  Screenshot: ${p}`);
});

// ============================================================
// Helper: Login
// ============================================================
async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Check if already logged in (redirected away from login)
  if (!page.url().includes('/login')) return;

  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
}
