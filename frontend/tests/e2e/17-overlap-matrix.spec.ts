/**
 * T-005: 重複マトリクス
 * 競合分析タブ → 重複率パーセンテージ表示
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('T-005: 重複マトリクス', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('競合分析タブで重複マトリクスが表示される', async ({ page }) => {
    // Step 1: 競合分析（overlap）タブへ
    await page.goto('/casts/Risa_06?tab=overlap');
    await page.waitForLoadState('networkidle');

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '17-overlap-initial');

    // Step 2: サマリーカード（4枚）の確認
    const hasOtherUsers = await waitForVisible(page, '他キャスト', 10_000);
    const hasOverlapRate = await waitForVisible(page, '重複率', 5_000);
    const hasAvgTk = await waitForVisible(page, '平均', 5_000);

    test.info().annotations.push({
      type: 'info',
      description: `サマリー: 他ユーザー=${hasOtherUsers}, 重複率=${hasOverlapRate}, 平均=${hasAvgTk}`,
    });

    // いずれかのサマリーカードまたは空状態
    const hasData = hasOtherUsers || hasOverlapRate || hasAvgTk;
    const hasNoData = await waitForVisible(page, 'データがありません', 5_000);
    expect(hasData || hasNoData).toBeTruthy();

    await saveScreenshot(page, '17-overlap-summary');

    if (hasData) {
      // Step 3: マトリクステーブルの確認
      // テーブルが存在するか確認
      const tables = page.locator('table');
      const tableCount = await tables.count();

      test.info().annotations.push({
        type: 'info',
        description: `テーブル数: ${tableCount}`,
      });

      // パーセンテージ表示（%マーク）の確認
      const percentCells = page.locator('td:has-text("%"), th:has-text("%")');
      const percentCount = await percentCells.count();

      test.info().annotations.push({
        type: 'info',
        description: `パーセンテージセル数: ${percentCount}`,
      });

      await saveScreenshot(page, '17-overlap-matrix');

      // Step 4: ランキングセクションの確認
      const hasRanking = await waitForVisible(page, 'ランキング', 5_000);
      const hasTopSpender = await waitForVisible(page, 'スペンダー', 5_000);

      test.info().annotations.push({
        type: 'info',
        description: `ランキング: ${hasRanking || hasTopSpender}`,
      });

      await saveScreenshot(page, '17-overlap-ranking');
    }
  });
});
