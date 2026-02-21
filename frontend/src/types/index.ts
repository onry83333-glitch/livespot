// ============================================================
// Auth & Account
// ============================================================
export interface UserProfile {
  id: string;
  display_name: string | null;
  plan: 'free' | 'light' | 'standard' | 'pro' | 'enterprise';
  max_casts: number;
  max_dm_per_month: number;
  dm_used_this_month: number;
  ai_used_this_month: number;
}

export interface Account {
  id: string;
  account_name: string;
  is_active: boolean;
  cast_usernames?: string[];
  coin_rate?: number;
  created_at: string;
}

// ============================================================
// DM
// ============================================================
export interface DMLog {
  id: number;
  user_name: string;
  message: string | null;
  image_sent: boolean;
  status: 'queued' | 'sending' | 'success' | 'error' | 'pending';
  error: string | null;
  sent_at: string | null;
  queued_at: string;
  campaign: string;
  template_name: string;
}

export interface DMTemplate {
  id: string;
  name: string;
  message: string;
  image_url: string | null;
  is_default: boolean;
}

export interface DMEffectiveness {
  campaign: string;
  dm_sent_count: number;
  reconverted_count: number;
  conversion_rate: number;
  reconverted_tokens: number;
}

export interface DMScenario {
  id: string;
  account_id: string;
  scenario_name: string;
  trigger_type: 'thankyou_vip' | 'thankyou_regular' | 'thankyou_first' | 'churn_recovery';
  segment_targets: string[];
  steps: { step: number; delay_hours: number; template: string; message?: string; goal: string }[];
  is_active: boolean;
  auto_approve_step0: boolean;
  daily_send_limit: number;
  min_interval_hours: number;
  created_at: string;
  updated_at: string;
}

export interface DMScenarioEnrollment {
  id: string;
  scenario_id: string;
  account_id: string;
  cast_name: string | null;
  username: string;
  enrolled_at: string;
  current_step: number;
  status: 'active' | 'completed' | 'cancelled' | 'goal_reached';
  last_step_sent_at: string | null;
  next_step_due_at: string | null;
  goal_type: string | null;
  goal_reached_at: string | null;
  metadata: Record<string, unknown>;
}

// ============================================================
// SPY
// ============================================================
export interface SpyMessage {
  id: number;
  account_id: string;
  cast_name: string;
  message_time: string;
  msg_type: 'chat' | 'gift' | 'tip' | 'goal' | 'enter' | 'leave' | 'system' | 'viewer_count' | 'speech' | 'group_join' | 'group_end';
  user_name: string | null;
  message: string | null;
  tokens: number;
  is_vip: boolean;
  user_color: string | null;
  user_league: string | null;
  user_level: number | null;
  metadata: Record<string, unknown>;
  session_id?: string | null;
  session_title?: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  account_id: string;
  session_id: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  total_messages: number;
  total_tips: number;
  total_coins: number;
  unique_users: number;
  created_at: string;
}

export interface VIPAlert {
  user_name: string;
  level: 'whale' | 'high_level';
  total_tokens: number;
  last_paid: string | null;
  user_level: number;
  lifecycle: 'active' | 'dormant' | 'churned' | 'new' | 'unknown';
  alert_message: string;
  message_time?: string;
}

// ============================================================
// Analytics
// ============================================================
export interface DailySales {
  date: string;
  tokens: number;
  tx_count: number;
  cumulative?: number;
}

export interface TopUser {
  user_name: string;
  total_tokens: number;
  first_paid: string | null;
  last_paid: string | null;
  tx_count: number;
  months_active?: number;
  primary_type?: string;
}

export interface RevenueBreakdown {
  type: string;
  tokens: number;
  tx_count: number;
  pct: number;
}

export interface ARPUData {
  month: string;
  arpu: number;
  unique_payers: number;
  total_tokens: number;
}

export interface RetentionCohort {
  last_paid_month: string;
  user_count: number;
  avg_tokens: number;
}

// ============================================================
// AI
// ============================================================
export interface AIReport {
  id: string;
  report_type: string;
  output_text: string;
  model: string;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
}

// ============================================================
// Scripts
// ============================================================
export interface BroadcastScript {
  id: string;
  cast_name: string | null;
  title: string;
  duration_minutes: number;
  steps: ScriptStep[];
  vip_rules: VIPRule[];
  notes: string;
  is_default: boolean;
  created_at: string;
}

export interface ScriptStep {
  time_minutes: number;
  action: string;
  notes?: string;
}

export interface VIPRule {
  condition: string;
  action: string;
}

// ============================================================
// Registered Casts
// ============================================================
export interface RegisteredCast {
  id: number;
  account_id: string;
  cast_name: string;
  display_name: string | null;
  stripchat_url: string | null;
  is_active: boolean;
  notes: string | null;
  genre: string | null;
  benchmark: string | null;
  category: string | null;
  cast_type_id: string | null;
  screenshot_interval: number | null;
  gc_rate_per_minute: number | null;
  last_seen_online: string | null;
  is_extinct: boolean;
  extinct_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Spy Casts (他社キャスト)
// ============================================================
export interface SpyCast {
  id: number;
  account_id: string;
  cast_name: string;
  display_name: string | null;
  stripchat_url: string | null;
  category: string | null;
  format_tag: string | null;
  notes: string | null;
  genre: string | null;
  benchmark: string | null;
  cast_type_id: string | null;
  is_active: boolean;
  auto_monitor: boolean;
  screenshot_interval: number | null;
  gc_rate_per_minute: number | null;
  last_seen_online: string | null;
  is_extinct: boolean;
  extinct_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// User Segments
// ============================================================
export interface UserSegment {
  segment_id: string;
  segment_name: string;
  tier: string;
  recency: string;
  priority: string;
  user_count: number;
  total_coins: number;
  avg_coins: number;
  users: { user_name: string; total_coins: number; last_payment_date: string | null }[];
}

// ============================================================
// Cast Types (型カタログ)
// ============================================================
export interface CastType {
  id: string;
  account_id: string;
  type_name: string;
  benchmark_cast: string;
  description: string | null;
  genre: string | null;
  category: string | null;
  streaming_style: string | null;
  revenue_pattern: string | null;
  avg_session_revenue_min: number | null;
  avg_session_revenue_max: number | null;
  ticket_ratio: number | null;
  avg_ticket_price: number | null;
  avg_ticket_attendees: number | null;
  customer_quality: string | null;
  streaming_frequency: string | null;
  expected_lifespan_months: number | null;
  survival_rate_30d: number | null;
  product_route: string | null;
  consistency_checklist: { item: string; checked: boolean }[];
  hypothesis_1year: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Cast Persona (Persona Agent)
// ============================================================
export interface CastPersona {
  id: string;
  account_id: string;
  cast_name: string;
  character_type: string;
  speaking_style: {
    suffix: string[];
    emoji_rate: 'low' | 'medium' | 'high';
    formality: 'casual' | 'casual_polite' | 'polite';
    max_length: number;
  };
  personality_traits: string[];
  ng_behaviors: string[];
  greeting_patterns: Record<string, string>;
  dm_tone_examples: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface PersonaApiRequest {
  task_type: 'dm_generate' | 'fb_report' | 'dm_evaluate' | 'realtime_coach' | 'recruitment_copy' | 'training_task';
  mode?: 'customer' | 'recruitment';
  cast_name: string;
  context: Record<string, unknown>;
}

export interface PersonaApiResponse {
  output: unknown;
  raw_text: string;
  reasoning: string | null;
  confidence: number | null;
  cost_tokens: number;
  cost_usd: number;
  persona_used: string;
  persona_found: boolean;
}

// ============================================================
// Sync
// ============================================================
export interface SyncStatus {
  account_id: string;
  total_users: number;
  total_transactions: number;
  last_sync: string | null;
}
