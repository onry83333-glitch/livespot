/**
 * triggers/types.ts — DM Trigger Engine type definitions
 *
 * DB schema (Migration 064 — corrected 2026-03-02):
 *   dm_triggers: id, account_id, trigger_name, trigger_type, cast_name,
 *     condition_config (JSONB), action_type, message_template,
 *     scenario_id, target_segments (TEXT[]), cooldown_hours, daily_limit,
 *     enabled, priority, created_at, updated_at
 *
 *   dm_trigger_logs: id, trigger_id, account_id, cast_name, user_name,
 *     action_taken, dm_send_log_id, enrollment_id, metadata, error_message,
 *     fired_at
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
 * DmTriggerRow — matches actual DB columns (Migration 064)
 */
export interface DmTriggerRow {
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
  enabled: boolean;
  priority: number;
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
  // target_segments is TEXT[] in DB — already an array from PostgREST
  const targetSegments = Array.isArray(row.target_segments) ? row.target_segments : [];

  return {
    id: row.id,
    account_id: row.account_id,
    trigger_name: row.trigger_name,
    trigger_type: row.trigger_type,
    cast_name: row.cast_name || null,
    condition_config: row.condition_config || {},
    action_type: row.action_type || 'direct_dm',
    message_template: row.message_template,
    scenario_id: row.scenario_id || null,
    target_segments: targetSegments,
    cooldown_hours: row.cooldown_hours,
    daily_limit: row.daily_limit,
    is_active: row.enabled,
    priority: row.priority ?? 100,
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
