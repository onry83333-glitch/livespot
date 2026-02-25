/**
 * evaluators/segment-upgrade.ts — UC-036: Segment upgrade detection
 *
 * Scheduled: Compare current segments against a snapshot taken on previous run.
 * Detects upgrades matching tracked patterns (e.g., "S5->S4", "S4->S1").
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:segment-upgrade');

// Snapshot: accountId -> Map<"castName:userName", segmentId>
const segmentSnapshots = new Map<string, Map<string, string>>();
const snapshotInitialized = new Set<string>();

/**
 * Initialize segment snapshot for an account (first run: populate without firing).
 */
export async function initSegmentSnapshot(accountId: string): Promise<void> {
  if (snapshotInitialized.has(accountId)) return;

  const sb = getSupabase();

  // Get registered casts
  const { data: casts } = await sb
    .from('registered_casts')
    .select('cast_name')
    .eq('account_id', accountId)
    .eq('is_active', true);

  if (!casts || casts.length === 0) {
    snapshotInitialized.add(accountId);
    return;
  }

  const snapshot = new Map<string, string>();

  for (const cast of casts) {
    const { data: segments } = await sb.rpc('get_user_segments', {
      p_account_id: accountId,
      p_cast_name: cast.cast_name,
    });

    if (!segments) continue;

    for (const seg of segments) {
      if (!seg.users) continue;
      for (const user of seg.users) {
        snapshot.set(`${cast.cast_name}:${user.user_name}`, seg.segment_id);
      }
    }
  }

  segmentSnapshots.set(accountId, snapshot);
  snapshotInitialized.add(accountId);
  log.info(`Segment snapshot initialized for ${accountId}: ${snapshot.size} users`);
}

export async function evaluateSegmentUpgrade(
  trigger: DmTrigger,
  accountId: string,
): Promise<EvaluationResult> {
  const sb = getSupabase();
  const trackedUpgrades = (trigger.condition_config.track_upgrades as string[]) || [];
  if (trackedUpgrades.length === 0) {
    return { shouldFire: false, targets: [], reason: 'no track_upgrades configured' };
  }

  // Build upgrade set for fast lookup: "S5->S4" format
  const upgradeSet = new Set(trackedUpgrades);

  // Ensure snapshot exists
  if (!snapshotInitialized.has(accountId)) {
    await initSegmentSnapshot(accountId);
    return { shouldFire: false, targets: [], reason: 'first run — snapshot initialized' };
  }

  const previousSnapshot = segmentSnapshots.get(accountId) || new Map();

  // Get registered casts
  const { data: casts } = await sb
    .from('registered_casts')
    .select('cast_name')
    .eq('account_id', accountId)
    .eq('is_active', true);

  if (!casts || casts.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const targets: TriggerContext[] = [];
  const newSnapshot = new Map<string, string>();

  for (const cast of casts) {
    const { data: segments } = await sb.rpc('get_user_segments', {
      p_account_id: accountId,
      p_cast_name: cast.cast_name,
    });

    if (!segments) continue;

    for (const seg of segments) {
      if (!seg.users) continue;
      for (const user of seg.users) {
        const key = `${cast.cast_name}:${user.user_name}`;
        const currentSegment = seg.segment_id;
        newSnapshot.set(key, currentSegment);

        const previousSegment = previousSnapshot.get(key);
        if (previousSegment && previousSegment !== currentSegment) {
          const transition = `${previousSegment}->${currentSegment}`;
          if (upgradeSet.has(transition)) {
            targets.push({
              accountId,
              castName: cast.cast_name,
              userName: user.user_name,
              segment: currentSegment,
              previousSegment,
              totalTokens: user.total_coins,
            });
          }
        }
      }
    }
  }

  // Update snapshot
  segmentSnapshots.set(accountId, newSnapshot);

  if (targets.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  log.info(`segment_upgrade: ${targets.length} upgrades detected`);
  return { shouldFire: true, targets };
}
