import { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// .env.test から環境変数を読み込み
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.test') });

export const TEST_EMAIL = process.env.E2E_TEST_EMAIL || 'admin@livespot.jp';
export const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'livespot2024';

/** スクリーンショット保存先ディレクトリ（tests/screenshots/YYYY-MM-DD/） */
function getScreenshotDir(): string {
  const today = new Date().toISOString().split('T')[0];
  const dir = path.join(__dirname, '..', 'screenshots', today);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 命名規則付きスクリーンショット保存 */
export async function saveScreenshot(page: Page, name: string): Promise<void> {
  const dir = getScreenshotDir();
  const filePath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
}

/** ログイン処理（全テストで共通利用） */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');

  // 既にログイン済みでダッシュボードにリダイレクトされた場合はスキップ
  const currentUrl = page.url();
  if (!currentUrl.includes('/login')) {
    return;
  }

  // ログインフォームが表示されるまで待つ（レート制限や遅延に対応）
  const emailInput = page.getByPlaceholder('you@example.com');
  await emailInput.waitFor({ state: 'visible', timeout: 15_000 });

  await emailInput.fill(TEST_EMAIL);
  await page.getByPlaceholder('••••••••').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'ログイン' }).click();

  // ダッシュボードへのリダイレクトを待つ
  await page.waitForURL('/', { timeout: 15_000 });
}

/** ページ内に致命的エラー表示がないことを確認 */
export async function assertNoErrors(page: Page): Promise<boolean> {
  // Next.js のエラーページ or 致命的エラーのみチェック
  // "404" や "エラー" といった一般的な文字列はコンテンツ内に含まれうるため除外
  const title = await page.title();
  if (title.includes('404') || title.includes('500')) return false;

  // Next.js エラーオーバーレイの検出
  const errorOverlay = page.locator('nextjs-portal, [data-nextjs-dialog]');
  if (await errorOverlay.count() > 0) return false;

  // 白画面チェック（bodyのテキストが極端に短い）
  const bodyText = await page.locator('body').innerText();
  if (bodyText.trim().length < 20) return false;

  return true;
}

/** 要素が表示されるまで待つ（soft wait） */
export async function waitForVisible(page: Page, text: string, timeout = 10_000): Promise<boolean> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}
