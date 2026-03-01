import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from './utils/logger.js';

const log = createLogger('config');

// ----- Environment -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// ----- Supabase admin client (service role — bypasses RLS) -----
let _sb: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_sb) {
    _sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    log.info('Supabase admin client initialized');
  }
  return _sb;
}

// ----- Stripchat auth config -----
export const AUTH_CONFIG = {
  jwt: process.env.STRIPCHAT_JWT || '',
  cfClearance: process.env.STRIPCHAT_CF_CLEARANCE || '',
  autoRefresh: process.env.AUTH_AUTO_REFRESH !== 'false',
};

// ----- Playwright auth config -----
function parseHeadless(val: string | undefined): boolean {
  if (val === 'false') return false;
  return true; // default = new headless mode (Cloudflare対策)
}

export const PLAYWRIGHT_CONFIG = {
  timeoutMs: parseInt(process.env.PLAYWRIGHT_TIMEOUT || '60000', 10),
  headless: parseHeadless(process.env.PLAYWRIGHT_HEADLESS),
  username: process.env.STRIPCHAT_USERNAME || '',
  password: process.env.STRIPCHAT_PASSWORD || '',
};

// ----- Polling config -----
export const POLL_INTERVALS = {
  statusSec: parseInt(process.env.STATUS_POLL_INTERVAL || '180', 10),
  viewerSec: parseInt(process.env.VIEWER_POLL_INTERVAL || '60', 10),
};

export const BATCH_CONFIG = {
  flushIntervalMs: parseInt(process.env.BATCH_FLUSH_INTERVAL || '30000', 10),
  maxSize: parseInt(process.env.BATCH_MAX_SIZE || '500', 10),
};

// ----- Stripchat API endpoints -----
export const STRIPCHAT = {
  statusUrl: (castName: string) =>
    `https://ja.stripchat.com/api/front/v2/models/username/${encodeURIComponent(castName)}/cam`,
  viewerUrl: (castName: string) =>
    `https://stripchat.com/api/front/v2/models/username/${encodeURIComponent(castName)}/members`,
};

// ----- Target cast type -----
export interface CastTarget {
  accountId: string;
  castName: string;
  displayName: string | null;
  isActive: boolean;
  autoMonitor: boolean;
  stripchatModelId: string | null;
  source: 'registered_casts' | 'spy_casts';
}

// ----- Load monitoring targets from Supabase -----
export async function loadTargets(): Promise<CastTarget[]> {
  const sb = getSupabase();

  const [regResult, spyResult] = await Promise.all([
    sb
      .from('registered_casts')
      .select('account_id, cast_name, display_name, is_active, stripchat_model_id')
      .eq('is_active', true),
    sb
      .from('spy_casts')
      .select('account_id, cast_name, display_name, is_active, auto_monitor, stripchat_model_id')
      .eq('is_active', true),
  ]);

  if (regResult.error) {
    log.error('registered_casts取得失敗', regResult.error);
  }
  if (spyResult.error) {
    log.error('spy_casts取得失敗（他社キャスト監視が無効）', spyResult.error);
  }

  const targets: CastTarget[] = [];

  for (const r of regResult.data || []) {
    targets.push({
      accountId: r.account_id,
      castName: r.cast_name,
      displayName: r.display_name,
      isActive: r.is_active,
      autoMonitor: true, // registered casts always monitored
      stripchatModelId: r.stripchat_model_id,
      source: 'registered_casts',
    });
  }

  for (const r of spyResult.data || []) {
    targets.push({
      accountId: r.account_id,
      castName: r.cast_name,
      displayName: r.display_name,
      isActive: r.is_active,
      autoMonitor: r.auto_monitor ?? false,
      stripchatModelId: r.stripchat_model_id,
      source: 'spy_casts',
    });
  }

  const regCount = regResult.data?.length || 0;
  const spyCount = spyResult.data?.length || 0;
  log.info(`Loaded ${targets.length} targets (自社=${regCount}, 他社SPY=${spyCount})`);
  if (spyCount === 0) {
    log.warn('他社キャスト(SPY)が0件 — spy_castsテーブルにis_active=trueのレコードがあるか確認');
  }
  return targets;
}
