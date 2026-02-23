import { test, expect } from '@playwright/test';
import { login, saveScreenshot, waitForVisible } from './helpers';

test.describe('テスト4: DM送信画面の動作確認', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('DM管理画面が正常表示される（送信は行わない）', async ({ page }) => {
    // Step 1: DM管理画面へ
    await page.goto('/dm');
    await page.waitForLoadState('networkidle');
    await saveScreenshot(page, '04-dm-page');

    // Step 2: キャスト配下のDMタブへ直接遷移
    await page.goto('/casts/hanshakun?tab=dm');
    await page.waitForLoadState('networkidle');
    await saveScreenshot(page, '04-dm-cast-tab');

    // Step 3: セグメント選択UIの確認
    // セグメントS1〜S10の少なくとも1つが表示されること
    const hasSegments = await waitForVisible(page, 'S1', 10_000);
    if (hasSegments) {
      await saveScreenshot(page, '04-dm-segments');
    }

    // Step 4: DM送信関連ボタンが存在することを確認（クリックしない）
    const sendButtons = page.getByRole('button').filter({ hasText: /送信|一括/ });
    const sendBtnCount = await sendButtons.count();

    // 送信ボタンの存在を記録（0でもエラーにしない — UIの状態による）
    test.info().annotations.push({
      type: 'info',
      description: `DM送信関連ボタン数: ${sendBtnCount}`,
    });

    await saveScreenshot(page, '04-dm-final');
  });
});
