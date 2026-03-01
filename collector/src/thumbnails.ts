/**
 * thumbnails.ts — Stripchat CDN サムネイル取得 + Supabase Storage 保存
 *
 * CDN URL: https://img.strpst.com/thumbs/{timestamp}/{modelId}_webp
 * Storage: screenshots/{castName}/{YYYY-MM-DD}/{sessionId}_{timestamp}.webp
 * DB:      cast_screenshots テーブル
 */

import { getSupabase } from './config.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('thumbnails');

const THUMBNAIL_CDN = 'https://img.strpst.com/thumbs';
const STORAGE_BUCKET = 'screenshots';
const CAPTURE_INTERVAL_MS = 60 * 1000; // 60秒

let captureTimer: ReturnType<typeof setInterval> | null = null;

export interface OnlineCast {
  castName: string;
  modelId: string;
  accountId: string;
  sessionId: string | null;
  source: 'registered_casts' | 'spy_casts';
}

/**
 * CDN からサムネイル画像を取得する
 * URL: https://img.strpst.com/thumbs/{timestamp}/{modelId}_webp
 */
async function fetchThumbnailFromCdn(modelId: string): Promise<{ buffer: Buffer; cdnUrl: string } | null> {
  const timestamp = Math.floor(Date.now() / 1000);
  const cdnUrl = `${THUMBNAIL_CDN}/${timestamp}/${modelId}_webp`;

  try {
    const res = await fetch(cdnUrl, {
      headers: {
        'Accept': 'image/webp,image/*,*/*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!res.ok) {
      log.warn(`CDN fetch failed: ${cdnUrl} → ${res.status}`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) {
      log.warn(`CDN returned non-image: ${contentType} for ${cdnUrl}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 1000) {
      log.warn(`CDN returned tiny image (${buffer.length} bytes) — likely placeholder`);
      return null;
    }

    return { buffer, cdnUrl };
  } catch (err) {
    log.error(`CDN fetch error for model ${modelId}:`, err);
    return null;
  }
}

/**
 * Supabase Storage にアップロードし、cast_screenshots テーブルに記録する
 */
async function uploadAndRecord(
  cast: OnlineCast,
  buffer: Buffer,
  cdnUrl: string,
): Promise<boolean> {
  const sb = getSupabase();
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timestamp = Math.floor(now.getTime() / 1000);
  const sessionPart = cast.sessionId ? cast.sessionId.substring(0, 8) : 'nosession';
  const storagePath = `${cast.castName}/${dateStr}/${sessionPart}_${timestamp}.webp`;

  // 1. Upload to Storage
  const { error: uploadError } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: 'image/webp',
      upsert: false,
    });

  if (uploadError) {
    log.error(`Storage upload failed for ${cast.castName}: ${uploadError.message}`);
    return false;
  }

  // 2. Get public URL
  const { data: urlData } = sb.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const publicUrl = urlData?.publicUrl || '';

  // 3. Insert into cast_screenshots
  const thumbnailType = cast.source === 'registered_casts' ? 'auto' : 'spy';
  const { error: dbError } = await sb.from('cast_screenshots').insert({
    account_id: cast.accountId,
    cast_name: cast.castName,
    model_id: cast.modelId,
    session_id: cast.sessionId,
    captured_at: now.toISOString(),
    image_url: cdnUrl,
    storage_path: storagePath,
    thumbnail_type: thumbnailType,
    is_live: true,
    metadata: {
      source: 'collector-cdn',
      public_url: publicUrl,
      size_bytes: buffer.length,
    },
  });

  if (dbError) {
    log.error(`DB insert failed for ${cast.castName}: ${dbError.message}`);
    return false;
  }

  log.info(`Thumbnail saved: ${cast.castName} (${buffer.length} bytes) → ${storagePath}`);
  return true;
}

/**
 * 1キャスト分のサムネイルを取得・保存する
 */
export async function captureThumbnail(cast: OnlineCast): Promise<boolean> {
  const result = await fetchThumbnailFromCdn(cast.modelId);
  if (!result) return false;
  return uploadAndRecord(cast, result.buffer, result.cdnUrl);
}

/**
 * 定期サムネイル取得を開始する
 * @param getOnlineCasts オンラインキャスト一覧を返す関数
 */
export function startThumbnailCapture(getOnlineCasts: () => OnlineCast[]): void {
  if (captureTimer) return;

  const runCapture = async () => {
    const casts = getOnlineCasts();
    if (casts.length === 0) return;

    log.debug(`Thumbnail capture: ${casts.length} online casts`);

    for (const cast of casts) {
      try {
        await captureThumbnail(cast);
      } catch (err) {
        log.error(`Thumbnail capture error for ${cast.castName}:`, err);
      }
    }
  };

  captureTimer = setInterval(runCapture, CAPTURE_INTERVAL_MS);
  log.info(`Thumbnail capture started (interval=${CAPTURE_INTERVAL_MS / 1000}s)`);
}

export function stopThumbnailCapture(): void {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
    log.info('Thumbnail capture stopped');
  }
}
