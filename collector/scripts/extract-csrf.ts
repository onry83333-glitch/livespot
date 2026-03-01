/**
 * Playwright で Stripchat ページを開き、CSRFトークンとuserIdを抽出
 * → stripchat_sessions テーブルを更新
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function main() {
  // 1. Get valid session
  const { data: sessions } = await sb
    .from('stripchat_sessions')
    .select('*')
    .eq('is_valid', true);

  if (!sessions || sessions.length === 0) {
    console.error('No valid sessions found');
    process.exit(1);
  }

  const session = sessions[0];
  const cj = session.cookies_json as Record<string, string>;
  console.log('Session ID:', session.id);

  // 2. Launch Playwright
  console.log('Launching Playwright...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // 3. Set cookies from session
  const cookieObjs = Object.entries(cj).map(([name, value]) => ({
    name,
    value,
    domain: '.stripchat.com',
    path: '/',
  }));
  await context.addCookies(cookieObjs);

  // 4. Navigate to page
  const page = await context.newPage();
  console.log('Navigating to stripchat.com...');

  try {
    await page.goto('https://ja.stripchat.com/', { waitUntil: 'networkidle', timeout: 30000 });
  } catch {
    console.log('Navigation timeout (continuing anyway)...');
  }

  // 5. Wait for JS to load, then extract CSRF and userId
  console.log('Extracting CSRF token and userId...');
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const w = window as any;
    let csrfToken: string | null = null;
    let csrfTimestamp: string | null = null;
    let csrfNotifyTimestamp: string | null = null;
    let userId: number | null = null;

    // Method 1: window.__logger.kibanaLogger.api.csrfParams (全フィールド取得)
    try {
      const params = w.__logger?.kibanaLogger?.api?.csrfParams;
      if (params?.csrfToken) {
        csrfToken = params.csrfToken;
        csrfTimestamp = params.csrfTimestamp || null;
        csrfNotifyTimestamp = params.csrfNotifyTimestamp || null;
      }
    } catch {}

    // Method 2: window.__PRELOADED_STATE__
    try {
      const state = w.__PRELOADED_STATE__;
      if (state?.viewer?.user?.id) {
        userId = state.viewer.user.id;
      }
      if (state?.csrfToken) {
        csrfToken = csrfToken || state.csrfToken;
      }
    } catch {}

    // Method 3: Redux store
    try {
      const store = w.__NEXT_REDUX_STORE__ || w.__store__;
      if (store) {
        const st = store.getState?.();
        if (st?.viewer?.user?.id) userId = userId || st.viewer.user.id;
      }
    } catch {}

    // Method 4: AMP cookie
    try {
      const cookies = document.cookie.split(';').reduce((acc: any, c: string) => {
        const [k, v] = c.trim().split('=');
        acc[k] = v;
        return acc;
      }, {});

      // AMP cookie format: userId is first segment
      for (const [k, v] of Object.entries(cookies)) {
        if (k.startsWith('AMP_') && typeof v === 'string') {
          const parts = v.split('.');
          if (parts.length > 0) {
            const parsed = parseInt(parts[0], 10);
            if (parsed > 100000) userId = userId || parsed;
          }
        }
      }
    } catch {}

    // Method 5: meta tags or data attributes
    try {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta) csrfToken = csrfToken || meta.getAttribute('content');
    } catch {}

    return { csrfToken, userId };
  });

  console.log('Extracted csrfToken:', result.csrfToken || 'NOT FOUND');
  console.log('Extracted userId:', result.userId || 'NOT FOUND');

  // 6. If CSRF not found, try intercepting network requests
  if (!result.csrfToken) {
    console.log('\nCSRF not found in JS context. Trying API interception...');

    let foundCsrf: string | null = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('config') || url.includes('csrf')) {
        try {
          const body = await response.json();
          if (body.csrfToken) {
            foundCsrf = body.csrfToken;
            console.log('Found CSRF in response:', url);
          }
        } catch {}
      }
    });

    // Trigger a navigation that might fetch config
    try {
      await page.goto('https://ja.stripchat.com/user/Risa_06', { waitUntil: 'networkidle', timeout: 15000 });
    } catch {}

    await page.waitForTimeout(2000);

    if (foundCsrf) {
      result.csrfToken = foundCsrf;
      console.log('CSRF from network:', foundCsrf);
    }
  }

  // If still no CSRF, try direct JS call
  if (!result.csrfToken) {
    console.log('\nTrying alternative JS extraction...');
    const altResult = await page.evaluate(() => {
      const w = window as any;
      // Try looking at all global objects for csrf
      const keys = Object.keys(w).filter(k =>
        k.includes('csrf') || k.includes('Csrf') || k.includes('CSRF') ||
        k.includes('logger') || k.includes('Logger') ||
        k.includes('store') || k.includes('Store') || k.includes('app')
      );

      const results: Record<string, any> = {};
      for (const k of keys) {
        try {
          const v = w[k];
          if (typeof v === 'string') results[k] = v.slice(0, 50);
          else if (typeof v === 'object' && v !== null) results[k] = Object.keys(v).slice(0, 10);
        } catch {}
      }

      return results;
    });
    console.log('Alternative scan:', JSON.stringify(altResult, null, 2));
  }

  await browser.close();

  // 7. Update session in DB
  const userId = result.userId || 178845750; // Fallback to known Risa_06 userId
  console.log('\n=== Updating session ===');
  console.log('userId:', userId);
  console.log('csrfToken:', result.csrfToken ? 'found' : 'NOT FOUND - proceeding without');

  const updateData: Record<string, unknown> = {
    stripchat_user_id: String(userId),
    updated_at: new Date().toISOString(),
  };
  if (result.csrfToken) {
    updateData.csrf_token = result.csrfToken;
  }

  const { error: updateErr } = await sb
    .from('stripchat_sessions')
    .update(updateData)
    .eq('id', session.id);

  if (updateErr) {
    console.error('Update error:', updateErr.message);
  } else {
    console.log('Session updated successfully');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
