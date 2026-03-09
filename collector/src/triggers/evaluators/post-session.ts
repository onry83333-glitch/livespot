/**
 * evaluators/post-session.ts — UC-038: Post-session thank-you DM (delayed)
 *
 * After session ends, collect users who tipped above min_session_tokens threshold.
 * Uses get_thankyou_dm_candidates RPC which handles:
 *   - Session time range lookup (sessions table)
 *   - Tipper aggregation from chat_logs
 *   - Segment calculation (S1-S10)
 *   - DM dedup (already-sent check)
 *   - Suggested template per segment
 * Results are queued in TriggerEngine.postSessionQueue for delayed firing.
 */

import { getSupabase } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { DmTrigger, EvaluationResult, TriggerContext } from '../types.js';

const log = createLogger('trigger:post-session');

interface ThankYouCandidate {
  username: string;
  tokens_in_session: number;
  total_tokens: number;
  segment: string;
  last_dm_sent_at: string | null;
  dm_sent_this_session: boolean;
  suggested_template: string | null;
}

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

  // Use get_thankyou_dm_candidates RPC — handles session lookup, dedup, and segment
  const { data, error } = await sb.rpc('get_thankyou_dm_candidates', {
    p_account_id: accountId,
    p_cast_name: castName,
    p_session_id: sessionId,
    p_min_tokens: minSessionTokens,
  });

  if (error) {
    log.error(`get_thankyou_dm_candidates RPC failed: ${error.message}`);
    // Fallback: direct query on spy_messages (legacy path)
    return evaluatePostSessionDirect(accountId, castName, sessionId, minSessionTokens);
  }

  if (!data || data.length === 0) {
    log.debug(`post_session: no candidates at ${castName} (session ${sessionId})`);
    return { shouldFire: false, targets: [] };
  }

  const candidates = data as ThankYouCandidate[];
  const targets: TriggerContext[] = candidates.map((row) => ({
    accountId,
    castName,
    userName: row.username,
    sessionTokens: row.tokens_in_session,
    totalTokens: row.total_tokens,
    segment: row.segment,
    // Attach suggested template for use in fireTrigger message rendering
    suggestedTemplate: row.suggested_template ?? undefined,
  }));

  log.info(`post_session: ${targets.length} tippers at ${castName} (session ${sessionId})`);
  return { shouldFire: true, targets };
}

/**
 * Fallback: query spy_messages directly when RPC is unavailable.
 * This path handles the legacy case where chat_logs may not be populated yet.
 */
async function evaluatePostSessionDirect(
  accountId: string,
  castName: string,
  sessionId: string,
  minSessionTokens: number,
): Promise<EvaluationResult> {
  const sb = getSupabase();

  // Get session time range to filter by timestamp instead of session_id
  // (spy_messages.session_id may be NULL)
  const { data: session } = await sb
    .from('sessions')
    .select('started_at, ended_at')
    .eq('session_id', sessionId)
    .single();

  if (!session?.started_at) {
    log.warn(`post_session fallback: session ${sessionId} not found`);
    return { shouldFire: false, targets: [] };
  }

  const startedAt = session.started_at;
  const endedAt = session.ended_at || new Date().toISOString();

  // Query by time range instead of session_id
  const { data: messages, error } = await sb
    .from('spy_messages')
    .select('user_name, tokens')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .gte('message_time', startedAt)
    .lte('message_time', endedAt)
    .gt('tokens', 0);

  if (error || !messages) {
    log.error(`post_session fallback query failed: ${error?.message}`);
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

  log.info(`post_session (fallback): ${targets.length} tippers at ${castName}`);
  return { shouldFire: true, targets };
}
