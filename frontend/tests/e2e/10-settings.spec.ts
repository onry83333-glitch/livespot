import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト10: 設定ページ', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('設定ページが表示される', async ({ page }) => {
    await page.goto('/settings');
    await waitForVisible(page, 'Settings', 10_000);
    await expect(page.getByText('アカウント設定・セキュリティ管理')).toBeVisible();

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '10-settings-overview');
  });

  test('設定項目が表示される', async ({ page }) => {
    await page.goto('/settings');
    await waitForVisible(page, 'Settings', 10_000);

    // タブが表示される
    await expect(page.getByRole('button', { name: 'アカウント設定' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'セキュリティ' })).toBeVisible();

    // Chrome拡張ステータスカード
    const hasExtension = await waitForVisible(page, 'Chrome拡張', 5_000);
    expect(hasExtension).toBeTruthy();

    // Stripchat セッションカード
    const hasSession = await waitForVisible(page, 'Stripchat セッション', 5_000);
    expect(hasSession).toBeTruthy();

    await saveScreenshot(page, '10-settings-items');
  });
});
