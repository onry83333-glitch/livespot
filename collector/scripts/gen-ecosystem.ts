/**
 * gen-ecosystem.ts — registered_casts + spy_casts からpm2設定を動的生成
 *
 * Usage: npx tsx scripts/gen-ecosystem.ts
 *
 * 出力: ecosystem.config.cjs (上書き)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface CastRow {
  account_id: string;
  cast_name: string;
  display_name: string | null;
  stripchat_model_id: string | null;
}

async function main() {
  console.log('Loading casts from Supabase...');

  const [regResult, spyResult] = await Promise.all([
    sb.from('registered_casts')
      .select('account_id, cast_name, display_name, stripchat_model_id')
      .eq('is_active', true),
    sb.from('spy_casts')
      .select('account_id, cast_name, display_name, stripchat_model_id')
      .eq('is_active', true),
  ]);

  if (regResult.error) throw new Error(`registered_casts: ${regResult.error.message}`);
  if (spyResult.error) throw new Error(`spy_casts: ${spyResult.error.message}`);

  const registered = (regResult.data || []) as CastRow[];
  const spyCasts = (spyResult.data || []) as CastRow[];

  console.log(`Found: ${registered.length} registered + ${spyCasts.length} spy = ${registered.length + spyCasts.length} total`);

  // Generate pm2 app definitions
  const apps: object[] = [];
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const cwd = path.resolve(__dirname, '..');

  // auth-manager: 認証一元管理プロセス（最初に起動、他のプロセスが依存）
  apps.push({
    name: 'auth-manager',
    script: 'src/auth-manager/index.ts',
    interpreter: 'node',
    interpreter_args: '--import tsx',
    cwd,
    env: {
      NODE_ENV: 'production',
    },
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',   // Playwright使用のため余裕を持つ
    log_file: `${cwd}/logs/auth-manager.log`,
    error_file: `${cwd}/logs/auth-manager-error.log`,
    out_file: `${cwd}/logs/auth-manager-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 5000,
    max_restarts: 100,
    min_uptime: '10s',
    wait_ready: true,             // pm2に準備完了を通知するまで待つ
    listen_timeout: 30000,
  });

  // coin-sync: サーバーサイドコイン同期サービス（1時間間隔）
  apps.push({
    name: 'coin-sync',
    script: 'src/coin-sync-service.ts',
    interpreter: 'node',
    interpreter_args: '--import tsx',
    cwd,
    env: {
      NODE_ENV: 'production',
    },
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    log_file: `${cwd}/logs/coin-sync.log`,
    error_file: `${cwd}/logs/coin-sync-error.log`,
    out_file: `${cwd}/logs/coin-sync-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 30000,
    max_restarts: 20,
    min_uptime: '60s',
  });

  // dm-service: DM送信常駐プロセス（キューポーリング → Stripchat API送信）
  apps.push({
    name: 'dm-service',
    script: 'src/dm-service/index.ts',
    interpreter: 'node',
    interpreter_args: '--import tsx',
    cwd,
    env: {
      NODE_ENV: 'production',
    },
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    log_file: `${cwd}/logs/dm-service.log`,
    error_file: `${cwd}/logs/dm-service-error.log`,
    out_file: `${cwd}/logs/dm-service-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 10000,
    max_restarts: 50,
    min_uptime: '30s',
    wait_ready: true,
    listen_timeout: 10000,
  });

  // daily-briefing: 日次ブリーフィング自動生成（毎朝09:00 JST = 00:00 UTC）
  apps.push({
    name: 'daily-briefing',
    script: 'src/reports/daily-briefing.ts',
    interpreter: 'node',
    interpreter_args: '--import tsx',
    cwd,
    env: {
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '8050153948',
    },
    autorestart: false,
    cron_restart: '0 0 * * *',  // 00:00 UTC = 09:00 JST
    watch: false,
    max_memory_restart: '150M',
    log_file: `${cwd}/logs/daily-briefing.log`,
    error_file: `${cwd}/logs/daily-briefing-error.log`,
    out_file: `${cwd}/logs/daily-briefing-out.log`,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  });

  for (const cast of registered) {
    apps.push({
      name: `cast-${cast.cast_name}`,
      script: 'src/single-cast.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd,
      env: {
        NODE_ENV: 'production',
        CAST_NAME: cast.cast_name,
        ACCOUNT_ID: cast.account_id,
        CAST_SOURCE: 'registered_casts',
        CAST_DISPLAY: cast.display_name || '',
        MODEL_ID: cast.stripchat_model_id || '',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      log_file: `${cwd}/logs/${cast.cast_name}.log`,
      error_file: `${cwd}/logs/${cast.cast_name}-error.log`,
      out_file: `${cwd}/logs/${cast.cast_name}-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 10000,
      max_restarts: 50,
      min_uptime: '30s',
    });
  }

  for (const cast of spyCasts) {
    apps.push({
      name: `spy-${cast.cast_name}`,
      script: 'src/single-cast.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd,
      env: {
        NODE_ENV: 'production',
        CAST_NAME: cast.cast_name,
        ACCOUNT_ID: cast.account_id,
        CAST_SOURCE: 'spy_casts',
        CAST_DISPLAY: cast.display_name || '',
        MODEL_ID: cast.stripchat_model_id || '',
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '150M',
      log_file: `${cwd}/logs/${cast.cast_name}.log`,
      error_file: `${cwd}/logs/${cast.cast_name}-error.log`,
      out_file: `${cwd}/logs/${cast.cast_name}-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 15000,
      max_restarts: 30,
      min_uptime: '30s',
    });
  }

  // Write ecosystem.config.cjs
  const configContent = `// Auto-generated by scripts/gen-ecosystem.ts — DO NOT EDIT MANUALLY
// Regenerate: npx tsx scripts/gen-ecosystem.ts
// Generated: ${new Date().toISOString()}
// Casts: ${registered.length} registered + ${spyCasts.length} spy = ${apps.length} total

module.exports = {
  apps: ${JSON.stringify(apps, null, 2).replace(/"([^"]+)":/g, '$1:')}
};
`;

  const outPath = path.join(cwd, 'ecosystem.config.cjs');
  fs.writeFileSync(outPath, configContent, 'utf-8');
  console.log(`\nWritten: ${outPath}`);
  console.log(`\nProcess list (${apps.length} processes):`);
  for (const app of apps) {
    const a = app as { name: string; env?: { CAST_SOURCE?: string } };
    const source = a.env?.CAST_SOURCE || 'service';
    console.log(`  ${a.name} (${source})`);
  }
  console.log('\nNext: pm2 start ecosystem.config.cjs');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
