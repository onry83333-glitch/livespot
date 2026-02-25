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

  // 1. Get all viewers for this session
  const { data: viewers, error: viewerErr } = await sb
    .from('spy_viewers')
    .select('user_name')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('session_id', sessionId);

  if (viewerErr || !viewers || viewers.length === 0) {
    return { shouldFire: false, targets: [], reason: 'no viewers' };
  }

  const viewerNames = viewers.map((v: { user_name: string }) => v.user_name);

  // 2. Get users who tipped in this session
  const { data: tippers, error: tipErr } = await sb
    .from('spy_messages')
    .select('user_name')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('session_id', sessionId)
    .gt('tokens', 0);

  if (tipErr) {
    log.error(`Failed to query tippers: ${tipErr.message}`);
    return { shouldFire: false, targets: [] };
  }

  const tipperSet = new Set((tippers || []).map((t: { user_name: string }) => t.user_name));

  // 3. Viewers who did NOT tip
  const noTipViewers = viewerNames.filter((name: string) => !tipperSet.has(name));
  if (noTipViewers.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  // 4. Filter to high-value users (total tokens >= threshold from spy_user_profiles)
  const { data: profiles, error: profErr } = await sb
    .from('spy_user_profiles')
    .select('user_name, total_tokens')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('is_registered_cast', true)
    .in('user_name', noTipViewers)
    .gte('total_tokens', minTotalTokens);

  if (profErr) {
    log.error(`Failed to query profiles: ${profErr.message}`);
    return { shouldFire: false, targets: [] };
  }

  if (!profiles || profiles.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const targets: TriggerContext[] = profiles.map((p: { user_name: string; total_tokens: number }) => ({
    accountId,
    castName,
    userName: p.user_name,
    totalTokens: p.total_tokens,
  }));

  log.info(`vip_no_tip: ${targets.length} VIPs without tips at ${castName} (session ${sessionId})`);
  return { shouldFire: true, targets };
}
