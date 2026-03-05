/**
 * evaluators/vip-no-tip.ts — UC-008: VIP visited but didn't tip today
 *
 * On session end, find users who were present (in spy_viewers) but didn't tip
 * (no spy_messages with tokens > 0) during the session. Filter to high-value users.
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:vip-no-tip');

export async function evaluateVipNoTip(
  trigger: DmTrigger,
  accountId: string,
  castName: string,
  sessionId?: string,
): Promise<EvaluationResult> {
  if (!sessionId) {
    return { shouldFire: false, targets: [], reason: 'no session_id' };
  }

  const sb = getSupabase();
  const minTotalTokens = (trigger.condition_config.min_total_tokens as number) || 1000;

  // Get session time range for reliable filtering
  const { data: session } = await sb
    .from('sessions')
    .select('started_at, ended_at')
    .eq('session_id', sessionId)
    .single();

  if (!session?.started_at) {
    return { shouldFire: false, targets: [], reason: 'session not found' };
  }

  const startedAt = session.started_at;
  const endedAt = session.ended_at || new Date().toISOString();

  // 1. Get all viewers for this session (try session_id first, fallback to time range)
  let viewerNames: string[] = [];
  const { data: viewers } = await sb
    .from('spy_viewers')
    .select('user_name')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('session_id', sessionId);

  if (viewers && viewers.length > 0) {
    viewerNames = viewers.map((v: { user_name: string }) => v.user_name);
  } else {
    // Fallback: get distinct chatters during session as proxy for "viewers"
    const { data: chatters } = await sb
      .from('spy_messages')
      .select('user_name')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .gte('message_time', startedAt)
      .lte('message_time', endedAt);

    if (!chatters || chatters.length === 0) {
      return { shouldFire: false, targets: [], reason: 'no viewers/chatters' };
    }
    viewerNames = [...new Set(chatters.map((c: { user_name: string }) => c.user_name))];
  }

  // 2. Get users who tipped during session time range
  const { data: tippers, error: tipErr } = await sb
    .from('spy_messages')
    .select('user_name')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .gte('message_time', startedAt)
    .lte('message_time', endedAt)
    .gt('tokens', 0);

  if (tipErr) {
    log.error(`Failed to query tippers: ${tipErr.message}`);
    return { shouldFire: false, targets: [] };
  }

  const tipperSet = new Set((tippers || []).map((t: { user_name: string }) => t.user_name));

  // 3. Viewers who did NOT tip
  const noTipViewers = viewerNames.filter((name) => !tipperSet.has(name));
  if (noTipViewers.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  // 4. Filter to high-value users (try user_profiles first, fallback to spy_user_profiles)
  let profiles: { user_name: string; total_tokens: number }[] | null = null;

  const { data: v2Profiles } = await sb
    .from('user_profiles')
    .select('username, total_tokens')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .in('username', noTipViewers)
    .gte('total_tokens', minTotalTokens);

  if (v2Profiles && v2Profiles.length > 0) {
    profiles = v2Profiles.map((p: { username: string; total_tokens: number }) => ({
      user_name: p.username,
      total_tokens: p.total_tokens,
    }));
  } else {
    // Fallback to legacy spy_user_profiles
    const { data: legacyProfiles } = await sb
      .from('spy_user_profiles')
      .select('user_name, total_tokens')
      .eq('account_id', accountId)
      .eq('cast_name', castName)
      .eq('is_registered_cast', true)
      .in('user_name', noTipViewers)
      .gte('total_tokens', minTotalTokens);

    profiles = legacyProfiles;
  }

  if (!profiles || profiles.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const targets: TriggerContext[] = profiles.map((p) => ({
    accountId,
    castName,
    userName: p.user_name,
    totalTokens: p.total_tokens,
  }));

  log.info(`vip_no_tip: ${targets.length} VIPs without tips at ${castName} (session ${sessionId})`);
  return { shouldFire: true, targets };
}
