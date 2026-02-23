import { getSupabase } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('spy-profiles');

/**
 * spy_user_profiles accumulation
 * Tracks user activity across casts — league, level, visit frequency
 * Designed for future table (spy_user_profiles); currently writes to spy_viewers
 */

export interface UserProfile {
  userName: string;
  userIdStripchat: string;
  league: string;
  level: number;
  isFanClub: boolean;
  castsVisited: string[];
  totalVisits: number;
  lastSeenAt: string;
}

// In-memory accumulator
const profiles = new Map<string, UserProfile>();

export function accumulateViewer(
  castName: string,
  viewer: { userName: string; userIdStripchat: string; league: string; level: number; isFanClub: boolean },
): void {
  const existing = profiles.get(viewer.userName);
  const now = new Date().toISOString();

  if (existing) {
    // Update with latest info
    existing.league = viewer.league || existing.league;
    existing.level = Math.max(viewer.level, existing.level);
    existing.isFanClub = viewer.isFanClub || existing.isFanClub;
    existing.lastSeenAt = now;
    existing.totalVisits++;
    if (!existing.castsVisited.includes(castName)) {
      existing.castsVisited.push(castName);
    }
  } else {
    profiles.set(viewer.userName, {
      userName: viewer.userName,
      userIdStripchat: viewer.userIdStripchat,
      league: viewer.league,
      level: viewer.level,
      isFanClub: viewer.isFanClub,
      castsVisited: [castName],
      totalVisits: 1,
      lastSeenAt: now,
    });
  }
}

export function getProfileCount(): number {
  return profiles.size;
}

export function getProfile(userName: string): UserProfile | undefined {
  return profiles.get(userName);
}

/** Flush accumulated profiles to paid_users (enrichment) */
export async function flushProfiles(accountId: string): Promise<number> {
  if (profiles.size === 0) return 0;

  const sb = getSupabase();
  let updated = 0;

  for (const [, profile] of profiles) {
    try {
      // Update paid_users with latest level info if they exist
      const { data } = await sb
        .from('paid_users')
        .select('id, user_level')
        .eq('account_id', accountId)
        .eq('user_name', profile.userName)
        .limit(1);

      if (data && data.length > 0 && profile.level > (data[0].user_level || 0)) {
        await sb
          .from('paid_users')
          .update({ user_level: profile.level })
          .eq('id', data[0].id);
        updated++;
      }
    } catch (err) {
      log.error(`Failed to flush profile ${profile.userName}`, err);
    }
  }

  if (updated > 0) {
    log.info(`Flushed ${updated} profile updates to paid_users`);
  }

  return updated;
}
