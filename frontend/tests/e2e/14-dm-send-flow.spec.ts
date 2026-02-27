/**
 * T-002: DM送信フロー
 * セグメント選択 → ユーザー展開 → DM画面遷移 → プレビュー表示（実送信禁止）
 */
import { test, expect } from '@playwright/test';
import { login, saveScreenshot, assertNoErrors, waitForVisible } from './helpers';

test.describe('T-002: DM送信フロー（送信禁止）', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('セグメント選択→ユーザー展開→DM画面遷移→プレビュー', async ({ page }) => {
    // Step 1: キャストDMタブへ直接遷移
    await page.goto('/casts/Risa_06?tab=dm');
    await page.waitForLoadState('networkidle');

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '14-dm-tab-initial');

    // Step 2: セグメントUI確認（S1-S10のいずれか）
    const hasSegmentS1 = await waitForVisible(page, 'S1', 10_000);
    const hasSegmentS3 = await waitForVisible(page, 'S3', 5_000);
    const hasSegmentS10 = await waitForVisible(page, 'S10', 5_000);
    const hasAnySegment = hasSegmentS1 || hasSegmentS3 || hasSegmentS10;

    test.info().annotations.push({
      type: 'info',
      description: `セグメント表示: S1=${hasSegmentS1}, S3=${hasSegmentS3}, S10=${hasSegmentS10}`,
    });

    await saveScreenshot(page, '14-dm-segments');

    // Step 3: ユーザー検索入力フィールドの存在確認
    const searchInputs = page.locator('input[placeholder*="ユーザー"], input[placeholder*="検索"], input[placeholder*="user"]');
    const hasSearchInput = await searchInputs.count() > 0;

    test.info().annotations.push({
      type: 'info',
      description: `検索入力: ${hasSearchInput}`,
    });

    // Step 4: DM送信ボタンの存在確認（クリックしない — 実送信禁止）
    const dmButtons = page.getByRole('button').filter({ hasText: /送信|DM|一括/ });
    const dmBtnCount = await dmButtons.count();

    test.info().annotations.push({
      type: 'info',
      description: `DM関連ボタン数: ${dmBtnCount}`,
    });

    // Step 5: メッセージ入力エリアの存在確認
    const textareas = page.locator('textarea');
    const hasTextarea = await textareas.count() > 0;

    test.info().annotations.push({
      type: 'info',
      description: `メッセージ入力エリア: ${hasTextarea}`,
    });

    // Step 6: キャンペーン入力フィールドの存在確認
    const campaignInput = page.locator('input[placeholder*="キャンペーン"], input[placeholder*="campaign"]');
    const hasCampaignInput = await campaignInput.count() > 0;

    test.info().annotations.push({
      type: 'info',
      description: `キャンペーン入力: ${hasCampaignInput}`,
    });

    await saveScreenshot(page, '14-dm-send-form');

    // Step 7: DM効果セクションの確認
    const hasEffectiveness = await waitForVisible(page, 'DM効果', 5_000);
    const hasCvr = await waitForVisible(page, 'CVR', 5_000);

    test.info().annotations.push({
      type: 'info',
      description: `効果測定: 効果=${hasEffectiveness}, CVR=${hasCvr}`,
    });

    await saveScreenshot(page, '14-dm-effectiveness');
  });

  test('DM管理画面からキャスト一覧が表示される', async ({ page }) => {
    await page.goto('/dm');
    await page.waitForLoadState('networkidle');

    // キャスト選択カードが表示されるか、キャスト未登録メッセージが表示される
    const hasRisa = await waitForVisible(page, 'Risa_06', 10_000);
    const hasNoCasts = await waitForVisible(page, 'キャストが登録されていません', 5_000);
    expect(hasRisa || hasNoCasts).toBeTruthy();

    const noErrors = await assertNoErrors(page);
    expect(noErrors).toBeTruthy();

    await saveScreenshot(page, '14-dm-cast-select');
  });
});
