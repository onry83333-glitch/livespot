import { test } from '@playwright/test';

test('debug auth flow', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));
  
  await page.goto('/login');
  await page.waitForTimeout(10_000);
  
  const bodyText = await page.locator('body').innerText();
  console.log('=== PAGE TEXT ===');
  console.log(bodyText.substring(0, 500));
  console.log('=== CONSOLE ERRORS ===');
  for (const e of errors) console.log(e);
  console.log('=== URL ===');
  console.log(page.url());
});
