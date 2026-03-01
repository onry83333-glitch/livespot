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
import { test, Page } from '@playwright/test';
import { saveScreenshot, TEST_EMAIL, TEST_PASSWORD } from './helpers';

// ========== 設定 ==========

const SUPABASE_URL = 'https://ujgbhkllfeacbgpdbjto.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5NjQ5NzcsImV4cCI6MjA4NjU0MDk3N30._vllLuXCU34JMbh0HTM6vIlglGRBX2oP7KBz_5XfKeo';

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

/**
 * Supabase REST APIで直接ログイン → localStorage にトークン設定
 * AppShellの「読み込み中...」スピナーをバイパスする
 */
async function apiLogin(page: Page): Promise<void> {
  // 1. Supabase Auth REST API で認証
  const res = await page.request.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      data: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      },
    },
  );

  if (!res.ok()) {
    throw new Error(`Supabase login failed: ${res.status()} ${await res.text()}`);
  }

  const session = await res.json();

  // 2. localStorageにセッション情報を設定（Supabase SSRが読み取る形式）
  // まずblankページに行ってlocalStorageにアクセス可能にする
  await page.goto('/login');
  await page.waitForTimeout(500);

  // Supabase @supabase/ssr の storage key
  const storageKey = `sb-ujgbhkllfeacbgpdbjto-auth-token`;
  const storageValue = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
    expires_in: session.expires_in,
    token_type: 'bearer',
    user: session.user,
  });

  await page.evaluate(
    ([key, value]) => { localStorage.setItem(key, value); },
    [storageKey, storageValue],
  );

  // 3. ダッシュボードに遷移してログイン完了を確認
  await page.goto('/');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3_000);
}

// ========== テスト ==========

test.describe('全画面スクリーンショット撮影', () => {
  test.setTimeout(300_000); // 5分（全画面巡回）

  test('全ページ巡回 + スクリーンショット保存', async ({ page }) => {
    // ---------- 0. ログイン画面（未認証状態） ----------
    await page.goto('/login');
    await page.waitForTimeout(5_000); // AuthProvider初期化待ち
    await shot(page, 'login');

    // ---------- 1. APIログイン ----------
    await apiLogin(page);
    await shot(page, 'dashboard');

    // ---------- 3. キャスト一覧 ----------
    await visitPage(page, '/casts');
    await shot(page, 'casts');

    // ---------- 4. キャスト詳細（6タブ） ----------
    let castName = 'hanshakun';
    const castLink = await extractFirstLink(page, /\/casts\/[^/]+$/);
    if (castLink) {
      castName = castLink.replace('/casts/', '');
    }

    await visitPage(page, `/casts/${castName}`);
    await shot(page, `cast-${castName}-overview`);

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

    if (await clickTab(page, '他社')) {
      await shot(page, 'spy-competitor');
    }
    if (await clickTab(page, '自社')) {
      await shot(page, 'spy-own');
    }

    // ---------- 8. SPYキャスト別 ----------
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
