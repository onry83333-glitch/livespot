/**
 * Test: Find Stripchat API endpoint for Centrifugo JWT
 * Uses session cookie from stripchat_sessions
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Get session cookie from DB
const { data } = await sb.from('stripchat_sessions')
  .select('session_cookie, cookies_json')
  .eq('is_valid', true)
  .limit(1)
  .single();

if (!data) { console.error('No valid session'); process.exit(1); }

const sessionCookie = data.session_cookie;
const cookiesJson = data.cookies_json as Record<string, string> | null;

// Build cookie string
let cookieStr = `stripchat_com_sessionId=${sessionCookie}`;
if (cookiesJson) {
  for (const [k, v] of Object.entries(cookiesJson)) {
    if (k !== 'stripchat_com_sessionId') {
      cookieStr += `; ${k}=${v}`;
    }
  }
}

console.log(`Cookie: ${cookieStr.substring(0, 80)}...`);

const headers = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Cookie: cookieStr,
};

// Try candidate endpoints
const endpoints = [
  'https://stripchat.com/api/front/v2/config',
  'https://stripchat.com/api/front/config',
  'https://stripchat.com/api/front/v2/user/me',
  'https://stripchat.com/api/front/user/me',
  'https://stripchat.com/api/front/v2/centrifugo/token',
  'https://stripchat.com/api/front/v2/websocket/token',
  'https://stripchat.com/api/front/v2/auth/token',
];

for (const url of endpoints) {
  try {
    const res = await fetch(url, { headers, redirect: 'manual' });
    const status = res.status;
    const body = status === 200 ? await res.text() : '';
    const hasToken = body.includes('token') || body.includes('jwt') || body.includes('centrifug');
    const hasEyJ = body.includes('eyJ');
    console.log(`\n${status} ${url}`);
    if (hasToken) console.log('  >> Contains "token" reference');
    if (hasEyJ) console.log('  >> Contains JWT (eyJ...)!');
    if (status === 200 && body.length < 2000) {
      console.log(`  Body: ${body.substring(0, 500)}`);
    } else if (status === 200) {
      console.log(`  Body length: ${body.length} chars`);
      // Search for token fields
      const tokenMatch = body.match(/"(centrifugoToken|wsToken|subscriberToken|connectionToken|token)"\s*:\s*"([^"]+)"/);
      if (tokenMatch) {
        console.log(`  FOUND: ${tokenMatch[1]} = ${tokenMatch[2].substring(0, 60)}...`);
      }
    }
  } catch (err: unknown) {
    console.log(`ERR ${url}: ${(err as Error).message}`);
  }
}

process.exit(0);
