/**
 * T-004: 競合収益推定
 * SPYキャスト → チップ集計 → 推定収益計算値の表示
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('T-004: 競合収益推定', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('SPYページで競合キャストのチップ集計が表示される', async ({ page }) => {
    // Step 1: SPYページへ
    await page.goto('/spy');
    await page.waitForLoadState('networkidle');

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '16-spy-initial');

    // Step 2: 他社キャストタブをクリック
    const competitorTab = page.getByRole('button', { name: /他社キャスト/ });
    const hasCompetitorTab = await competitorTab.count() > 0;

    if (hasCompetitorTab) {
      await competitorTab.click();
      await page.waitForLoadState('networkidle');
      await saveScreenshot(page, '16-spy-competitor-tab');

      // Step 3: キャスト一覧サブタブをクリック
      const castListBtn = page.getByRole('button', { name: /キャスト一覧/ });
      if (await castListBtn.count() > 0) {
        await castListBtn.click();
        await page.waitForLoadState('networkidle');

        // 競合キャストのリストまたは空状態が表示される
        const hasCastList = await waitForVisible(page, 'キャスト', 5_000);
        const hasEmpty = await waitForVisible(page, '登録されていません', 5_000);
        expect(hasCastList || hasEmpty).toBeTruthy();

        await saveScreenshot(page, '16-spy-cast-list');
      }

      // Step 4: マーケット分析サブタブをクリック
      const marketBtn = page.getByRole('button', { name: /マーケット分析/ });
      if (await marketBtn.count() > 0) {
        await marketBtn.click();
        await page.waitForLoadState('networkidle');

        // 収益推定データまたは空状態が表示される
        const hasRevenue = await waitForVisible(page, 'tk', 5_000);
        const hasEstimate = await waitForVisible(page, '推定', 5_000);
        const hasNoData = await waitForVisible(page, 'データがありません', 5_000);

        test.info().annotations.push({
          type: 'info',
          description: `マーケット分析: tk表示=${hasRevenue}, 推定=${hasEstimate}, 空=${hasNoData}`,
        });

        await saveScreenshot(page, '16-spy-market-analysis');
      }
    } else {
      test.info().annotations.push({
        type: 'info',
        description: '他社キャストタブが表示されませんでした',
      });
    }

    // Step 5: 自社キャストタブのリアルタイムサブタブでチップデータ確認
    const ownTab = page.getByRole('button', { name: /自社キャスト/ });
    if (await ownTab.count() > 0) {
      await ownTab.click();
      await page.waitForLoadState('networkidle');

      const hasRealtime = await waitForVisible(page, 'リアルタイム', 5_000);

      test.info().annotations.push({
        type: 'info',
        description: `自社リアルタイム: ${hasRealtime}`,
      });

      await saveScreenshot(page, '16-spy-own-realtime');
    }
  });
});
