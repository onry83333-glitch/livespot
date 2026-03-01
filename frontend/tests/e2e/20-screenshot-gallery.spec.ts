/**
 * 全画面スクリーンショット自動撮影
 *
 * 目的: YUUTAの手動テスト負荷解消
 * - ログイン → 全画面遷移 → スクリーンショット自動保存
 * - YUUTAはスクショフォルダを確認するだけ
 *
 * 実行: npm run test:screenshots
 * 出力: tests/screenshots/YYYY-MM-DD/gallery-*.png
 */
import { test, expect, Page } from '@playwright/test';
import { login, saveScreenshot } from './helpers';

// ========== 設定 ==========

/** 各ページの待機時間（Supabase RPCの応答待ち） */
const PAGE_WAIT = 3_000;

/** スクショ連番カウンター */
let shotIndex = 0;

/** 連番付きスクショ保存 */
async function shot(page: Page, name: string): Promise<void> {
  shotIndex++;
  const prefix = String(shotIndex).padStart(2, '0');
  await saveScreenshot(page, `gallery-${prefix}-${name}`);
}

/** ページ遷移 + 安定待機 */
async function visitPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(PAGE_WAIT);
}

/** タブクリック（テキストマッチ） */
async function clickTab(page: Page, tabText: string): Promise<boolean> {
  try {
    const tab = page.getByRole('tab', { name: tabText }).or(
      page.getByRole('button', { name: tabText })
    ).first();
    if (await tab.isVisible({ timeout: 2_000 })) {
      await tab.click();
      await page.waitForTimeout(2_000);
      return true;
    }
  } catch { /* タブが無い場合はスキップ */ }
  return false;
}

/** ページからリンクを抽出（動的ルート用） */
async function extractFirstLink(page: Page, pattern: RegExp): Promise<string | null> {
  const links = await page.locator('a').evaluateAll(
    (els, pat) => els
      .map(el => el.getAttribute('href'))
      .filter((href): href is string => href !== null && new RegExp(pat).test(href)),
    pattern.source
  );
  return links[0] || null;
}

// ========== テスト ==========

test.describe('全画面スクリーンショット撮影', () => {
  test.setTimeout(300_000); // 5分（全画面巡回）

  test('全ページ巡回 + スクリーンショット保存', async ({ page }) => {
    // ---------- 0. ログイン画面 ----------
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await shot(page, 'login');

    // ---------- 1. ログイン実行 ----------
    await login(page);
    await page.waitForTimeout(2_000);

    // ---------- 2. ダッシュボード ----------
    await visitPage(page, '/');
    await shot(page, 'dashboard');

    // ---------- 3. キャスト一覧 ----------
    await visitPage(page, '/casts');
    await shot(page, 'casts');

    // ---------- 4. キャスト詳細（6タブ） ----------
    // 実データからキャスト名を取得
    let castName = 'hanshakun'; // デフォルト
    const castLink = await extractFirstLink(page, /\/casts\/[^/]+$/);
    if (castLink) {
      castName = castLink.replace('/casts/', '');
    }

    await visitPage(page, `/casts/${castName}`);
    await shot(page, `cast-${castName}-overview`);

    // タブ巡回
    const castTabs = ['配信', 'DM', '分析', '売上', 'リアルタイム'];
    for (const tabName of castTabs) {
      const clicked = await clickTab(page, tabName);
      if (clicked) {
        await shot(page, `cast-${castName}-${tabName}`);
      }
    }

    // ---------- 5. セッション一覧 ----------
    await visitPage(page, '/sessions');
    await shot(page, 'sessions');

    // ---------- 6. セッション詳細（あれば） ----------
    const sessionLink = await extractFirstLink(page, /\/sessions\/[^/]+$/);
    if (sessionLink) {
      const sessionPath = sessionLink.startsWith('/casts')
        ? sessionLink
        : `/casts/${castName}${sessionLink}`;
      await visitPage(page, sessionPath);
      await shot(page, 'session-detail');
    }

    // ---------- 7. SPYページ ----------
    await visitPage(page, '/spy');
    await shot(page, 'spy-main');

    // SPY 自社/他社タブ
    if (await clickTab(page, '他社')) {
      await shot(page, 'spy-competitor');
    }
    if (await clickTab(page, '自社')) {
      await shot(page, 'spy-own');
    }

    // ---------- 8. SPYキャスト別（あれば） ----------
    await visitPage(page, `/spy/${castName}`);
    await shot(page, `spy-cast-${castName}`);

    // ---------- 9. SPY分析 ----------
    await visitPage(page, '/spy/analysis');
    await shot(page, 'spy-analysis');

    // ---------- 10. DM管理 ----------
    await visitPage(page, '/dm');
    await shot(page, 'dm');

    // ---------- 11. アラート ----------
    await visitPage(page, '/alerts');
    await shot(page, 'alerts');

    // ---------- 12. アナリティクス ----------
    await visitPage(page, '/analytics');
    await shot(page, 'analytics');

    // アナリティクス内タブ
    const analyticsTabs = ['売上', 'ユーザー', 'ARPU', 'リテンション', '収入源'];
    for (const tabName of analyticsTabs) {
      const clicked = await clickTab(page, tabName);
      if (clicked) {
        await shot(page, `analytics-${tabName}`);
      }
    }

    // ---------- 13. キャスト比較 ----------
    await visitPage(page, '/analytics/compare');
    await shot(page, 'analytics-compare');

    // ---------- 14. ユーザー一覧 ----------
    await visitPage(page, '/users');
    await shot(page, 'users');

    // ---------- 15. ユーザー詳細（あれば） ----------
    const userLink = await extractFirstLink(page, /\/users\/[^/]+$/);
    if (userLink) {
      await visitPage(page, userLink);
      const userName = userLink.replace('/users/', '');
      await shot(page, `user-${userName}`);
    }

    // ---------- 16. レポート ----------
    await visitPage(page, '/reports');
    await shot(page, 'reports');

    // ---------- 17. フィード ----------
    await visitPage(page, '/feed');
    await shot(page, 'feed');

    // ---------- 18. 設定 ----------
    await visitPage(page, '/settings');
    await shot(page, 'settings');

    // 設定内タブ
    const settingsTabs = ['DMトリガー', 'セキュリティ'];
    for (const tabName of settingsTabs) {
      const clicked = await clickTab(page, tabName);
      if (clicked) {
        await shot(page, `settings-${tabName}`);
      }
    }

    // ---------- 19. Admin: コマンドセンター ----------
    await visitPage(page, '/admin/command-center');
    await shot(page, 'admin-command-center');

    const commandTabs = ['戦略', 'オペレーション', 'アセット'];
    for (const tabName of commandTabs) {
      const clicked = await clickTab(page, tabName);
      if (clicked) {
        await shot(page, `admin-command-${tabName}`);
      }
    }

    // ---------- 20. Admin: 品質チェック ----------
    await visitPage(page, '/admin/health');
    await shot(page, 'admin-health');

    // ---------- 21. Admin: レベニューシェア ----------
    await visitPage(page, '/admin/revenue');
    await shot(page, 'admin-revenue');

    // ---------- 22. Admin: データ品質 ----------
    await visitPage(page, '/admin/data-quality');
    await shot(page, 'admin-data-quality');

    // ---------- 23. Admin: テストデータ ----------
    await visitPage(page, '/admin/test-data');
    await shot(page, 'admin-test-data');

    // ---------- 24. Admin: キャスト管理 ----------
    await visitPage(page, '/admin/casts');
    await shot(page, 'admin-casts');

    // ---------- 完了 ----------
    console.log(`\n✅ 全画面スクリーンショット完了: ${shotIndex}枚`);
    console.log(`📁 保存先: tests/screenshots/${new Date().toISOString().split('T')[0]}/`);
  });
});
