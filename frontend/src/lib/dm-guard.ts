/**
 * dm-guard.ts — DM送信安全ゲート
 *
 * インシデント対策: テストDMが本物の顧客に送信された問題を防止する
 *
 * 1. DM_TEST_MODE: デフォルトON。テスト時はホワイトリスト以外への送信をブロック
 * 2. campaign必須: campaign_idなしのDMは送信拒否
 * 3. 送信先プレビュー: UI側で呼び出す検証関数を提供
 */

// ─── ホワイトリスト（テストモードで許可するユーザー名） ───
export const DM_TEST_WHITELIST = new Set([
  'pojipojipoji',
  'kantou1234',
  'Nekomeem34',
]);

// ─── テストモード判定 ───
export function isDmTestMode(): boolean {
  // DM_TEST_MODE が明示的に "false" or "off" or "0" のときだけ本番モード
  // 未設定 or それ以外の値 → テストモードON（安全側デフォルト）
  const val =
    (typeof process !== 'undefined' && process.env?.DM_TEST_MODE) ||
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_DM_TEST_MODE) ||
    'true';

  return !['false', 'off', '0'].includes(val.toLowerCase());
}

// ─── エラー型 ───
export class DmGuardError extends Error {
  constructor(
    message: string,
    public readonly code: 'TEST_MODE_BLOCKED' | 'CAMPAIGN_REQUIRED',
    public readonly blockedUsers?: string[],
  ) {
    super(message);
    this.name = 'DmGuardError';
  }
}

// ─── 送信先バリデーション（テストモード時にホワイトリスト外をブロック） ───
export function validateDmTargets(usernames: string[]): {
  allowed: string[];
  blocked: string[];
  isTestMode: boolean;
} {
  const isTestMode = isDmTestMode();

  if (!isTestMode) {
    return { allowed: usernames, blocked: [], isTestMode };
  }

  const allowed: string[] = [];
  const blocked: string[] = [];

  for (const name of usernames) {
    if (DM_TEST_WHITELIST.has(name)) {
      allowed.push(name);
    } else {
      blocked.push(name);
    }
  }

  return { allowed, blocked, isTestMode };
}

// ─── campaign必須バリデーション ───
export function validateCampaignRequired(campaign: string | undefined | null): void {
  if (!campaign || campaign.trim() === '') {
    throw new DmGuardError(
      'campaign_idが指定されていません。全てのDM送信にはcampaign_idが必須です。',
      'CAMPAIGN_REQUIRED',
    );
  }
}

// ─── 統合バリデーション（INSERT前に必ず呼ぶ） ───
export function guardDmSend(
  usernames: string[],
  campaign: string | undefined | null,
): { allowed: string[]; blocked: string[]; isTestMode: boolean } {
  // 1. campaign必須チェック
  validateCampaignRequired(campaign);

  // 2. テストモード＋ホワイトリストチェック
  const result = validateDmTargets(usernames);

  if (result.isTestMode && result.blocked.length > 0) {
    const sample = result.blocked.slice(0, 5).join(', ');
    const suffix = result.blocked.length > 5 ? ` 他${result.blocked.length - 5}名` : '';
    throw new DmGuardError(
      `[DM_TEST_MODE] ホワイトリスト外のユーザーへの送信をブロックしました: ${sample}${suffix}（${result.blocked.length}名）。` +
        `許可ユーザー: ${Array.from(DM_TEST_WHITELIST).join(', ')}`,
      'TEST_MODE_BLOCKED',
      result.blocked,
    );
  }

  return result;
}

// ─── テストモード情報（UI表示用） ───
export function getDmGuardStatus(): {
  isTestMode: boolean;
  whitelist: string[];
} {
  return {
    isTestMode: isDmTestMode(),
    whitelist: Array.from(DM_TEST_WHITELIST),
  };
}
