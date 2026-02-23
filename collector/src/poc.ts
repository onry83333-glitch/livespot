/**
 * poc.ts — Stripchat WebSocket PoC (Centrifugo protocol)
 *
 * Tests connection to Stripchat's WebSocket with cookie-based auth.
 * The server requires Cloudflare cf_clearance cookie for access.
 *
 * Usage:
 *   npx tsx src/poc.ts --cookie "cf_clearance=xxx; __cf_bm=yyy"
 *   npx tsx src/poc.ts --cast-name Risa_06 --cookie "cf_clearance=..."
 *   npx tsx src/poc.ts --model-id 178845750 --cookie "cf_clearance=..."
 *
 * To get cookies:
 *   1. Open stripchat.com in Chrome
 *   2. DevTools > Application > Cookies > stripchat.com
 *   3. Copy cf_clearance and __cf_bm values
 *   OR: Use Chrome extension to extract cookies automatically
 *
 * Without --cookie, tries anonymous connection (likely fails with 3501).
 */

import WebSocket from 'ws';

const WS_URL = 'wss://websocket-sp-v6.stripchat.com/connection/websocket';

const CHANNELS = [
  'newChatMessage',
  'newModelEvent',
  'clearChatMessages',
  'userUpdated',
];

function parseArgs(): { modelId?: string; castName?: string; cookie?: string } {
  const args = process.argv.slice(2);
  const result: { modelId?: string; castName?: string; cookie?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model-id' && args[i + 1]) result.modelId = args[++i];
    if (args[i] === '--cast-name' && args[i + 1]) result.castName = args[++i];
    if (args[i] === '--cookie' && args[i + 1]) result.cookie = args[++i];
  }
  return result;
}

async function resolveModelId(castName: string): Promise<string | null> {
  const url = `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(castName)}/cam`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: { user?: { id?: number } } };
    const id = data.user?.user?.id;
    if (id) { console.log(`[API] ${castName} → modelId: ${id}`); return String(id); }
    return null;
  } catch { return null; }
}

let messageCount = 0;
let tipTotal = 0;
const startTime = Date.now();
function elapsed(): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

async function main(): Promise<void> {
  const args = parseArgs();
  let modelId = args.modelId;
  if (!modelId && args.castName) modelId = await resolveModelId(args.castName) ?? undefined;
  if (!modelId) {
    console.log('[INFO] No model specified. Trying Risa_06...');
    modelId = await resolveModelId('Risa_06') ?? undefined;
  }
  if (!modelId) { console.error('[FAIL] Could not resolve model ID'); process.exit(1); }

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': 'https://stripchat.com',
    'Accept-Language': 'ja,en-US;q=0.9',
  };

  if (args.cookie) {
    headers['Cookie'] = args.cookie;
    console.log(`[AUTH] Using cookies: ${args.cookie.substring(0, 50)}...`);
  } else {
    console.log('[AUTH] No cookies provided (--cookie). Will try anonymous connection.');
    console.log('[HINT] If 3501, get cf_clearance cookie from Chrome DevTools.');
  }

  console.log(`[TARGET] modelId=${modelId}`);
  console.log(`[WS] Connecting to ${WS_URL}\n`);

  const ws = new WebSocket(WS_URL, { headers });
  let msgId = 1;
  let subCount = 0;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  ws.on('open', () => {
    console.log('[WS] Connected ✓');

    // Send connect command (Centrifugo requires this first)
    const connectCmd = JSON.stringify({ connect: { token: '', name: 'js' }, id: msgId++ });
    ws.send(connectCmd);
    console.log(`[TX] ${connectCmd}`);
  });

  ws.on('message', (raw: Buffer) => {
    const text = raw.toString();
    if (text === '{}') return; // keepalive pong

    try {
      const msg = JSON.parse(text);

      // Connect response → start subscribing
      if (msg.id && msg.connect) {
        console.log(`[CONNECT OK] client=${msg.connect.client || '-'} version=${msg.connect.version || '-'}`);

        // Subscribe to channels
        for (const ch of CHANNELS) {
          const channel = `${ch}@${modelId}`;
          const sub = JSON.stringify({ subscribe: { channel }, id: msgId++ });
          ws.send(sub);
          console.log(`[TX] subscribe ${channel}`);
        }

        // Start keepalive
        keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('{}');
        }, 25000);
        return;
      }

      // Subscription OK
      if (msg.id && msg.subscribe) {
        subCount++;
        console.log(`[SUB OK] id=${msg.id} (${subCount}/${CHANNELS.length})`);
        if (subCount === CHANNELS.length) {
          console.log(`\n✅ All channels subscribed! Listening for real-time data...\n`);
        }
        return;
      }

      // Error
      if (msg.error) {
        console.error(`[ERROR] code=${msg.error.code} message=${msg.error.message}`);
        return;
      }

      // Push event
      if (msg.push?.channel) {
        messageCount++;
        const channel = msg.push.channel as string;
        const data = (msg.push.pub?.data || {}) as Record<string, unknown>;

        if (channel.includes('newChatMessage')) {
          const user = String(data.username || data.userName || '?');
          const message = String(data.message || data.text || '');
          const tokens = Number(data.tokens || data.amount || 0);
          const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });

          if (tokens > 0) {
            tipTotal += tokens;
            console.log(`${ts} 💰 ${user}: ${tokens}tk "${message.substring(0, 60)}" [total: ${tipTotal}tk]`);
          } else {
            console.log(`${ts} 💬 ${user}: ${message.substring(0, 100)}`);
          }
        } else if (channel.includes('newModelEvent')) {
          console.log(`⚡ MODEL EVENT: ${JSON.stringify(data).substring(0, 200)}`);
        } else if (channel.includes('userUpdated')) {
          const user = String(data.username || '?');
          console.log(`👤 USER: ${user} ${JSON.stringify(data).substring(0, 100)}`);
        } else if (channel.includes('clearChatMessages')) {
          console.log(`🗑️ CHAT CLEARED`);
        } else {
          console.log(`📨 ${channel}: ${JSON.stringify(data).substring(0, 200)}`);
        }
        return;
      }

      // Unknown message
      console.log(`[???] ${text.substring(0, 300)}`);
    } catch {
      console.log(`[RAW] ${text.substring(0, 200)}`);
    }
  });

  ws.on('close', (code, reason) => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    console.log(`\n[WS] Closed: code=${code} reason=${reason || '-'}`);

    if (code === 3501) {
      console.log('\n[3501] Server rejected connection. Possible causes:');
      console.log('  1. Missing or expired cf_clearance cookie');
      console.log('  2. Wrong connect command format');
      console.log('  3. IP-based rate limiting');
      console.log('\n  Fix: Get cf_clearance from browser:');
      console.log('    Chrome > stripchat.com > DevTools > Application > Cookies');
      console.log('    npx tsx src/poc.ts --cookie "cf_clearance=YOUR_VALUE"');
    }

    console.log(`\n[STATS] ${elapsed()} | ${messageCount} messages | ${tipTotal} tokens`);
  });

  ws.on('error', (err) => {
    console.error(`[WS ERROR] ${err.message}`);
  });
}

process.on('SIGINT', () => {
  console.log(`\n[STATS] ${elapsed()} | ${messageCount} messages | ${tipTotal} tokens`);
  process.exit(0);
});

main().catch((err) => { console.error('[FATAL]', err); process.exit(1); });
