import { test, expect } from '@playwright/test';
import { login, saveScreenshot, waitForVisible } from './helpers';

test.describe('テスト1: ログイン → ダッシュボード表示', () => {
  test('ログインしてダッシュボードが表示される', async ({ page }) => {
    // Step 1: /login にアクセス
    await page.goto('/login');
    await expect(page.getByText('Strip Live Spot')).toBeVisible();
    await saveScreenshot(page, '01-login-page');

    // Step 2: ログイン実行
    await login(page);

    // Step 3: ダッシュボードが表示されることを確認
    // サイドバーのロゴまたはダッシュボード要素の確認
    const hasSidebar = await waitForVisible(page, 'キャスト一覧', 10_000);
    expect(hasSidebar).toBeTruthy();

    await saveScreenshot(page, '01-dashboard');
  });
});
