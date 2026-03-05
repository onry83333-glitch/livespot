/**
 * dm-guard.ts — DM送信安全ゲート（Collector版）
 *
 * インシデント対策: テストDMが本物の顧客に送信された問題を防止する
 *
 * 1. DM_TEST_MODE: デフォルトON。テスト時はホワイトリスト以外への送信をブロック
 * 2. campaign必須: campaign_idなしのDMは送信拒否
 * 3. DM_TRIGGER_ENABLED: トリガーDM（campaign が trigger_ で始まる）の許可フラグ
 *    - DM_TEST_MODE=true でも DM_TRIGGER_ENABLED=true なら trigger_ campaignは通す
 *    - デフォルト: false（明示的にONにする必要あり）
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('dm-guard');

// ─── ホワイトリスト（テストモードで許可するユーザー名） ───
export const DM_TEST_WHITELIST = new Set([
  'pojipojipoji',
  'kantou1234',
  'Nekomeem34',
]);

export function isDmTestMode(): boolean {
  const val = process.env.DM_TEST_MODE ?? 'true';
  return !['false', 'off', '0'].includes(val.toLowerCase());
}

export function isDmTriggerEnabled(): boolean {
  const val = process.env.DM_TRIGGER_ENABLED ?? 'false';
  return ['true', 'on', '1'].includes(val.toLowerCase());
}

export class DmGuardError extends Error {
  constructor(
    message: string,
    public readonly code: 'TEST_MODE_BLOCKED' | 'CAMPAIGN_REQUIRED' | 'TRIGGER_DISABLED',
    public readonly blockedUsers?: string[],
  ) {
    super(message);
    this.name = 'DmGuardError';
  }
}

/**
 * 統合バリデーション。dm_send_log INSERT前に必ず呼ぶ。
 * ブロック対象がいる場合はDmGuardErrorをthrow。
 */
export function guardDmSend(
  userName: string,
  campaign: string | undefined | null,
): { allowed: boolean; isTestMode: boolean } {
  // 1. campaign必須チェック
  if (!campaign || campaign.trim() === '') {
    throw new DmGuardError(
      'campaign_idが指定されていません。全てのDM送信にはcampaign_idが必須です。',
      'CAMPAIGN_REQUIRED',
    );
  }

  // 2. トリガーDM: DM_TRIGGER_ENABLED で独立制御
  const isTriggerCampaign = campaign.startsWith('trigger_');
  if (isTriggerCampaign) {
    if (!isDmTriggerEnabled()) {
      log.info(`[DM_TRIGGER] ブロック: DM_TRIGGER_ENABLED=false — ${userName} (${campaign})`);
      throw new DmGuardError(
        `トリガーDMは無効です。DM_TRIGGER_ENABLED=true で有効化してください。`,
        'TRIGGER_DISABLED',
        [userName],
      );
    }
    // トリガーDMが有効なら、テストモードに関係なく通す
    log.debug(`[DM_TRIGGER] 許可: ${userName} (${campaign})`);
    return { allowed: true, isTestMode: isDmTestMode() };
  }

  // 3. 通常DM: テストモード＋ホワイトリストチェック
  const isTestMode = isDmTestMode();

  if (isTestMode && !DM_TEST_WHITELIST.has(userName)) {
    log.warn(
      `[DM_TEST_MODE] ブロック: ${userName} はホワイトリスト外。許可: ${[...DM_TEST_WHITELIST].join(', ')}`,
    );
    throw new DmGuardError(
      `[DM_TEST_MODE] ${userName} はホワイトリスト外のためブロック`,
      'TEST_MODE_BLOCKED',
      [userName],
    );
  }

  return { allowed: true, isTestMode };
}
