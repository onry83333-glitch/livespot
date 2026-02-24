/**
 * test-playwright-auth.ts — Playwright JWT取得のスタンドアロンテスト
 *
 * Usage:
 *   npx tsx src/test-playwright-auth.ts
 *   npx tsx src/test-playwright-auth.ts --model Kyokon_King
 *   npx tsx src/test-playwright-auth.ts --headless false
 *   npx tsx src/test-playwright-auth.ts --model Risa_06 --headless shell
 */

import 'dotenv/config';
import { fetchAuthViaPlaywright } from './auth/playwright-auth.js';

function parseArgs(): { model: string; headless: boolean } {
  const args = process.argv.slice(2);
  let model = 'Risa_06';
  let headless = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) model = args[++i];
    if (args[i] === '--headless' && args[i + 1]) {
      headless = args[++i] !== 'false';
    }
  }

  return { model, headless };
}

async function main(): Promise<void> {
  const { model, headless } = parseArgs();

  console.log(`\n=== Playwright Auth Test ===`);
  console.log(`Model: ${model}`);
  console.log(`Headless: ${headless}`);
  console.log(`Username: ${process.env.STRIPCHAT_USERNAME ? 'set' : 'not set'}`);
  console.log('');

  const startTime = Date.now();
  const auth = await fetchAuthViaPlaywright({
    modelName: model,
    headless,
    username: process.env.STRIPCHAT_USERNAME || undefined,
    password: process.env.STRIPCHAT_PASSWORD || undefined,
    timeoutMs: 90_000,
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!auth) {
    console.log(`\n❌ FAILED (${elapsed}s)`);
    console.log('JWT取得に失敗しました。');
    console.log('ヒント:');
    console.log('  1. --headless false で可視モード試行');
    console.log('  2. STRIPCHAT_USERNAME/PASSWORD を .env に設定');
    console.log('  3. npx playwright install chromium が完了しているか確認');
    process.exit(1);
  }

  console.log(`\n✅ SUCCESS (${elapsed}s)`);
  console.log(`  JWT:          ${auth.jwt.substring(0, 40)}...`);
  console.log(`  cf_clearance: ${auth.cfClearance ? auth.cfClearance.substring(0, 20) + '...' : '(none)'}`);
  console.log(`  userId:       ${auth.userId || '(empty)'}`);
  console.log(`  method:       ${auth.method}`);
  console.log(`  expiresAt:    ${new Date(auth.expiresAt * 1000).toISOString()}`);

  // --- WebSocket接続テスト ---
  console.log('\n--- WS接続テスト ---');

  const { default: WebSocket } = await import('ws');
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Origin: 'https://stripchat.com',
  };
  if (auth.cfClearance) {
    headers['Cookie'] = `cf_clearance=${auth.cfClearance}`;
  }

  const ws = new WebSocket(auth.wsUrl, { headers });

  ws.on('open', () => {
    console.log('[WS] 接続OK、Centrifugo認証送信...');
    ws.send(JSON.stringify({ connect: { token: auth.jwt, name: 'js' }, id: 1 }));
  });

  ws.on('message', (raw: Buffer) => {
    const text = raw.toString().trim();
    if (text === '{}') { ws.send('{}'); return; }

    try {
      const msg = JSON.parse(text);
      if (msg.connect) {
        console.log(`[WS] ✅ 認証成功! client=${msg.connect.client}`);
        ws.close();
        process.exit(0);
      }
      if (msg.error) {
        console.log(`[WS] ❌ 認証失敗: code=${msg.error.code} ${msg.error.message}`);
        ws.close();
        process.exit(1);
      }
    } catch {
      // マルチフレームは無視
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] エラー: ${err.message}`);
    process.exit(1);
  });

  ws.on('close', (code) => {
    if (code === 3501) {
      console.log('[WS] ❌ 3501 — JWT無効またはcf_clearance不足');
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.log('[WS] タイムアウト — 応答なし');
    ws.close();
    process.exit(1);
  }, 15000);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
