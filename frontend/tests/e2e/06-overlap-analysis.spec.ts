import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('テスト6: 競合分析タブ — 表示確認', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('競合分析タブが正常に表示される', async ({ page }) => {
    // Step 1: キャスト詳細ページ → 競合分析タブへ直接遷移
    await page.goto('/casts/hanshakun?tab=overlap');
    await page.waitForLoadState('networkidle');
    await saveScreenshot(page, '06-overlap-initial');

    // Step 2: エラーがないこと
    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    // Step 3: 「競合分析」タブがアクティブであること
    const tabButton = page.locator('button', { hasText: '競合分析' });
    await expect(tabButton).toBeVisible();

    // Step 4: 「集計を更新」ボタンが存在すること
    const refreshButton = page.locator('button', { hasText: /集計を更新|集計中/ });
    await expect(refreshButton).toBeVisible();
    await saveScreenshot(page, '06-overlap-refresh-button');

    // Step 5: サマリーカード4枚が表示されること
    // カードラベル: 他社ユーザー数, 自社との重複率, 平均他社tk, 獲得候補数
    const summaryLabels = ['他社ユーザー数', '自社との重複率', '平均他社tk', '獲得候補数'];
    for (const label of summaryLabels) {
      const card = page.getByText(label, { exact: false }).first();
      await expect(card).toBeVisible({ timeout: 5_000 });
    }
    await saveScreenshot(page, '06-overlap-summary-cards');

    // Step 6: 重複マトリクスセクションが表示されること
    const matrixHeader = page.getByText('ユーザー重複マトリクス', { exact: false }).first();
    await expect(matrixHeader).toBeVisible();
    // データありならテーブル、なしなら「データなし」
    const hasTable = await page.locator('table').first().isVisible().catch(() => false);
    const hasEmpty = await page.getByText('データなし').first().isVisible().catch(() => false);
    expect(hasTable || hasEmpty).toBeTruthy();
    await saveScreenshot(page, '06-overlap-matrix');

    // Step 7: ユーザーランキングセクションが表示されること
    const rankingHeader = page.getByText('他社高額課金ユーザーランキング', { exact: false }).first();
    await expect(rankingHeader).toBeVisible();
    await saveScreenshot(page, '06-overlap-ranking');

    // Step 8: プロフィール集計セクションが表示されること
    const profileSection = page.getByText('プロフィール集計', { exact: false }).first();
    await expect(profileSection).toBeVisible();

    // 最終スクリーンショット
    await saveScreenshot(page, '06-overlap-full');
  });
});
