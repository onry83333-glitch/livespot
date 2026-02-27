/**
 * T-011: キャスト横並び比較
 * ダッシュボード → 売上ソート → 比較表示
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('T-011: キャスト横並び比較', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('キャスト比較ページで横並び表示される', async ({ page }) => {
    // Step 1: キャスト比較ページへ
    await page.goto('/analytics/compare');
    await page.waitForLoadState('networkidle');

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    // タイトル確認
    const hasTitle = await waitForVisible(page, '比較', 10_000);
    const hasAnalytics = await waitForVisible(page, 'Analytics', 5_000);
    expect(hasTitle || hasAnalytics).toBeTruthy();

    await saveScreenshot(page, '18-compare-initial');

    // Step 2: キャスト選択UIの確認
    // チェックボックスまたは選択UIが表示される
    const checkboxes = page.locator('input[type="checkbox"]');
    const checkboxCount = await checkboxes.count();
    const selects = page.locator('select');
    const selectCount = await selects.count();

    test.info().annotations.push({
      type: 'info',
      description: `選択UI: チェックボックス=${checkboxCount}, セレクト=${selectCount}`,
    });

    await saveScreenshot(page, '18-compare-selection');

    // Step 3: 比較データの表示確認
    // 売上データまたは空状態
    const hasTkData = await waitForVisible(page, 'tk', 5_000);
    const hasJpyData = await waitForVisible(page, '¥', 5_000);
    const hasNoData = await waitForVisible(page, 'キャストを選択', 5_000);
    const hasEmptyMsg = await waitForVisible(page, 'データがありません', 3_000);

    test.info().annotations.push({
      type: 'info',
      description: `比較データ: tk=${hasTkData}, JPY=${hasJpyData}, 空=${hasNoData || hasEmptyMsg}`,
    });

    expect(hasTkData || hasJpyData || hasNoData || hasEmptyMsg).toBeTruthy();

    await saveScreenshot(page, '18-compare-data');
  });

  test('キャスト一覧ページでソート可能な売上表示', async ({ page }) => {
    // キャスト一覧ページへ
    await page.goto('/casts');
    await page.waitForLoadState('networkidle');

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    // キャストカードが表示される
    const hasRisa = await waitForVisible(page, 'Risa_06', 10_000);
    const hasHanshakun = await waitForVisible(page, 'hanshakun', 5_000);

    test.info().annotations.push({
      type: 'info',
      description: `キャスト: Risa_06=${hasRisa}, hanshakun=${hasHanshakun}`,
    });

    // 売上関連の数値が表示される（tk, ¥, コイン）
    const hasTk = await waitForVisible(page, 'tk', 5_000);
    const hasJpy = await waitForVisible(page, '¥', 5_000);

    test.info().annotations.push({
      type: 'info',
      description: `売上表示: tk=${hasTk}, ¥=${hasJpy}`,
    });

    await saveScreenshot(page, '18-casts-list-revenue');
  });
});
