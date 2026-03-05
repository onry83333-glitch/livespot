/**
 * scenario-engine.ts
 * DMシナリオエンジン — エンロール・キュー処理・ゴール検出
 *
 * 既存テーブル:
 *   dm_scenarios          (041) — scenario_name, steps (JSONB), trigger_type, ...
 *   dm_scenario_enrollments (041) — username, next_step_due_at, ...
 *   dm_send_log           (001+042) — user_name, scenario_enrollment_id, ai_generated, ...
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isDmTestMode, DM_TEST_WHITELIST } from './dm-guard';

// シナリオタイプ → Persona API scenario ラベル変換
const SCENARIO_TYPE_MAP: Record<string, string> = {
  thankyou_vip: 'A',
  thankyou_regular: 'A',
  thankyou_first: 'A',
  first_payment: 'A',
  high_payment: 'A',
  churn_recovery: 'B',
  dormant: 'B',
  visit_no_action: 'C',
  segment_change: 'D',
  manual: 'A',
};

// ============================================================
// Types
// ============================================================

export interface ScenarioStep {
  step: number;
  delay_hours: number;
  template: string;
  message: string;
  goal?: string;
  use_persona?: boolean;
}

export interface Scenario {
  id: string;
  account_id: string;
  scenario_name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  segment_targets: string[];
  steps: ScenarioStep[];
  is_active: boolean;
  auto_approve_step0: boolean;
  daily_send_limit: number;
  min_interval_hours: number;
}

interface Enrollment {
  id: string;
  scenario_id: string;
  account_id: string;
  cast_name: string | null;
  username: string;
  current_step: number;
  status: string;
  next_step_due_at: string | null;
  last_step_sent_at: string | null;
  goal_type: string | null;
  metadata: Record<string, unknown>;
  dm_scenarios: Scenario | null;
}

export interface EnrollResult {
  enrolled: boolean;
  scenarioName?: string;
}

export interface ProcessResult {
  processed: number;
  errors: number;
  skipped: number;
  aiGenerated: number;
  aiErrors: number;
}

// シナリオタイプ別の送信目的マッピング（AI文面生成のcontextに渡す）
const SCENARIO_PURPOSE: Record<string, string> = {
  thankyou_vip: '感謝+特別感。VIPとして唯一性を強調。限定情報を匂わせる。',
  thankyou_regular: '感謝+再来訪の種まき。直接誘わない。余韻を残す。',
  thankyou_first: '初課金お礼。嬉しさを全面に。次も来やすい空気を作る。',
  first_payment: '初課金検出。自然な感謝。押しすぎない。',
  high_payment: '高額応援お礼。特別扱い+承認欲求充足。',
  churn_recovery: '存在を思い出させる+懐かしさ。理由を聞かない。圧ゼロ。',
  dormant: '長期不在フォロー。軽い接触+BYAF強め。',
  visit_no_action: '来訪ありがとう。課金には触れない。純粋に嬉しさだけ。',
  segment_change: 'セグメント変動通知。アップなら祝福、ダウンなら気遣い。',
  manual: '手動シナリオ。テンプレートに従う。',
};

// ステップ番号に応じたトーン指示
function getStepToneGuide(stepNumber: number, totalSteps: number): string {
  if (totalSteps <= 1) return '1通のみのシナリオ。感謝と余韻で完結させる。';
  if (stepNumber === 1) return 'Step 1: 最初の接触。軽く自然に。感謝ベース。';
  if (stepNumber === totalSteps) return `最終Step: クロージング。BYAF強め。圧をかけない。来てくれたら嬉しい、で終わる。`;
  return `Step ${stepNumber}/${totalSteps}: 中間ステップ。前回と異なるトーン（感情⇔事実交互）。話題を変える。`;
}

// AI文面生成: Persona API mode='ai' でフルコンテキスト送信
async function generateAiMessage(
  baseUrl: string,
  token: string,
  castName: string,
  accountId: string,
  userName: string,
  scenarioType: string,
  stepNumber: number,
  totalSteps: number,
): Promise<{ message: string; isAi: true } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/persona`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        mode: 'ai',
        cast_name: castName,
        account_id: accountId,
        task_type: 'dm_generate',
        context: {
          user_name: userName,
          cast_name: castName,
          account_id: accountId,
          scenario_type: scenarioType,
          step_number: stepNumber,
          // フルコンテキスト: buildUserPrompt() が自動的にSPYログ・課金履歴・過去DM・セグメントを取得
          // 追加のシナリオ固有コンテキスト:
          scenario_purpose: SCENARIO_PURPOSE[scenarioType] || SCENARIO_PURPOSE.manual,
          step_tone_guide: getStepToneGuide(stepNumber, totalSteps),
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[scenario-engine] Persona API ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }

    const data = await res.json();
    // mode='ai' は output がオブジェクト（{message, reasoning}）または文字列
    const aiMessage = typeof data.output === 'object'
      ? data.output?.message
      : typeof data.output === 'string'
        ? data.output
        : data.message;
    if (aiMessage && typeof aiMessage === 'string' && aiMessage.length > 0) {
      return { message: aiMessage, isAi: true };
    }
    return null;
  } catch (e) {
    console.warn('[scenario-engine] AI文面生成失敗:', e);
    return null;
  }
}

// ============================================================
// checkAndEnroll — トリガーに基づくシナリオ自動エンロール
// ============================================================

/**
 * Check if a user should be enrolled in any active scenario matching the trigger type.
 * If a matching scenario exists and the user is not already actively enrolled, create an enrollment.
 */
export async function checkAndEnroll(
  supabase: SupabaseClient,
  accountId: string,
  castName: string,
  userName: string,
  triggerType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  triggerData?: any,
): Promise<EnrollResult> {
  // 1. アクティブなシナリオを取得（account_id + trigger_type）
  const { data: scenarios, error: scenarioError } = await supabase
    .from('dm_scenarios')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .eq('trigger_type', triggerType);

  if (scenarioError) {
    console.warn('[scenario-engine] Failed to fetch scenarios:', scenarioError.message);
    return { enrolled: false };
  }

  if (!scenarios || scenarios.length === 0) return { enrolled: false };

  // 最初にマッチしたシナリオを使用
  const scenario = scenarios[0] as Scenario;

  // 2. 既にアクティブなエンロールメントがないか確認
  const { data: existing, error: existingError } = await supabase
    .from('dm_scenario_enrollments')
    .select('id')
    .eq('scenario_id', scenario.id)
    .eq('username', userName)
    .eq('cast_name', castName)
    .in('status', ['active'])
    .limit(1);

  if (existingError) {
    console.warn('[scenario-engine] Failed to check existing enrollment:', existingError.message);
    return { enrolled: false };
  }

  if (existing && existing.length > 0) return { enrolled: false };

  // 3. ステップを解析し、next_step_due_at を計算
  const steps = (scenario.steps || []) as ScenarioStep[];
  if (steps.length === 0) return { enrolled: false };

  const firstStep = steps[0];
  const delayMs = (firstStep.delay_hours || 0) * 60 * 60 * 1000;
  const nextDue = new Date(Date.now() + delayMs);

  // 4. エンロールメント登録
  const { error: insertError } = await supabase
    .from('dm_scenario_enrollments')
    .insert({
      scenario_id: scenario.id,
      account_id: accountId,
      cast_name: castName,
      username: userName,
      current_step: 0,
      status: 'active',
      next_step_due_at: nextDue.toISOString(),
      goal_type: firstStep.goal || null,
      metadata: triggerData ? { trigger_data: triggerData } : {},
    });

  if (insertError) {
    // UNIQUE制約違反の場合は既にエンロール済みなので正常扱い
    if (insertError.code === '23505') {
      return { enrolled: false };
    }
    console.warn('[scenario-engine] Enroll failed:', insertError.message);
    return { enrolled: false };
  }

  return { enrolled: true, scenarioName: scenario.scenario_name };
}

// ============================================================
// processScenarioQueue — 期日到来エンロールメントのDM送信キュー登録
// ============================================================

/**
 * Find enrollments where next_step_due_at <= NOW, queue DMs via dm_send_log,
 * and advance the step or mark as completed.
 */
export async function processScenarioQueue(
  supabase: SupabaseClient,
  accountId: string,
  options?: { baseUrl?: string; token?: string },
): Promise<ProcessResult> {
  let processed = 0;
  let errors = 0;
  let skipped = 0;
  let aiGenerated = 0;
  let aiErrors = 0;
  const baseUrl = options?.baseUrl || '';
  const authToken = options?.token || '';

  // 1. 期日到来のエンロールメントを取得（シナリオ情報を結合）
  const { data: dueEnrollments, error: fetchError } = await supabase
    .from('dm_scenario_enrollments')
    .select('*, dm_scenarios(*)')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .lte('next_step_due_at', new Date().toISOString())
    .order('next_step_due_at', { ascending: true })
    .limit(100);

  if (fetchError) {
    console.warn('[scenario-engine] Failed to fetch due enrollments:', fetchError.message);
    return { processed: 0, errors: 0, skipped: 0, aiGenerated: 0, aiErrors: 0 };
  }

  if (!dueEnrollments || dueEnrollments.length === 0) {
    return { processed: 0, errors: 0, skipped: 0, aiGenerated: 0, aiErrors: 0 };
  }

  for (const raw of dueEnrollments) {
    const enrollment = raw as unknown as Enrollment;

    try {
      const scenario = enrollment.dm_scenarios;
      if (!scenario) {
        console.warn('[scenario-engine] No scenario found for enrollment:', enrollment.id);
        continue;
      }

      const steps = (scenario.steps || []) as ScenarioStep[];
      const currentStep = enrollment.current_step || 0;

      // 全ステップ完了済みの場合
      if (currentStep >= steps.length) {
        await supabase
          .from('dm_scenario_enrollments')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            next_step_due_at: null,
          })
          .eq('id', enrollment.id);
        processed++;
        continue;
      }

      const step = steps[currentStep];

      // AI文面生成 or テンプレート置換
      let message: string;
      let usedAi = false;

      if (step.use_persona !== false && baseUrl && authToken) {
        const aiResult = await generateAiMessage(
          baseUrl,
          authToken,
          enrollment.cast_name || '',
          accountId,
          enrollment.username,
          scenario.trigger_type,
          currentStep + 1,
          steps.length,
        );
        if (aiResult) {
          message = aiResult.message;
          usedAi = true;
          aiGenerated++;
        } else {
          // AI失敗時はテンプレートにフォールバック
          message = (step.message || step.template || '')
            .replace(/\{username\}/g, enrollment.username);
          aiErrors++;
        }
      } else {
        // use_persona=false or AI設定なし → テンプレート
        message = (step.message || step.template || '')
          .replace(/\{username\}/g, enrollment.username);
      }

      // P0-5: 24時間以内の重複チェック（シナリオ経由のDMも対象）
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentDm } = await supabase
        .from('dm_send_log')
        .select('id')
        .eq('account_id', accountId)
        .eq('cast_name', enrollment.cast_name)
        .eq('user_name', enrollment.username)
        .neq('status', 'error')
        .gte('queued_at', cutoff)
        .limit(1);

      if (recentDm && recentDm.length > 0) {
        console.info(`[scenario-engine] 重複スキップ: ${enrollment.username} (24h以内に送信済み)`);
        skipped++;
        continue;
      }

      // DM安全ゲート: テストモード時ホワイトリスト外はスキップ
      if (isDmTestMode() && !DM_TEST_WHITELIST.has(enrollment.username)) {
        console.info(`[scenario-engine] [DM_TEST_MODE] スキップ: ${enrollment.username} はホワイトリスト外`);
        skipped++;
        continue;
      }

      // dm_send_log にDMをキュー登録
      // 注意: dm_send_log は user_name カラム、dm_scenario_enrollments は username カラム
      const dmStatus = scenario.auto_approve_step0 && currentStep === 0 ? 'queued' : 'pending';
      const { error: dmError } = await supabase
        .from('dm_send_log')
        .insert({
          account_id: accountId,
          cast_name: enrollment.cast_name,
          user_name: enrollment.username, // dm_send_log.user_name に enrollment.username を使用
          message,
          status: dmStatus,
          campaign: `scenario_${scenario.id.slice(0, 8)}_step${currentStep}`,
          scenario_enrollment_id: enrollment.id,
          ai_generated: usedAi,
        });

      if (dmError) {
        console.warn('[scenario-engine] DM queue failed:', dmError.message);
        errors++;
        continue;
      }

      // ステップを進める
      const nextStep = currentStep + 1;
      const isLastStep = nextStep >= steps.length;
      const now = new Date().toISOString();

      if (isLastStep) {
        // 最終ステップ完了
        await supabase
          .from('dm_scenario_enrollments')
          .update({
            current_step: nextStep,
            status: 'completed',
            last_step_sent_at: now,
            completed_at: now,
            next_step_due_at: null,
          })
          .eq('id', enrollment.id);
      } else {
        // 次のステップの期日を計算
        const nextDelay = steps[nextStep].delay_hours || 0;
        const nextDue = new Date(Date.now() + nextDelay * 60 * 60 * 1000);
        await supabase
          .from('dm_scenario_enrollments')
          .update({
            current_step: nextStep,
            last_step_sent_at: now,
            next_step_due_at: nextDue.toISOString(),
            goal_type: steps[nextStep].goal || null,
          })
          .eq('id', enrollment.id);
      }

      processed++;
    } catch (e) {
      console.warn('[scenario-engine] Error processing enrollment:', e);
      errors++;
    }
  }

  return { processed, errors, skipped, aiGenerated, aiErrors };
}

// ============================================================
// fireGoalEvents — アクティブエンロールメントのゴール自動検出
// SPYメッセージ返信・課金・来訪を自動スキャンし、ゴール発火
// ============================================================

export async function fireGoalEvents(
  supabase: SupabaseClient,
  accountId: string,
): Promise<{ fired: number; checked: number }> {
  let fired = 0;

  // 1. アクティブなエンロールメントを取得（ゴールタイプ付き）
  const { data: enrollments, error } = await supabase
    .from('dm_scenario_enrollments')
    .select('id, username, cast_name, goal_type, last_step_sent_at')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .not('goal_type', 'is', null)
    .limit(500);

  if (error || !enrollments || enrollments.length === 0) {
    return { fired: 0, checked: enrollments?.length || 0 };
  }

  for (const enrollment of enrollments) {
    if (!enrollment.cast_name || !enrollment.goal_type) continue;
    const since = enrollment.last_step_sent_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const goalType = enrollment.goal_type as string;

    // payment ゴールチェック: 最終ステップ送信後に課金があるか
    if (goalType === 'payment' || goalType === 'reply_or_visit') {
      if (goalType === 'payment') {
        const { data: coinTx } = await supabase
          .from('coin_transactions')
          .select('id')
          .eq('user_name', enrollment.username)
          .eq('cast_name', enrollment.cast_name)
          .gte('date', since)
          .limit(1);

        if (coinTx && coinTx.length > 0) {
          await markGoalReached(supabase, enrollment.id);
          fired++;
          continue;
        }
      }
    }

    // visit ゴールチェック: SPYメッセージに来訪ログがあるか
    if (goalType === 'visit' || goalType === 'reply_or_visit') {
      const { data: spyMsgs } = await supabase
        .from('chat_logs')
        .select('id')
        .eq('username', enrollment.username)
        .eq('cast_name', enrollment.cast_name)
        .gte('timestamp', since)
        .limit(1);

      if (spyMsgs && spyMsgs.length > 0) {
        await markGoalReached(supabase, enrollment.id);
        fired++;
        continue;
      }
    }

    // reply ゴールチェック: DM返信検出（dm_send_logのステータスベース）
    if (goalType === 'reply' || goalType === 'reply_or_visit') {
      // SPYメッセージで「DM返信」タイプのメッセージがあるか
      const { data: replies } = await supabase
        .from('chat_logs')
        .select('id')
        .eq('username', enrollment.username)
        .eq('cast_name', enrollment.cast_name)
        .eq('message_type', 'dm_reply')
        .gte('timestamp', since)
        .limit(1);

      if (replies && replies.length > 0) {
        await markGoalReached(supabase, enrollment.id);
        fired++;
        continue;
      }
    }
  }

  return { fired, checked: enrollments.length };
}

async function markGoalReached(supabase: SupabaseClient, enrollmentId: string): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from('dm_scenario_enrollments')
    .update({
      status: 'goal_reached',
      goal_reached_at: now,
      completed_at: now,
      next_step_due_at: null,
    })
    .eq('id', enrollmentId);
}

// ============================================================
// checkGoalReached — ゴール到達チェック（reply/visit/payment）
// ============================================================

/**
 * Check if a user event matches the goal of any active enrollment.
 * If matched, mark the enrollment as goal_reached.
 */
export async function checkGoalReached(
  supabase: SupabaseClient,
  accountId: string,
  castName: string,
  userName: string,
  goalEvent: 'reply' | 'visit' | 'payment',
): Promise<boolean> {
  // アクティブなエンロールメントを取得
  const { data: enrollments, error } = await supabase
    .from('dm_scenario_enrollments')
    .select('id, goal_type')
    .eq('account_id', accountId)
    .eq('cast_name', castName)
    .eq('username', userName)
    .eq('status', 'active')
    .limit(100);

  if (error) {
    console.warn('[scenario-engine] Failed to check goals:', error.message);
    return false;
  }

  if (!enrollments || enrollments.length === 0) return false;

  let goalReached = false;

  for (const enrollment of enrollments) {
    const goalType = enrollment.goal_type || '';

    // ゴールタイプとイベントのマッチング
    const matches =
      goalType === 'reply_or_visit'
        ? goalEvent === 'reply' || goalEvent === 'visit'
        : goalType === goalEvent;

    if (matches) {
      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('dm_scenario_enrollments')
        .update({
          status: 'goal_reached',
          goal_reached_at: now,
          completed_at: now,
          next_step_due_at: null,
        })
        .eq('id', enrollment.id);

      if (updateError) {
        console.warn('[scenario-engine] Failed to update goal_reached:', updateError.message);
      } else {
        goalReached = true;
      }
    }
  }

  return goalReached;
}
