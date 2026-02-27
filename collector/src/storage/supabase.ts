import { getSupabase, BATCH_CONFIG } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('storage');

// ----- Batch buffer -----
interface BatchItem {
  table: string;
  row: Record<string, unknown>;
  onConflict?: string;
}

let buffer: BatchItem[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startBatchFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushBuffer, BATCH_CONFIG.flushIntervalMs);
  log.info(`Batch flush started (interval=${BATCH_CONFIG.flushIntervalMs}ms, max=${BATCH_CONFIG.maxSize})`);
}

export function stopBatchFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Flush remaining
  if (buffer.length > 0) {
    flushBuffer();
  }
}

export function enqueue(table: string, row: Record<string, unknown>, onConflict?: string): void {
  buffer.push({ table, row, onConflict });
  if (buffer.length >= BATCH_CONFIG.maxSize) {
    flushBuffer();
  }
}

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0) return;

  const items = buffer.splice(0);
  log.debug(`Flushing ${items.length} rows`);

  // Group by table+onConflict
  const groups = new Map<string, { table: string; rows: Record<string, unknown>[]; onConflict?: string }>();

  for (const item of items) {
    const key = `${item.table}|${item.onConflict || ''}`;
    if (!groups.has(key)) {
      groups.set(key, { table: item.table, rows: [], onConflict: item.onConflict });
    }
    groups.get(key)!.rows.push(item.row);
  }

  const sb = getSupabase();

  for (const [, group] of groups) {
    try {
      if (group.onConflict) {
        const { error } = await sb
          .from(group.table)
          .upsert(group.rows, { onConflict: group.onConflict, ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const { error } = await sb.from(group.table).insert(group.rows);
        if (error) throw error;
      }
      log.info(`Wrote ${group.rows.length} rows to ${group.table}`);
    } catch (err) {
      log.error(`Failed to write ${group.rows.length} rows to ${group.table}`, err);
      // Re-enqueue on failure (with limit to avoid infinite loop)
      if (buffer.length < BATCH_CONFIG.maxSize * 2) {
        for (const row of group.rows) {
          buffer.push({ table: group.table, row, onConflict: group.onConflict });
        }
        log.warn(`Re-enqueued ${group.rows.length} rows for retry`);
      }
    }
  }
}

// ----- Direct writes (no batching) -----

export async function upsertViewers(
  accountId: string,
  castName: string,
  sessionId: string | null,
  viewers: { userName: string; userIdStripchat: string; league: string; level: number; isFanClub: boolean }[],
): Promise<number> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  let upserted = 0;

  for (const v of viewers) {
    try {
      // Check existing
      let query = sb
        .from('spy_viewers')
        .select('id, visit_count')
        .eq('account_id', accountId)
        .eq('cast_name', castName)
        .eq('user_name', v.userName);

      if (sessionId) {
        query = query.eq('session_id', sessionId);
      } else {
        query = query.is('session_id', null);
      }

      const { data: existing } = await query.limit(1);

      if (existing && existing.length > 0) {
        await sb
          .from('spy_viewers')
          .update({ last_seen_at: now, visit_count: existing[0].visit_count + 1 })
          .eq('id', existing[0].id);
      } else {
        await sb.from('spy_viewers').insert({
          account_id: accountId,
          cast_name: castName,
          session_id: sessionId,
          user_name: v.userName,
          user_id_stripchat: v.userIdStripchat,
          league: v.league,
          level: v.level,
          is_fan_club: v.isFanClub,
          first_seen_at: now,
          last_seen_at: now,
          visit_count: 1,
        });
      }
      upserted++;
    } catch (err) {
      log.error(`Failed to upsert viewer ${v.userName}`, err);
    }
  }

  return upserted;
}

// ----- Session lifecycle -----

export async function openSession(
  accountId: string,
  castName: string,
  sessionId: string,
  startedAt: string,
): Promise<string> {
  const sb = getSupabase();
  const { error } = await sb.from('sessions').insert({
    session_id: sessionId,
    account_id: accountId,
    title: castName,
    cast_name: castName,
    started_at: startedAt,
  });
  if (error) {
    // 部分ユニーク制約 idx_sessions_one_active_per_cast で弾かれた場合、
    // 既存のアクティブセッションIDを返す（複数インスタンス起動対策）
    if (error.code === '23505') {
      const { data: existing } = await sb
        .from('sessions')
        .select('session_id')
        .eq('cast_name', castName)
        .eq('account_id', accountId)
        .is('ended_at', null)
        .limit(1)
        .single();
      if (existing) {
        log.info(`Session already active for ${castName}, reusing ${existing.session_id}`);
        return existing.session_id;
      }
      log.debug(`Session duplicate but no active found: ${sessionId}`);
    } else {
      log.error(`Failed to open session ${sessionId}`, error);
    }
  } else {
    log.info(`Session opened: ${castName} (${sessionId})`);
  }
  return sessionId;
}

export async function closeSession(
  sessionId: string,
  messageCount: number,
  tipTotal: number,
  peakViewers: number,
): Promise<void> {
  if (!sessionId) return;
  const sb = getSupabase();
  const endedAt = new Date().toISOString();

  // 全カラムUPDATEを試行
  const { error } = await sb
    .from('sessions')
    .update({
      ended_at: endedAt,
      total_messages: messageCount,
      total_tokens: tipTotal,
      peak_viewers: peakViewers,
    })
    .eq('session_id', sessionId);

  if (error) {
    // PostgRESTスキーマキャッシュ問題の場合、ended_atだけでも記録する
    if (error.message?.includes('schema cache')) {
      log.warn(`Session ${sessionId}: schema cache error — fallback to ended_at only`);
      const { error: fallbackErr } = await sb
        .from('sessions')
        .update({ ended_at: endedAt })
        .eq('session_id', sessionId);

      if (fallbackErr) {
        log.error(`Session ${sessionId}: fallback update also failed`, fallbackErr);
      } else {
        log.info(`Session closed (partial): ${sessionId} (ended_at set, stats skipped — apply migration 086)`);
      }
    } else {
      log.error(`Failed to close session ${sessionId}`, error);
    }
  } else {
    log.info(`Session closed: ${sessionId} (${messageCount} msgs, ${tipTotal}tk, peak=${peakViewers})`);
  }
}

/** Collector起動時に呼び出す: 古い未閉鎖セッションをDBサイドで一括クローズ */
export async function closeOrphanSessions(staleHours = 6): Promise<number> {
  const sb = getSupabase();
  const { data, error } = await sb.rpc('close_orphan_sessions', {
    p_stale_threshold: `${staleHours} hours`,
  });
  if (error) {
    log.error('Failed to close orphan sessions via RPC', error);
    return 0;
  }
  return data as number;
}

/** 特定キャストの未閉鎖セッションをクローズ（起動時 first-poll で使用） */
export async function closeStaleSessionsForCast(
  accountId: string,
  castName: string,
): Promise<number> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('sessions')
    .update({ ended_at: now })
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .is('ended_at', null)
    .select('session_id');
  if (error) {
    log.error(`Failed to close stale sessions for ${castName}`, error);
    return 0;
  }
  return data?.length ?? 0;
}

export async function updateCastOnlineStatus(
  table: 'registered_casts' | 'spy_casts',
  accountId: string,
  castName: string,
  isOnline: boolean,
): Promise<void> {
  const sb = getSupabase();
  const updates: Record<string, unknown> = {};

  if (isOnline) {
    updates.last_seen_online = new Date().toISOString();
    updates.is_extinct = false;
    updates.extinct_at = null;
  }

  if (Object.keys(updates).length === 0) return;

  const { error } = await sb
    .from(table)
    .update(updates)
    .eq('account_id', accountId)
    .eq('cast_name', castName);

  if (error) {
    log.error(`Failed to update ${table} status for ${castName}`, error);
  }
}
