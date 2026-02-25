/**
 * poc.ts — Stripchat WebSocket PoC (Centrifugo protocol)
 *
 * Tests connection to Stripchat's WebSocket with cookie-based auth.
 * The server requires Cloudflare cf_clearance cookie for access.
 *
 * Usage:
 *   npx tsx src/poc.ts                               # auto-auth (default)
 *   npx tsx src/poc.ts --cast-name Risa_06            # auto-auth + specific cast
 *   npx tsx src/poc.ts --no-auto-auth --token "JWT_TOKEN" --cookie "cf_clearance=xxx"
 *   npx tsx src/poc.ts --model-id 178845750 --token "JWT..."
 *
 * Auto-auth (default): Fetches JWT from Stripchat page/config automatically.
 * Manual: Pass --no-auto-auth with --token and --cookie flags.
 *
 * Message structure (discovered 2026-02-23):
 *   data.message.userData.username  — sender name
 *   data.message.details.body      — message text
 *   data.message.details.amount    — tip tokens
 *   data.message.type              — "text" | "tip" | ...
 *   data.message.createdAt         — ISO timestamp
 *   data.message.userData.isModel  — is performer
 *   data.message.userData.userLevel— Stripchat level
 */

import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAuth } from './auth/index.js';

const WS_URL = 'wss://websocket-sp-v6.stripchat.com/connection/websocket';

const CHANNELS = [
  'newChatMessage',
  'newModelEvent',
  'clearChatMessages',
  'userUpdated',
];

// Collected samples for docs/websocket-message-samples.json
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const samples: { channel: string; data: any; receivedAt: string }[] = [];

function parseArgs(): { modelId?: string; castName?: string; cookie?: string; token?: string; noAutoAuth?: boolean } {
  const args = process.argv.slice(2);
  const result: { modelId?: string; castName?: string; cookie?: string; token?: string; noAutoAuth?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model-id' && args[i + 1]) result.modelId = args[++i];
    if ((args[i] === '--cast-name' || args[i] === '--model') && args[i + 1]) result.castName = args[++i];
    if (args[i] === '--cookie' && args[i + 1]) result.cookie = args[++i];
    if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    if (args[i] === '--no-auto-auth') result.noAutoAuth = true;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    // API returns nested user.user.id or user.id depending on endpoint
    const id = data.user?.user?.id || data.user?.id;
    if (id) { console.log(`[API] ${castName} -> modelId: ${id}`); return String(id); }
    return null;
  } catch { return null; }
}

/** Safely extract a string from unknown value (returns '' for objects) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function str(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return ''; // object/array -> not a leaf string
}

/** Safely extract a number from unknown value */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  return 0;
}

let messageCount = 0;
let tipTotal = 0;
let pongCount = 0;
const startTime = Date.now();
function elapsed(): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/**
 * Parse a Centrifugo frame.
 * Centrifugo can send multiple JSON objects in one frame, separated by newlines.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFrame(text: string): any[] {
  const results = [];
  // Split on newline boundaries between JSON objects
  // Also handle concatenated objects without newline: }{ pattern
  const lines = text.split('\n').flatMap(line => {
    // Handle }{ without newline separator
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '{') depth++;
      else if (line[i] === '}') {
        depth--;
        if (depth === 0) {
          parts.push(line.substring(start, i + 1));
          start = i + 1;
        }
      }
    }
    return parts;
  });

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // skip unparseable chunks
    }
  }
  return results;
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

  let jwtToken = args.token || '';
  const castName = args.castName || 'Risa_06';

  // Auto-auth: fetch JWT automatically unless --no-auto-auth
  if (!args.noAutoAuth && !jwtToken) {
    console.log('[AUTH] Auto-auth: fetching JWT from Stripchat...');
    try {
      const auth = await getAuth(castName);
      jwtToken = auth.jwt;
      if (auth.cfClearance) {
        headers['Cookie'] = `cf_clearance=${auth.cfClearance}`;
        console.log(`[AUTH] cf_clearance: ${auth.cfClearance.substring(0, 20)}...`);
      }
      if (jwtToken) {
        console.log(`[AUTH] Auto-auth OK (method=${auth.method}, expires=${new Date(auth.expiresAt * 1000).toLocaleTimeString('ja-JP')})`);
        console.log(`[AUTH] JWT: ${jwtToken.substring(0, 30)}...`);
      } else {
        console.log('[AUTH] Auto-auth returned empty JWT — falling back to manual mode');
      }
    } catch (err: any) {
      console.log(`[AUTH] Auto-auth failed: ${err.message}`);
    }
  }

  if (args.cookie) {
    headers['Cookie'] = args.cookie;
    console.log(`[AUTH] Cookies (manual): ${args.cookie.substring(0, 60)}...`);
  }

  if (jwtToken) {
    console.log(`[AUTH] JWT token: ${jwtToken.substring(0, 30)}...${jwtToken.substring(jwtToken.length - 10)}`);
  } else {
    console.log('[AUTH] No JWT token. Centrifugo will reject with 3501.');
    console.log('[HINT] Run with --no-auto-auth --token "eyJ..." for manual mode');
  }

  console.log(`[TARGET] modelId=${modelId}`);
  console.log(`[WS] Connecting to ${WS_URL}\n`);

  const ws = new WebSocket(WS_URL, { headers });
  let msgId = 1;
  let subCount = 0;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  ws.on('open', () => {
    console.log('[WS] Connected');

    // Send Centrifugo connect command with JWT token
    const connectCmd = JSON.stringify({ connect: { token: jwtToken, name: 'js' }, id: msgId++ });
    ws.send(connectCmd);
    console.log(`[TX] connect (token=${jwtToken ? 'present' : 'empty'})`);
  });

  ws.on('message', (raw: Buffer) => {
    const text = raw.toString().trim();

    // Server ping -> respond with pong immediately
    if (text === '{}') {
      pongCount++;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('{}');
      }
      return;
    }

    // Parse potentially multi-JSON frame
    const messages = parseFrame(text);

    for (const msg of messages) {
      // Connect response -> start subscribing
      if (msg.id && msg.connect) {
        const ping = msg.connect.ping || '-';
        console.log(`[CONNECT OK] client=${msg.connect.client || '-'} version=${msg.connect.version || '-'} ping=${ping}s`);

        // Subscribe to channels
        for (const ch of CHANNELS) {
          const channel = `${ch}@${modelId}`;
          const sub = JSON.stringify({ subscribe: { channel }, id: msgId++ });
          ws.send(sub);
          console.log(`[TX] subscribe ${channel}`);
        }

        // Client-side keepalive (backup — server pong response is primary)
        keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('{}');
        }, 25000);
        continue;
      }

      // Subscription OK
      if (msg.id && msg.subscribe) {
        subCount++;
        console.log(`[SUB OK] id=${msg.id} (${subCount}/${CHANNELS.length})`);
        if (subCount === CHANNELS.length) {
          console.log(`\nAll channels subscribed. Listening for real-time data...\n`);
        }
        continue;
      }

      // Error
      if (msg.error) {
        console.error(`[ERROR] code=${msg.error.code} message=${msg.error.message}`);
        continue;
      }

      // Push event
      if (msg.push?.channel) {
        messageCount++;
        const channel = msg.push.channel as string;
        const data = msg.push.pub?.data;
        const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });

        // First 10 messages: dump full JSON for schema discovery
        if (messageCount <= 10) {
          console.log(`\n--- [MSG #${messageCount}] channel=${channel} ---`);
          console.log(JSON.stringify(data, null, 2));
          console.log('---');

          // Collect sample
          samples.push({ channel, data, receivedAt: new Date().toISOString() });
        }

        if (channel.includes('newChatMessage') && data) {
          // Extract from discovered nested structure:
          //   data.message.userData.username
          //   data.message.details.body
          //   data.message.details.amount
          //   data.message.type
          const m = data.message;
          const user = str(m?.userData?.username) || str(m?.userData?.screenName) || str(data.username) || '?';
          const body = str(m?.details?.body) || str(m?.details?.text) || str(data.message) || '';
          const tokens = num(m?.details?.amount) || num(data.tokens) || 0;
          const msgType = str(m?.type) || str(data.type) || '';
          const isModel = m?.userData?.isModel === true;
          const level = num(m?.userData?.userRanking?.level) || num(m?.userData?.userLevel);
          const league = str(m?.userData?.userRanking?.league);
          const isKing = m?.additionalData?.isKing === true;
          const isKnight = m?.additionalData?.isKnight === true;

          // Build badges
          const badges: string[] = [];
          if (isModel) badges.push('MODEL');
          if (isKing) badges.push('KING');
          if (isKnight) badges.push('KNIGHT');
          if (league) badges.push(league);
          if (level > 0) badges.push(`Lv${level}`);
          const badgeStr = badges.length > 0 ? ` [${badges.join(',')}]` : '';

          if (tokens > 0) {
            tipTotal += tokens;
            console.log(`${ts} TIP ${user}${badgeStr}: ${tokens}tk -- "${body.substring(0, 60)}" [total: ${tipTotal}tk]`);
          } else if (body) {
            console.log(`${ts} CHAT ${user}${badgeStr}: ${body.substring(0, 100)}${msgType && msgType !== 'text' ? ` (${msgType})` : ''}`);
          } else {
            console.log(`${ts} RAW ${user}${badgeStr}: ${JSON.stringify(data).substring(0, 200)}`);
          }
        } else if (channel.includes('newModelEvent')) {
          const eventType = str(data?.event) || str(data?.type) || 'unknown';
          console.log(`${ts} EVENT ${eventType}: ${JSON.stringify(data).substring(0, 200)}`);
        } else if (channel.includes('userUpdated')) {
          const user = str(data?.username) || str(data?.userName) || '?';
          console.log(`${ts} USER ${user}: ${JSON.stringify(data).substring(0, 150)}`);
        } else if (channel.includes('clearChatMessages')) {
          console.log(`${ts} CHAT CLEARED`);
        } else {
          console.log(`${ts} PUSH ${channel}: ${JSON.stringify(data).substring(0, 200)}`);
        }
        continue;
      }

      // Unknown message
      console.log(`[???] ${JSON.stringify(msg).substring(0, 300)}`);
    }
  });

  ws.on('close', (code, reason) => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    console.log(`\n[WS] Closed: code=${code} reason=${reason || '-'}`);

    if (code === 3501) {
      console.log('\n[3501] Server rejected connection. Causes:');
      console.log('  1. Missing or expired JWT token (most likely)');
      console.log('  2. Missing or expired cf_clearance cookie');
      console.log('  3. IP-based rate limiting');
      console.log('\n  Fix: Get JWT + cookies from browser:');
      console.log('    1. Chrome > stripchat.com > open any model page');
      console.log('    2. DevTools > Network > WS > click the websocket');
      console.log('    3. Messages tab > first sent frame > copy token value');
      console.log('    4. Application > Cookies > copy cf_clearance');
      console.log('    npx tsx src/poc.ts --token "eyJ..." --cookie "cf_clearance=..."');
    }

    if (code === 3012) {
      console.log('\n[3012] No pong — server did not receive keepalive response.');
      console.log(`  Pongs sent: ${pongCount}`);
    }

    console.log(`\n[STATS] ${elapsed()} | ${messageCount} messages | ${tipTotal} tokens | ${pongCount} pongs`);

    // Save samples if we collected any
    if (samples.length > 0) {
      saveSamples();
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS ERROR] ${err.message}`);
  });
}

function saveSamples(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const docsDir = join(__dirname, '..', 'docs');
  if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
  const filePath = join(docsDir, 'websocket-message-samples.json');
  writeFileSync(filePath, JSON.stringify(samples, null, 2), 'utf-8');
  console.log(`[SAVED] ${samples.length} samples -> ${filePath}`);
}

process.on('SIGINT', () => {
  console.log(`\n[STATS] ${elapsed()} | ${messageCount} messages | ${tipTotal} tokens | ${pongCount} pongs`);
  if (samples.length > 0) saveSamples();
  process.exit(0);
});

main().catch((err) => { console.error('[FATAL]', err); process.exit(1); });
