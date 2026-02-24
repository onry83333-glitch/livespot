/**
 * triggers/template.ts — Template variable substitution for DM triggers
 */

import type { TriggerContext } from './types.js';

/**
 * Supported template variables:
 * {username}            — target user name
 * {cast_name}           — cast name
 * {total_tokens}        — user's total historical tokens
 * {session_tokens}      — tokens from current session
 * {segment}             — current segment (S1-S10)
 * {previous_segment}    — previous segment (for upgrade triggers)
 * {days_since_last_visit} — days since last visit
 */
export function renderTemplate(template: string, ctx: TriggerContext): string {
  return template
    .replace(/\{username\}/g, ctx.userName)
    .replace(/\{cast_name\}/g, ctx.castName)
    .replace(/\{total_tokens\}/g, String(ctx.totalTokens ?? 0))
    .replace(/\{session_tokens\}/g, String(ctx.sessionTokens ?? 0))
    .replace(/\{segment\}/g, ctx.segment ?? '')
    .replace(/\{previous_segment\}/g, ctx.previousSegment ?? '')
    .replace(/\{days_since_last_visit\}/g, String(ctx.daysSinceLastVisit ?? 0));
}
