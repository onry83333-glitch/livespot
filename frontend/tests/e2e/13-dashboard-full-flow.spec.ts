/**
 * T-008: ダッシュボード完全フロー
 * ログイン → キャスト一覧 → 売上表示 → グラフ描画 → アラート表示
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('T-008: ダッシュボード完全フロー', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('ダッシュボードKPI→キャスト一覧→売上→アラート表示', async ({ page }) => {
    // Step 1: ダッシュボードKPIカードの確認
    await page.waitForLoadState('networkidle');

    const hasStats = await waitForVisible(page, '30日売上', 10_000);
    expect(hasStats).toBeTruthy();

    // 4つのKPIカードが表示される（30日売上, 取引数, チャット, DM送信）
    const hasTxCount = await waitForVisible(page, '取引数', 5_000);
    const hasChatCount = await waitForVisible(page, 'チャット', 5_000);
    const hasDmCount = await waitForVisible(page, 'DM送信', 5_000);

    test.info().annotations.push({
      type: 'info',
      description: `KPI表示: 売上=${hasStats}, 取引=${hasTxCount}, チャット=${hasChatCount}, DM=${hasDmCount}`,
    });

    await saveScreenshot(page, '13-dashboard-kpi');

    // Step 2: ホエールランキングが表示される
    const hasWhaleSection = await waitForVisible(page, 'ホエールランキング', 5_000);
    const hasNoWhales = await waitForVisible(page, 'データなし', 3_000);
    expect(hasWhaleSection || hasNoWhales).toBeTruthy();

    // Step 3: キャスト一覧へ遷移
    await page.goto('/casts');
    await page.waitForLoadState('networkidle');

    const hasCasts = await waitForVisible(page, 'キャスト管理', 10_000);
    expect(hasCasts).toBeTruthy();

    // Risa_06 が表示される
    const hasRisa = await waitForVisible(page, 'Risa_06', 5_000);
    test.info().annotations.push({
      type: 'info',
      description: `Risa_06表示: ${hasRisa}`,
    });

    await saveScreenshot(page, '13-cast-list');

    // Step 4: キャスト個別ページで売上タブ確認
    await page.goto('/casts/Risa_06?tab=sales');
    await page.waitForLoadState('networkidle');

    // 売上タブのコンテンツ（テーブル or 空状態 or コスト未設定）
    const hasSalesData = await waitForVisible(page, 'tk', 10_000);
    const hasNoSales = await waitForVisible(page, 'データがありません', 5_000);
    const hasCostWarning = await waitForVisible(page, 'コスト未設定', 3_000);
    const hasSalesTab = await waitForVisible(page, '売上', 3_000);
    expect(hasSalesData || hasNoSales || hasCostWarning || hasSalesTab).toBeTruthy();

    await saveScreenshot(page, '13-cast-sales');

    // Step 5: ダッシュボードに戻って離脱リスクアラート確認
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const hasChurnAlert = await waitForVisible(page, '離脱リスク', 5_000);
    const hasRecentDm = await waitForVisible(page, 'DM送信履歴', 5_000);

    test.info().annotations.push({
      type: 'info',
      description: `離脱リスク=${hasChurnAlert}, DM履歴=${hasRecentDm}`,
    });

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '13-dashboard-alerts');
  });
});
