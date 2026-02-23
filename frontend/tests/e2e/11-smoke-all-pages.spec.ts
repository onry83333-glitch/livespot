import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

const PAGES = [
  { name: 'casts', path: '/casts', expect: 'キャスト' },
  { name: 'dm', path: '/dm', expect: 'DM' },
  { name: 'analytics', path: '/analytics', expect: 'Analytics' },
  { name: 'users', path: '/users', expect: 'ユーザー' },
  { name: 'spy', path: '/spy', expect: 'キャスト' },
  { name: 'command-center', path: '/admin/command-center', expect: 'コマンド' },
  { name: 'health', path: '/admin/health', expect: '品質' },
  { name: 'settings', path: '/settings', expect: 'Settings' },
];

test.describe('テスト11: 全ページ巡回スモークテスト', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const pg of PAGES) {
    test(`${pg.name} (${pg.path}) が正常表示`, async ({ page }) => {
      await page.goto(pg.path);
      await page.waitForLoadState('networkidle');

      // 致命的エラーがないことを確認
      const noErrors = await assertNoErrors(page);
      expect(noErrors).toBeTruthy();

      // ページ固有のテキストが表示される
      const hasContent = await waitForVisible(page, pg.expect, 10_000);
      expect(hasContent).toBeTruthy();

      await saveScreenshot(page, `11-smoke-${pg.name}`);
    });
  }
});
