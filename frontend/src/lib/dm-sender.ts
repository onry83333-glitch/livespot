import type { SupabaseClient } from '@supabase/supabase-js';

interface QueueTarget {
  username: string;
  message: string;
}

interface QueueResult {
  queued: number;
  batchId: string;
}

/**
 * DM送信キューに一括登録する汎用ユーティリティ。
 * RPC create_dm_batch を試行し、失敗時は直接INSERTにフォールバック。
 */
export async function queueDmBatch(
  supabase: SupabaseClient,
  accountId: string,
  castName: string,
  targets: QueueTarget[],
  campaign: string,
): Promise<QueueResult> {
  if (targets.length === 0) throw new Error('送信対象が0件です');

  const now = new Date();
  const usernames = targets.map(t => t.username);
  const firstMessage = targets[0].message;
  const allSameMessage = targets.every(t => t.message === firstMessage);

  let batchId = campaign;
  let count = targets.length;
  let usedRpc = false;

  // Step 1: RPC で一括登録を試行（全員同一メッセージの場合のみ）
  if (allSameMessage) {
    try {
      const { data, error: rpcErr } = await supabase.rpc('create_dm_batch', {
        p_account_id: accountId,
        p_cast_name: castName,
        p_targets: usernames,
        p_message: firstMessage,
        p_template_name: null,
      });

      if (!rpcErr && data && !data.error) {
        batchId = data.batch_id || campaign;
        count = data.count || targets.length;
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
    const rows = targets.map(t => ({
      account_id: accountId,
      cast_name: castName,
      user_name: t.username,
      message: t.message,
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
    count = insertData?.length || targets.length;
  }

  // Step 3: RPC使用時はcampaignを上書き + cast_name補完
  if (usedRpc && batchId !== campaign) {
    await supabase.from('dm_send_log')
      .update({ campaign, cast_name: castName })
      .eq('campaign', batchId);
    batchId = campaign;
  }

  return { queued: count, batchId };
}
