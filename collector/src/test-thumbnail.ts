/**
 * test-thumbnail.ts — サムネイル取得テスト
 *
 * Usage: npx tsx src/test-thumbnail.ts
 *
 * 1. registered_casts + spy_casts からオンラインキャストを探す
 * 2. 見つからなければ既知のmodelIdでCDN取得だけテスト
 * 3. Supabase Storage にアップロード + cast_screenshots に記録
 */

import 'dotenv/config';
import { getSupabase, loadTargets } from './config.js';
import { pollCastStatus } from './ws-client.js';
import { captureThumbnail, type OnlineCast } from './thumbnails.js';
import { createLogger, setLogLevel } from './utils/logger.js';

setLogLevel('debug');
const log = createLogger('test-thumbnail');

async function ensureStorageBucket(): Promise<void> {
  const sb = getSupabase();
  const { data: buckets } = await sb.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === 'screenshots');

  if (!exists) {
    log.info('Creating "screenshots" storage bucket...');
    const { error } = await sb.storage.createBucket('screenshots', {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024, // 5MB
    });
    if (error) {
      log.error('Failed to create bucket:', error);
      throw error;
    }
    log.info('Bucket "screenshots" created');
  } else {
    log.info('Bucket "screenshots" already exists');
  }
}

async function main(): Promise<void> {
  log.info('=== Thumbnail Capture Test ===');

  // 0. Ensure storage bucket exists
  await ensureStorageBucket();

  // 1. Load targets
  const targets = await loadTargets();
  log.info(`Loaded ${targets.length} targets`);

  // 2. Find an online cast with modelId
  let testCast: OnlineCast | null = null;

  for (const t of targets) {
    log.info(`Checking ${t.castName} (modelId=${t.stripchatModelId || 'unknown'})...`);
    const result = await pollCastStatus(t.castName);

    const isOnline = result.status === 'public' || result.status === 'private' || result.status === 'p2p';
    const modelId = result.modelId || t.stripchatModelId;

    if (modelId) {
      testCast = {
        castName: t.castName,
        modelId,
        accountId: t.accountId,
        sessionId: null,
        source: t.source,
      };

      if (isOnline) {
        log.info(`Found ONLINE cast: ${t.castName} (modelId=${modelId})`);
        break;
      } else {
        log.info(`Found OFFLINE cast with modelId: ${t.castName} (modelId=${modelId}) — will try CDN anyway`);
        // Don't break — keep looking for online cast
      }
    }
  }

  if (!testCast) {
    log.error('No cast with modelId found. Cannot test thumbnail capture.');
    process.exit(1);
  }

  // 3. Capture thumbnail
  log.info(`Capturing thumbnail for ${testCast.castName} (modelId=${testCast.modelId})...`);
  const success = await captureThumbnail(testCast);

  if (success) {
    log.info('SUCCESS: Thumbnail captured and saved to Supabase Storage + cast_screenshots');

    // Verify: read back from DB
    const sb = getSupabase();
    const { data, error } = await sb
      .from('cast_screenshots')
      .select('id, cast_name, model_id, storage_path, image_url, thumbnail_type, captured_at')
      .eq('cast_name', testCast.castName)
      .order('captured_at', { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      log.info('Verified DB record:');
      log.info(JSON.stringify(data[0], null, 2));
    } else {
      log.warn('DB verification failed:', error);
    }
  } else {
    log.error('FAILED: Thumbnail capture returned false');
    log.info('Note: CDN may return empty for offline casts. Try when a cast is live.');
    process.exit(1);
  }
}

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
