/**
 * Viewer list parser
 * Parses Stripchat /groupShow/members API response
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

    const userName = String(obj.username || obj.userName || obj.user_name || '');
    if (!userName) continue;

    viewers.push({
      userName,
      userIdStripchat: String(obj.id || obj.userId || obj.user_id || ''),
      league: String(obj.league || obj.badge || ''),
      level: Number(obj.level || 0),
      isFanClub: Boolean(obj.isFanClubMember || obj.fanClub || obj.is_fan_club),
    });
  }

  return viewers;
}
