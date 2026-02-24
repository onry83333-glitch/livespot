/**
 * evaluators/post-session.ts — UC-038: Post-session thank-you DM (delayed)
 *
 * After session ends, collect users who tipped above min_session_tokens threshold.
 * Results are queued in TriggerEngine.postSessionQueue for delayed firing.
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:post-session');

export async function evaluatePostSession(
  trigger: DmTrigger,
  accountId: string,
  castName: string,
  sessionId?: string,
): Promise<EvaluationResult> {
  if (!sessionId) {
    return { shouldFire: false, targets: [], reason: 'no session_id' };
  }

  const sb = getSupabase();
  const minSessionTokens = (trigger.condition_config.min_session_tokens as number) || 50;

  // Get per-user token totals for this session
  const { data, error } = await sb.rpc('get_session_tippers', {
    p_account_id: accountId,
    p_cast_name: castName,
    p_session_id: sessionId,
    p_min_tokens: minSessionTokens,
  });

  // If RPC doesn't exist, fallback to direct query
  if (error) {
    log.debug(`get_session_tippers RPC not available, using direct query`);
    return await evaluatePostSessionDirect(trigger, accountId, castName, sessionId, minSessionTokens);
  }

  if (!data || data.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  const targets: TriggerContext[] = data.map((row: { user_name: string; total_tokens: number }) => ({
    accountId,
    castName,
    userName: row.user_name,
    sessionTokens: row.total_tokens,
  }));

  log.info(`post_session: ${targets.length} tippers at ${castName} (session ${sessionId})`);
  return { shouldFire: true, targets };
}

async function evaluatePostSessionDirect(
  _trigger: DmTrigger,
  accountId: string,
  castName: string,
  sessionId: string,
  minSessionTokens: number,
): Promise<EvaluationResult> {
  const sb = getSupabase();

  // Query spy_messages for tippers in this session, grouped by user
  const { data: messages, error } = await sb
    .from('spy_messages')
    .select('user_name, tokens')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('session_id', sessionId)
    .gt('tokens', 0);

  if (error || !messages) {
    log.error(`post_session direct query failed: ${error?.message}`);
    return { shouldFire: false, targets: [] };
  }

  // Aggregate per user
  const userTokens = new Map<string, number>();
  for (const msg of messages) {
    const current = userTokens.get(msg.user_name) || 0;
    userTokens.set(msg.user_name, current + msg.tokens);
  }

  const targets: TriggerContext[] = [];
  userTokens.forEach((total, userName) => {
    if (total >= minSessionTokens) {
      targets.push({ accountId, castName, userName, sessionTokens: total });
    }
  });

  if (targets.length === 0) {
    return { shouldFire: false, targets: [] };
  }

  log.info(`post_session (direct): ${targets.length} tippers at ${castName}`);
  return { shouldFire: true, targets };
}
