import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト8: 他社SPYページ', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('SPYページが表示される', async ({ page }) => {
    await page.goto('/spy');
    await waitForVisible(page, '自社キャスト', 10_000);
    await expect(page.getByText('他社キャスト')).toBeVisible();

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '08-spy-overview');
  });

  test('他社キャスト — リアルタイムタブが表示される', async ({ page }) => {
    await page.goto('/spy');
    await waitForVisible(page, '他社キャスト', 10_000);

    // 他社キャストタブをクリック
    await page.getByText('他社キャスト').click();
    await page.waitForLoadState('networkidle');

    // リアルタイムサブタブが表示される
    const hasRealtime = await waitForVisible(page, 'リアルタイム', 5_000);
    expect(hasRealtime).toBeTruthy();

    await saveScreenshot(page, '08-spy-competitor-realtime');
  });

  test('他社キャスト — キャスト一覧タブが表示される', async ({ page }) => {
    await page.goto('/spy');
    await waitForVisible(page, '他社キャスト', 10_000);

    await page.getByText('他社キャスト').click();
    await page.waitForLoadState('networkidle');

    // キャスト一覧サブタブをクリック
    await page.getByRole('button', { name: /キャスト一覧/ }).click();
    await page.waitForLoadState('networkidle');

    const hasList = await waitForVisible(page, 'スパイキャスト一覧', 5_000);
    expect(hasList).toBeTruthy();

    await saveScreenshot(page, '08-spy-competitor-list');
  });

  test('他社キャスト — マーケット分析タブが表示される', async ({ page }) => {
    await page.goto('/spy');
    await waitForVisible(page, '他社キャスト', 10_000);

    await page.getByText('他社キャスト').click();
    await page.waitForLoadState('networkidle');

    // マーケット分析サブタブをクリック
    await page.getByText('マーケット分析').click();
    await page.waitForLoadState('networkidle');

    const hasMarket = await waitForVisible(page, 'マーケット分析', 5_000);
    expect(hasMarket).toBeTruthy();

    await saveScreenshot(page, '08-spy-market');
  });
});
