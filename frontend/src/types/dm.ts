import type { SupabaseClient } from '@supabase/supabase-js';

/* ============================================================
   DM Tab 共通型定義
   ============================================================ */

export interface DMLogItem {
  id: number;
  user_name: string;
  message: string | null;
  status: string;
  error: string | null;
  campaign: string;
  queued_at: string;
  sent_at: string | null;
}

export interface DmScheduleItem {
  id: string;
  cast_name: string;
  message: string;
  target_segment: string | null;
  target_usernames: string[] | null;
  scheduled_at: string;
  status: string;
  sent_count: number;
  total_count: number;
  error_message: string | null;
  campaign: string | null;
  send_mode: string;
  tab_count: number;
  created_at: string;
  completed_at: string | null;
}

export interface DmEffItem {
  campaign: string;
  segment: string;
  sent_count: number;
  visited_count: number;
  paid_count: number;
  visit_cvr: number;
  payment_cvr: number;
  total_tokens: number;
  avg_tokens_per_payer: number;
}

export interface DmCvrItem {
  campaign: string;
  dm_sent: number;
  paid_after: number;
  visited_after: number;
  cvr_pct: number;
  visit_cvr_pct: number;
  total_tokens: number;
  avg_tokens_per_payer: number;
  first_sent: string;
  last_sent: string;
}

export interface ScenarioItem {
  id: string;
  scenario_name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  segment_targets: string[];
  steps: { step: number; delay_hours: number; template: string; message: string; goal?: string }[];
  is_active: boolean;
  auto_approve_step0: boolean;
  daily_send_limit: number;
  min_interval_hours: number;
  created_at: string;
}

export interface EnrollmentDetail {
  scenario_id: string;
  user_name: string;
  current_step: number;
  status: string;
  enrolled_at: string;
}

export interface FanItem {
  user_name: string;
  total_tokens: number;
  msg_count: number;
  last_seen: string;
}

export interface DmQueueCounts {
  queued: number;
  sending: number;
  success: number;
  error: number;
  total: number;
}

/** Supabase browser client type alias */
export type SB = SupabaseClient;
