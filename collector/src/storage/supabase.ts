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
