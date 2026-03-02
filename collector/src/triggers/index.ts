/**
 * triggers/index.ts — TriggerEngine: orchestrates all trigger evaluations
 */

import { getSupabase } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { isInCooldown, isDailyLimitReached, isSegmentAllowed } from './cooldown.js';
import { renderTemplate } from './template.js';
import type {
  DmTrigger,
  DmTriggerRow,
  TriggerContext,
  PostSessionQueueItem,
  ActionTaken,
} from './types.js';
import { normalizeTrigger } from './types.js';
import type { ViewerEntry } from '../parsers/viewer.js';

// Evaluators
import { evaluateFirstVisit, initKnownViewers } from './evaluators/first-visit.js';
import { evaluateVipNoTip } from './evaluators/vip-no-tip.js';
import { evaluatePostSession } from './evaluators/post-session.js';
import { evaluateChurnRisk } from './evaluators/churn-risk.js';
import { evaluateSegmentUpgrade, initSegmentSnapshot } from './evaluators/segment-upgrade.js';
import { evaluateCompetitorOutflow } from './evaluators/competitor-outflow.js';
import { evaluateCrossPromotion } from './evaluators/cross-promotion.js';

const log = createLogger('trigger-engine');

export class TriggerEngine {
  private triggers: DmTrigger[] = [];
  private lastRefresh = 0;
  private warmupCycles = 0;
  private readonly WARMUP_THRESHOLD = 2;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

  // Post-session delayed queue (in-memory)
  private postSessionQueue: PostSessionQueueItem[] = [];

  /** Load/refresh triggers from Supabase */
  async refreshTriggers(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < this.CACHE_TTL_MS && this.triggers.length > 0) return;

    const sb = getSupabase();
    const { data, error } = await sb
      .from('dm_triggers')
      .select('*')
      .eq('enabled', true);

    if (error) {
      log.error(`Failed to load triggers: ${error.message}`);
      return;
    }

    this.triggers = ((data || []) as DmTriggerRow[]).map(normalizeTrigger);
    this.triggers.sort((a, b) => a.priority - b.priority);
    this.lastRefresh = now;
    log.info(`TriggerEngine: loaded ${this.triggers.length} active triggers`);
  }

  /** Get triggers filtered by type and optionally by account/cast */
  private getTriggersForType(
    triggerType: string,
    accountId?: string,
    castName?: string,
  ): DmTrigger[] {
    return this.triggers.filter((t) => {
      if (t.trigger_type !== triggerType) return false;
      if (accountId && t.account_id !== accountId) return false;
      if (castName && t.cast_name && t.cast_name !== castName) return false;
      return true;
    });
  }

  /** Called after viewer list poll — evaluates first_visit triggers */
  async onViewerListUpdate(
    accountId: string,
    castName: string,
    viewers: ViewerEntry[],
  ): Promise<void> {
    if (this.warmupCycles < this.WARMUP_THRESHOLD) return;

    const triggers = this.getTriggersForType('first_visit', accountId, castName);
    if (triggers.length === 0) return;

    for (const trigger of triggers) {
      try {
        const result = await evaluateFirstVisit(trigger, accountId, castName, viewers);
        if (result.shouldFire) {
          for (const ctx of result.targets) {
            await this.fireTrigger(trigger, ctx);
          }
        }
      } catch (err) {
        log.error(`first_visit eval error: ${err}`);
      }
    }
  }

  /** Called on session start/end transitions */
  async onSessionTransition(
    accountId: string,
    castName: string,
    transition: 'start' | 'end',
    sessionData: Record<string, unknown>,
  ): Promise<void> {
    if (transition === 'start') {
      // Initialize known viewers for this cast on session start
      await initKnownViewers(accountId, castName);
      this.warmupCycles = this.WARMUP_THRESHOLD; // skip warmup after explicit start
      return;
    }

    // transition === 'end'
    const sessionId = sessionData.sessionId as string | undefined;

    // UC-008: VIP no tip
    const vipTriggers = this.getTriggersForType('vip_no_tip', accountId, castName);
    for (const trigger of vipTriggers) {
      try {
        const result = await evaluateVipNoTip(trigger, accountId, castName, sessionId);
        if (result.shouldFire) {
          for (const ctx of result.targets) {
            await this.fireTrigger(trigger, ctx);
          }
        }
      } catch (err) {
        log.error(`vip_no_tip eval error: ${err}`);
      }
    }

    // UC-038: Post-session (delayed)
    const postTriggers = this.getTriggersForType('post_session', accountId, castName);
    for (const trigger of postTriggers) {
      try {
        const result = await evaluatePostSession(trigger, accountId, castName, sessionId);
        if (result.shouldFire && result.targets.length > 0) {
          const delayMinutes = (trigger.condition_config.delay_minutes as number) || 30;
          this.postSessionQueue.push({
            trigger,
            targets: result.targets,
            fireAt: Date.now() + delayMinutes * 60 * 1000,
          });
          log.info(`post_session: queued ${result.targets.length} DMs for ${castName} (fire in ${delayMinutes}min)`);
        }
      } catch (err) {
        log.error(`post_session eval error: ${err}`);
      }
    }
  }

  /** Process delayed post-session queue — called every 1 minute */
  async processPostSessionQueue(): Promise<void> {
    const now = Date.now();
    const ready = this.postSessionQueue.filter((item) => item.fireAt <= now);
    this.postSessionQueue = this.postSessionQueue.filter((item) => item.fireAt > now);

    for (const item of ready) {
      for (const ctx of item.targets) {
        try {
          await this.fireTrigger(item.trigger, ctx);
        } catch (err) {
          log.error(`post_session fire error: ${err}`);
        }
      }
    }

    if (ready.length > 0) {
      const totalTargets = ready.reduce((sum, item) => sum + item.targets.length, 0);
      log.info(`PostSessionQueue: processed ${totalTargets} delayed DMs`);
    }
  }

  /** Periodic scheduled evaluation — called every 1 hour */
  async evaluateScheduled(): Promise<void> {
    if (this.triggers.length === 0) {
      await this.refreshTriggers();
    }

    log.info('Scheduled trigger evaluation starting...');

    // Get unique account IDs
    const accountIds = [...new Set(this.triggers.map((t) => t.account_id))];

    for (const accountId of accountIds) {
      try {
        await this.evaluateScheduledForAccount(accountId);
      } catch (err) {
        log.error(`Scheduled eval failed for account ${accountId}: ${err}`);
      }
    }

    log.info('Scheduled trigger evaluation complete');
  }

  private async evaluateScheduledForAccount(accountId: string): Promise<void> {
    // UC-031: Churn risk
    const churnTriggers = this.getTriggersForType('churn_risk', accountId);
    for (const trigger of churnTriggers) {
      try {
        const result = await evaluateChurnRisk(trigger, accountId);
        if (result.shouldFire) {
          for (const ctx of result.targets) {
            await this.fireTrigger(trigger, ctx);
          }
        }
      } catch (err) {
        log.error(`churn_risk eval error: ${err}`);
      }
    }

    // UC-036: Segment upgrade
    const segUpTriggers = this.getTriggersForType('segment_upgrade', accountId);
    for (const trigger of segUpTriggers) {
      try {
        const result = await evaluateSegmentUpgrade(trigger, accountId);
        if (result.shouldFire) {
          for (const ctx of result.targets) {
            await this.fireTrigger(trigger, ctx);
          }
        }
      } catch (err) {
        log.error(`segment_upgrade eval error: ${err}`);
      }
    }

    // UC-037: Competitor outflow
    const compTriggers = this.getTriggersForType('competitor_outflow', accountId);
    for (const trigger of compTriggers) {
      try {
        const result = await evaluateCompetitorOutflow(trigger, accountId);
        if (result.shouldFire) {
          for (const ctx of result.targets) {
            await this.fireTrigger(trigger, ctx);
          }
        }
      } catch (err) {
        log.error(`competitor_outflow eval error: ${err}`);
      }
    }

    // UC-040: Cross promotion
    const crossTriggers = this.getTriggersForType('cross_promotion', accountId);
    for (const trigger of crossTriggers) {
      try {
        const result = await evaluateCrossPromotion(trigger, accountId);
        if (result.shouldFire) {
          for (const ctx of result.targets) {
            await this.fireTrigger(trigger, ctx);
          }
        }
      } catch (err) {
        log.error(`cross_promotion eval error: ${err}`);
      }
    }
  }

  /** Increment warmup counter — called from main loop */
  incrementWarmup(): void {
    if (this.warmupCycles < this.WARMUP_THRESHOLD) {
      this.warmupCycles++;
      if (this.warmupCycles === this.WARMUP_THRESHOLD) {
        log.info('TriggerEngine: warmup complete, event triggers active');
      }
    }
  }

  /** Initialize segment snapshots for scheduled evaluations */
  async initSnapshots(accountId: string): Promise<void> {
    await initSegmentSnapshot(accountId);
  }

  /** Core: validate constraints and fire the trigger */
  private async fireTrigger(trigger: DmTrigger, ctx: TriggerContext): Promise<void> {
    const sb = getSupabase();

    // 1. Segment filter
    if (!isSegmentAllowed(trigger.target_segments, ctx.segment)) {
      await this.logTriggerAction(trigger, ctx, 'skipped_segment');
      return;
    }

    // 2. Cooldown check
    if (await isInCooldown(trigger.id, ctx.userName, trigger.cooldown_hours)) {
      await this.logTriggerAction(trigger, ctx, 'skipped_cooldown');
      return;
    }

    // 3. Daily limit check
    if (await isDailyLimitReached(trigger.id, trigger.daily_limit)) {
      await this.logTriggerAction(trigger, ctx, 'skipped_daily_limit');
      return;
    }

    // 4. Execute action
    if (trigger.action_type === 'direct_dm') {
      const message = trigger.message_template
        ? renderTemplate(trigger.message_template, ctx)
        : `Hi ${ctx.userName}!`;

      // Insert into dm_send_log
      const { data: dmRow, error: dmError } = await sb
        .from('dm_send_log')
        .insert({
          account_id: ctx.accountId,
          cast_name: ctx.castName,
          user_name: ctx.userName,
          message,
          status: 'queued',
          campaign: `trigger_${trigger.trigger_type}_${trigger.id.substring(0, 8)}`,
          template_name: trigger.trigger_name,
        })
        .select('id')
        .single();

      if (dmError) {
        log.error(`DM insert failed for ${ctx.userName}: ${dmError.message}`);
        await this.logTriggerAction(trigger, ctx, 'error', undefined, dmError.message);
        return;
      }

      const dmLogId = dmRow?.id;
      await this.logTriggerAction(trigger, ctx, 'dm_queued', dmLogId);
      log.info(`TRIGGER [${trigger.trigger_name}] → DM queued for ${ctx.userName} (${ctx.castName})`);
    } else if (trigger.action_type === 'enroll_scenario') {
      // Enroll into dm_scenario_enrollments
      if (!trigger.scenario_id) {
        await this.logTriggerAction(trigger, ctx, 'error', undefined, 'scenario_id is null');
        return;
      }

      const { data: enrollment, error: enrollError } = await sb
        .from('dm_scenario_enrollments')
        .upsert(
          {
            scenario_id: trigger.scenario_id,
            account_id: ctx.accountId,
            cast_name: ctx.castName,
            username: ctx.userName,
            enrolled_at: new Date().toISOString(),
            current_step: 0,
            status: 'active',
            next_step_due_at: new Date().toISOString(),
          },
          { onConflict: 'scenario_id,username,cast_name', ignoreDuplicates: true },
        )
        .select('id')
        .single();

      if (enrollError) {
        // ignoreDuplicates may return null data — that's ok, it means already enrolled
        if (enrollError.code === 'PGRST116') {
          await this.logTriggerAction(trigger, ctx, 'skipped_duplicate');
          return;
        }
        log.error(`Scenario enrollment failed for ${ctx.userName}: ${enrollError.message}`);
        await this.logTriggerAction(trigger, ctx, 'error', undefined, enrollError.message);
        return;
      }

      await this.logTriggerAction(trigger, ctx, 'scenario_enrolled', undefined, undefined, enrollment?.id);
      log.info(`TRIGGER [${trigger.trigger_name}] → Scenario enrolled for ${ctx.userName}`);
    }
  }

  /** Write a trigger log entry */
  private async logTriggerAction(
    trigger: DmTrigger,
    ctx: TriggerContext,
    actionTaken: ActionTaken,
    dmSendLogId?: number,
    errorMessage?: string,
    enrollmentId?: string,
  ): Promise<void> {
    const sb = getSupabase();

    const { error } = await sb.from('dm_trigger_logs').insert({
      trigger_id: trigger.id,
      account_id: ctx.accountId,
      cast_name: ctx.castName,
      user_name: ctx.userName,
      action_taken: actionTaken,
      dm_send_log_id: dmSendLogId ?? null,
      enrollment_id: enrollmentId ?? null,
      error_message: errorMessage || null,
      metadata: {
        trigger_type: trigger.trigger_type,
        segment: ctx.segment || null,
        tokens: ctx.totalTokens || 0,
      },
    });

    if (error) {
      log.error(`Trigger log insert failed: ${error.message}`);
    }
  }
}
