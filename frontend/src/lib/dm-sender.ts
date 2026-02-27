import type { SupabaseClient } from '@supabase/supabase-js';
import { checkDailyDmLimit, checkCampaignLimit, getRemainingDailyQuota } from './dm-safety';

export interface QueueTarget {
  username: string;
  message: string;
  imageUrl?: string;
}

interface QueueResult {
  queued: number;
  skipped: number;
  skippedUsers: string[];
  blockedByLimit: number;
  batchId: string;
  limitReason?: string;
}

interface DuplicateCheckResult {
  duplicates: string[];
  duplicate_count: number;
  checked_count: number;
}

/**
 * P0-5: 24時間以内の重複チェック
 * 同一キャスト + 同一ユーザーに24h以内にDM送信済みならスキップ
 */
export async function checkDmDuplicates(
  supabase: SupabaseClient,
  accountId: string,
  castName: string,
  usernames: string[],
  hours = 24,
): Promise<DuplicateCheckResult> {
  try {
    const { data, error } = await supabase.rpc('check_dm_duplicate', {
      p_account_id: accountId,
      p_cast_name: castName,
      p_user_names: usernames,
      p_hours: hours,
    });

    if (error || !data) {
      console.warn('[dm-sender] Duplicate check RPC failed, skipping check:', error?.message);
      return { duplicates: [], duplicate_count: 0, checked_count: usernames.length };
    }

    return {
      duplicates: data.duplicates || [],
      duplicate_count: data.duplicate_count || 0,
      checked_count: data.checked_count || usernames.length,
    };
  } catch {
    // RPC未作成でも続行（フォールバック: チェックなし）
    return { duplicates: [], duplicate_count: 0, checked_count: usernames.length };
  }
}

/**
 * DM送信キューに一括登録する汎用ユーティリティ。
 * P0-5: 24時間以内の重複を自動スキップ。
 * RPC create_dm_batch を試行し、失敗時は直接INSERTにフォールバック。
 */
export async function queueDmBatch(
  supabase: SupabaseClient,
  accountId: string,
  castName: string,
  targets: QueueTarget[],
  campaign: string,
  options: { skipDuplicates?: boolean; campaignMaxCount?: number } = {},
): Promise<QueueResult> {
  if (targets.length === 0) throw new Error('送信対象が0件です');

  const { skipDuplicates = true, campaignMaxCount } = options;
  const now = new Date();
  let usernames = targets.map(t => t.username);
  let filteredTargets = [...targets];
  let skipped = 0;
  let skippedUsers: string[] = [];
  let blockedByLimit = 0;

  // P0-5: 1日あたりの送信上限チェック
  const dailyCheck = await checkDailyDmLimit(supabase, accountId);
  if (!dailyCheck.allowed) {
    // 全件をblocked_by_limitとして記録
    const rows = targets.map(t => ({
      account_id: accountId,
      cast_name: castName,
      user_name: t.username,
      message: t.message,
      image_sent: !!t.imageUrl,
      status: 'blocked_by_limit',
      campaign,
      queued_at: now.toISOString(),
      error: dailyCheck.reason,
    }));
    await supabase.from('dm_send_log').insert(rows);
    return {
      queued: 0,
      skipped: 0,
      blockedByLimit: targets.length,
      skippedUsers: [],
      batchId: campaign,
      limitReason: dailyCheck.reason,
    };
  }

  // P0-5: campaign単位の送信数制限チェック
  if (campaignMaxCount) {
    const campCheck = await checkCampaignLimit(supabase, accountId, campaign, campaignMaxCount);
    if (!campCheck.allowed) {
      const rows = targets.map(t => ({
        account_id: accountId,
        cast_name: castName,
        user_name: t.username,
        message: t.message,
        image_sent: !!t.imageUrl,
        status: 'blocked_by_limit',
        campaign,
        queued_at: now.toISOString(),
        error: campCheck.reason,
      }));
      await supabase.from('dm_send_log').insert(rows);
      return {
        queued: 0,
        skipped: 0,
        blockedByLimit: targets.length,
        skippedUsers: [],
        batchId: campaign,
        limitReason: campCheck.reason,
      };
    }
  }

  // P0-5: 日次残数を超える分をトリミング
  const remaining = getRemainingDailyQuota(dailyCheck);
  if (filteredTargets.length > remaining) {
    const overflowTargets = filteredTargets.slice(remaining);
    blockedByLimit = overflowTargets.length;
    filteredTargets = filteredTargets.slice(0, remaining);
    usernames = filteredTargets.map(t => t.username);

    // 超過分をblocked_by_limitとして記録
    const overflowRows = overflowTargets.map(t => ({
      account_id: accountId,
      cast_name: castName,
      user_name: t.username,
      message: t.message,
      image_sent: !!t.imageUrl,
      status: 'blocked_by_limit',
      campaign,
      queued_at: now.toISOString(),
      error: `1日あたりの送信上限(${dailyCheck.limit.toLocaleString()}件)超過`,
    }));
    await supabase.from('dm_send_log').insert(overflowRows);

    console.info(
      `[dm-sender] 日次上限トリミング: ${blockedByLimit}件をblocked_by_limitに設定`,
    );
  }

  // P0-5: 送信前に重複チェック
  if (skipDuplicates && castName) {
    const dupCheck = await checkDmDuplicates(supabase, accountId, castName, usernames);
    if (dupCheck.duplicate_count > 0) {
      const dupSet = new Set(dupCheck.duplicates);
      skippedUsers = dupCheck.duplicates;
      skipped = dupCheck.duplicate_count;
      filteredTargets = targets.filter(t => !dupSet.has(t.username));
      usernames = filteredTargets.map(t => t.username);

      console.info(
        `[dm-sender] 重複スキップ: ${skipped}件 (${skippedUsers.join(', ')})`,
      );

      // 全員スキップされた場合
      if (filteredTargets.length === 0) {
        return { queued: 0, skipped, skippedUsers, blockedByLimit: 0, batchId: campaign };
      }
    }
  }

  const firstMessage = filteredTargets[0].message;
  const allSameMessage = filteredTargets.every(t => t.message === firstMessage);

  let batchId = campaign;
  let count = filteredTargets.length;
  let usedRpc = false;

  // Step 1: RPC で一括登録を試行（全員同一メッセージ＆画像なしの場合のみ）
  const hasImage = targets.some(t => t.imageUrl);
  if (allSameMessage && !hasImage) {
    try {
      const { data, error: rpcErr } = await supabase.rpc('create_dm_batch', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_targets: usernames,
        p_message: firstMessage,
        p_template_name: null,
        p_skip_duplicates: false, // 既にアプリ側でチェック済み
      });

      if (!rpcErr && data && !data.error) {
        batchId = data.batch_id || campaign;
        count = data.count || filteredTargets.length;
        usedRpc = true;
      } else if (data?.error) {
        throw new Error(`${data.error} (使用済み: ${data.used}/${data.limit})`);
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('使用済み')) throw e;
      console.warn('[dm-sender] RPC fallback:', e);
    }
  }

  // Step 2: RPC未使用 → 直接INSERT
  if (!usedRpc) {
    const rows = filteredTargets.map(t => ({
      account_id: accountId,
      cast_name: castName,
      user_name: t.username,
      message: t.message,
      image_url: t.imageUrl || null,
      image_sent: !!t.imageUrl,
      status: 'queued',
      campaign: campaign,
      queued_at: now.toISOString(),
    }));

    const { data: insertData, error: insertErr } = await supabase
      .from('dm_send_log')
      .insert(rows)
      .select('id');

    if (insertErr) {
      throw new Error(`キュー登録失敗: ${insertErr.message}`);
    }
    count = insertData?.length || filteredTargets.length;
  }

  // Step 3: RPC使用時はcampaignを上書き + cast_name補完
  if (usedRpc && batchId !== campaign) {
    await supabase.from('dm_send_log')
      .update({ campaign, cast_name: castName })
      .eq('campaign', batchId);
    batchId = campaign;
  }

  return { queued: count, skipped, skippedUsers, blockedByLimit, batchId };
}
