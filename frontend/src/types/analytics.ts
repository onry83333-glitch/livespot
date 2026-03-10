import type { UserSegment } from '@/types';
import type { DmCvrItem } from '@/types/dm';

/* ============================================================
   Analytics Tab 共通型定義
   ============================================================ */

export interface HourlyPerfItem {
  hour_jst: number;
  session_count: number;
  avg_duration_min: number;
  avg_viewers: number;
  avg_tokens: number;
  total_tokens: number;
  avg_tokens_per_hour: number;
}

export interface CoinTxItem {
  id: number;
  user_name: string;
  tokens: number;
  type: string;
  date: string;
  source_detail: string | null;
}

export interface PaidUserItem {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
}

export interface CampaignEffect {
  campaign: string;
  sent_count: number;
  success_count: number;
  visited_count: number;
  tipped_count: number;
  tip_amount: number;
}

export interface AcquisitionUser {
  user_name: string;
  total_coins: number;
  last_payment_date: string | null;
  first_seen: string | null;
  tx_count: number;
  dm_sent: boolean;
  dm_sent_date: string | null;
  dm_campaign: string | null;
  segment: string;
  is_new_user: boolean;
  converted_after_dm: boolean;
}

export interface MonthlyPL {
  month: string;
  cast_name: string;
  total_sessions: number;
  total_hours: number;
  total_tokens: number;
  gross_revenue_jpy: number;
  platform_fee_jpy: number;
  net_revenue_jpy: number;
  total_cast_cost_jpy: number;
  monthly_fixed_cost_jpy: number;
  gross_profit_jpy: number;
  profit_margin: number;
}

export interface RevenueShareRow {
  week_start: string;
  week_end: string;
  week_label: string;
  transaction_count: number;
  total_tokens: number;
  setting_token_to_usd: number;
  setting_platform_fee_pct: number;
  setting_revenue_share_pct: number;
  gross_usd: number;
  platform_fee_usd: number;
  net_usd: number;
  cast_payment_usd: number;
  formula_gross: string;
  formula_fee: string;
  formula_net: string;
  formula_payment: string;
}

/** Re-export for convenience */
export type { UserSegment, DmCvrItem };
