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
// Stripchat Sessions
// ============================================================
export interface StripchatSession {
  id: string;
  account_id: string;
  session_cookie: string;
  csrf_token: string | null;
  csrf_timestamp: string | null;
  stripchat_user_id: string | null;
  front_version: string | null;
  jwt_token: string | null;
  is_valid: boolean;
  last_validated_at: string;
  exported_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// DM
// ============================================================
export interface DMLog {
  id: number;
  user_name: string;
  message: string | null;
  image_sent: boolean;
  status: 'queued' | 'sending' | 'success' | 'error' | 'pending' | 'blocked_by_limit';
  error: string | null;
  sent_at: string | null;
  queued_at: string;
  campaign: string;
  template_name: string;
  ai_generated?: boolean;
  ai_reasoning?: string | null;
  ai_confidence?: number | null;
  scenario_enrollment_id?: string | null;
  edited_by_human?: boolean;
  original_ai_message?: string | null;
  sent_via?: 'api' | 'extension';
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

export interface DMFunnel {
  campaign: string;
  dm_sent_count: number;
  visited_count: number;
  visit_rate: number;
  paid_count: number;
  conversion_rate: number;
  total_tokens: number;
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

export interface SpyViewer {
  id: number;
  account_id: string;
  cast_name: string;
  session_id: string | null;
  user_name: string;
  user_id_stripchat: string | null;
  league: string | null;
  level: number | null;
  is_fan_club: boolean;
  first_seen_at: string;
  last_seen_at: string;
  visit_count: number;
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
  stripchat_model_id: string | null;
  model_id: number | null;
  platform: string | null;
  avatar_url: string | null;
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
  stripchat_model_id: string | null;
  model_id: number | null;
  avatar_url: string | null;
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
  is_mock?: boolean;
}

// ── dm_generate (mode=customer) 専用型 ──
export interface DmGenerateRequest {
  task_type: 'dm_generate';
  mode: 'customer';
  cast_name: string;
  context: {
    username: string;
    segment: string;       // S1〜S10
    scenario: string;      // A=お礼, B=離脱防止, C=配信前, D=VIP特別, E=復帰
    step_number?: number;  // シナリオ内ステップ (default: 1)
    recent_message?: string; // ユーザーの直近発言（個別感用）
    last_dm_tone?: string;   // 前回DMのトーン（交互制御用）
  };
}

export interface DmGenerateResponse {
  message: string;
  reasoning: string;
  tone: 'emotional' | 'factual' | 'playful';
  byaf_used: string;
  persona_used: string;
  persona_found: boolean;
  is_mock: boolean;
  model: string;           // 'mock' | 'gpt-4o' | 'gpt-4o-mini' | 'claude-sonnet-4'
  cost_tokens: number;
  cost_usd: number;
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

// ============================================================
// DM Triggers
// ============================================================
export interface DmTrigger {
  id: string;
  account_id: string;
  trigger_name: string;
  trigger_type: 'first_visit' | 'vip_no_tip' | 'churn_risk' | 'segment_upgrade' | 'competitor_outflow' | 'post_session' | 'cross_promotion';
  cast_name: string | null;
  condition_config: Record<string, unknown>;
  action_type: 'direct_dm' | 'enroll_scenario';
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

export interface DmTriggerLog {
  id: number;
  trigger_id: string;
  account_id: string;
  cast_name: string;
  user_name: string;
  action_taken: 'dm_queued' | 'scenario_enrolled' | 'skipped_cooldown' | 'skipped_duplicate' | 'skipped_segment' | 'skipped_daily_limit' | 'error';
  dm_send_log_id: number | null;
  enrollment_id: string | null;
  metadata: Record<string, unknown>;
  error_message: string | null;
  fired_at: string;
}
