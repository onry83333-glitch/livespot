/**
 * Viewer list parser
 * Parses Stripchat /api/front/v2/models/username/{name}/members response
 *
 * v2 API response format:
 * {
 *   "members": [
 *     {
 *       "user": {
 *         "id": 8445194,
 *         "username": "you000128",
 *         "userRanking": { "league": "silver", "level": 24 },
 *         "isGreen": true,
 *         "isUltimate": false
 *       },
 *       "fanClubTier": null,
 *       "fanClubNumberMonthsOfSubscribed": 0
 *     }
 *   ]
 * }
 *
 * Also supports legacy /groupShow/members format:
 * { "members": [{ "username": "...", "id": ..., "league": "...", "level": ... }] }
 */

export interface ViewerEntry {
  userName: string;
  userIdStripchat: string;
  league: string;
  level: number;
  isFanClub: boolean;
}

export function parseViewerList(apiResponse: unknown): ViewerEntry[] {
  if (!apiResponse || typeof apiResponse !== 'object') return [];

  const data = apiResponse as Record<string, unknown>;

  // Response format: { members: [...] } or direct array
  const members = (data.members || data.users || data.data || data) as unknown[];
  if (!Array.isArray(members)) return [];

  const viewers: ViewerEntry[] = [];

  for (const m of members) {
    if (!m || typeof m !== 'object') continue;
    const obj = m as Record<string, unknown>;

    // v2 format: { user: { username, id, userRanking: { league, level } }, fanClubTier }
    const nestedUser = obj.user as Record<string, unknown> | undefined;

    let userName: string;
    let idValue: string;
    let league: string;
    let level: number;
    let isFanClub: boolean;

    if (nestedUser && typeof nestedUser === 'object') {
      // v2 API format
      userName = String(nestedUser.username || nestedUser.userName || '');
      idValue = String(nestedUser.id || '');

      const ranking = nestedUser.userRanking as Record<string, unknown> | undefined;
      league = String(ranking?.league || '');
      level = Number(ranking?.level || 0);
      isFanClub = obj.fanClubTier !== null && obj.fanClubTier !== undefined;
    } else {
      // Legacy flat format
      userName = String(obj.username || obj.userName || obj.user_name || '');
      idValue = String(obj.id || obj.userId || obj.user_id || '');
      league = String(obj.league || obj.badge || '');
      level = Number(obj.level || 0);
      isFanClub = Boolean(obj.isFanClubMember || obj.fanClub || obj.is_fan_club);
    }

    if (!userName || userName === 'unknown') continue;

    viewers.push({
      userName,
      userIdStripchat: idValue,
      league,
      level,
      isFanClub,
    });
  }

  return viewers;
}
