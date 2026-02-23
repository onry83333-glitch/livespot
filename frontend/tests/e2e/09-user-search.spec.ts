import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト9: ユーザー検索ページ', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('ユーザー管理ページが表示される', async ({ page }) => {
    await page.goto('/users');
    await waitForVisible(page, 'ユーザー管理', 10_000);

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '09-users-overview');
  });

  test('検索入力欄が表示される', async ({ page }) => {
    await page.goto('/users');
    await waitForVisible(page, 'ユーザー管理', 10_000);

    const searchInput = page.getByPlaceholder(/ユーザー名で検索/);
    await expect(searchInput).toBeVisible();

    await saveScreenshot(page, '09-users-search-input');
  });

  test('検索実行でエラーが出ない', async ({ page }) => {
    await page.goto('/users');
    await waitForVisible(page, 'ユーザー管理', 10_000);

    // 検索を実行
    const searchInput = page.getByPlaceholder(/ユーザー名で検索/);
    await searchInput.fill('test_user');
    await page.waitForLoadState('networkidle');

    // 致命的エラーがないことを確認
    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '09-users-search-result');
  });
});
