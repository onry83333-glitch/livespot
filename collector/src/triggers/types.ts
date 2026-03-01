/**
 * triggers/types.ts — DM Trigger Engine type definitions
 *
 * DB schema (actual — verified 2026-03-01):
 *   dm_triggers: id, account_id, trigger_name, trigger_type, is_active,
 *     conditions (JSONB), dm_template_id, dm_content_template,
 *     cooldown_hours, daily_limit, target_segment (TEXT/JSON string),
 *     created_at, updated_at
 *
 *   dm_trigger_logs: id, trigger_id, account_id, user_id, username,
 *     cast_name, triggered_at, dm_sent_at, status, reason
 */

export type TriggerType =
  | 'first_visit'
  | 'vip_no_tip'
  | 'churn_risk'
  | 'segment_upgrade'
  | 'competitor_outflow'
  | 'post_session'
  | 'cross_promotion';

export type ActionType = 'direct_dm' | 'enroll_scenario';

export type ActionTaken =
  | 'dm_queued'
  | 'scenario_enrolled'
  | 'skipped_cooldown'
  | 'skipped_duplicate'
  | 'skipped_segment'
  | 'skipped_daily_limit'
  | 'error';

/**
 * DmTriggerRow — matches actual DB columns (verified 2026-03-01)
 */
export interface DmTriggerRow {
  id: string;
  account_id: string;
  trigger_name: string;
  trigger_type: TriggerType;
  is_active: boolean;
  conditions: Record<string, unknown>;
  dm_template_id: string | null;
  dm_content_template: string | null;
  cooldown_hours: number;
  daily_limit: number;
  target_segment: string | null; // JSON string e.g. '["S1","S2"]'
  created_at: string;
  updated_at: string;
}

/** Normalized trigger used by the engine */
export interface DmTrigger {
  id: string;
  account_id: string;
  trigger_name: string;
  trigger_type: TriggerType;
  cast_name: string | null;
  condition_config: Record<string, unknown>;
  action_type: ActionType;
  message_template: string | null;
  scenario_id: string | null;
  target_segments: string[];
  cooldown_hours: number;
  daily_limit: number;
  is_active: boolean;
  priority: number;
}

/** Convert DB row to normalized DmTrigger */
export function normalizeTrigger(row: DmTriggerRow): DmTrigger {
  // target_segment is TEXT in DB storing JSON string like '["S1","S2"]'
  let targetSegments: string[] = [];
  if (row.target_segment) {
    if (typeof row.target_segment === 'string') {
      try {
        const parsed = JSON.parse(row.target_segment);
        if (Array.isArray(parsed)) targetSegments = parsed;
      } catch {
        targetSegments = row.target_segment.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  const cond = row.conditions || {};

  return {
    id: row.id,
    account_id: row.account_id,
    trigger_name: row.trigger_name,
    trigger_type: row.trigger_type,
    cast_name: (cond.cast_name as string) || null,
    condition_config: cond,
    action_type: (cond.action_type as ActionType) || 'direct_dm',
    message_template: row.dm_content_template,
    scenario_id: (cond.scenario_id as string) || null,
    target_segments: targetSegments,
    cooldown_hours: row.cooldown_hours,
    daily_limit: row.daily_limit,
    is_active: row.is_active,
    priority: (cond.priority as number) ?? 100,
  };
}

export interface TriggerContext {
  accountId: string;
  castName: string;
  userName: string;
  totalTokens?: number;
  segment?: string;
  previousSegment?: string;
  daysSinceLastVisit?: number;
  sessionTokens?: number;
}

export interface EvaluationResult {
  shouldFire: boolean;
  targets: TriggerContext[];
  reason?: string;
}

export interface TriggerEvent {
  type: 'viewer_list' | 'session_start' | 'session_end';
  accountId: string;
  castName: string;
  data: Record<string, unknown>;
}

export interface PostSessionQueueItem {
  trigger: DmTrigger;
  targets: TriggerContext[];
  fireAt: number; // Date.now() + delay
}
