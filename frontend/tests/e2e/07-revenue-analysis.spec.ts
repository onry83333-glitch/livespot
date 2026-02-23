import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト7: 売上分析ページ', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('売上分析ページが表示される', async ({ page }) => {
    await page.goto('/analytics');
    await waitForVisible(page, 'Analytics', 10_000);
    await expect(page.getByText('売上分析・DM効果測定')).toBeVisible();

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '07-analytics-overview');
  });

  test('DM効果測定タブのコイン集計データが表示される', async ({ page }) => {
    await page.goto('/analytics');
    await waitForVisible(page, 'Analytics', 10_000);

    // DM効果測定タブをクリック
    await page.getByRole('button', { name: 'DM効果測定' }).click();
    await page.waitForLoadState('networkidle');

    // DM送信数カードまたは空状態メッセージが表示される
    const hasData = await waitForVisible(page, 'DM送信数', 5_000);
    const hasEmpty = await waitForVisible(page, 'DM送信データがありません', 3_000);
    expect(hasData || hasEmpty).toBeTruthy();

    await saveScreenshot(page, '07-analytics-dm');
  });

  test('ファネル分析タブのセグメント別集計が表示される', async ({ page }) => {
    await page.goto('/analytics');
    await waitForVisible(page, 'Analytics', 10_000);

    // ファネル分析タブをクリック
    await page.getByText('ファネル分析').click();
    await page.waitForLoadState('networkidle');

    // ファネルデータまたは空状態メッセージが表示される
    const hasFunnel = await waitForVisible(page, 'ユーザーファネル', 5_000);
    const hasEmpty = await waitForVisible(page, 'ファネルデータがありません', 3_000);
    expect(hasFunnel || hasEmpty).toBeTruthy();

    await saveScreenshot(page, '07-analytics-funnel');
  });
});
