import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { StripchatAPI } from '@/lib/stripchat-api';
import { checkDailyDmLimit } from '@/lib/dm-safety';
import { reportError } from '@/lib/error-handler';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  const supabase = createServerSupabase();

  // 認証チェック: cookie-based session
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: '認証が必要です', detail: authError?.message }, { status: 401 });
  }

  let body: { account_id: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { account_id, limit = 20 } = body;
  if (!account_id) {
    return NextResponse.json({ error: 'account_id is required' }, { status: 400 });
  }

  // 所有権チェック: user_idが一致するaccountか確認
  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', account_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!account) {
    return NextResponse.json({ error: 'Account not found or access denied' }, { status: 403 });
  }

  // P0-5: 日次送信上限チェック
  const dailyCheck = await checkDailyDmLimit(supabase, account_id);
  if (!dailyCheck.allowed) {
    return NextResponse.json({
      processed: 0,
      success: 0,
      error_count: 0,
      remaining: 0,
      blocked_by_limit: true,
      message: dailyCheck.reason,
    }, { status: 429 });
  }

  // 有効なセッション取得
  const { data: session } = await supabase
    .from('stripchat_sessions')
    .select('*')
    .eq('account_id', account_id)
    .eq('is_valid', true)
    .maybeSingle();

  if (!session) {
    return NextResponse.json(
      {
        error: 'No active Stripchat session',
        fallback: 'extension',
        detail: 'Chrome拡張を開いてセッションを同期してください',
      },
      { status: 400 },
    );
  }

  // P0-5: キャスト身元検証 — セッションのstripchat_user_idとregistered_castsの照合
  // バッチ処理開始前に、このアカウントの全登録キャストを取得してルックアップ用マップを構築
  const castIdentityMap = new Map<string, string>();
  if (session.stripchat_user_id) {
    const { data: registeredCasts } = await supabase
      .from('registered_casts')
      .select('cast_name, stripchat_user_id')
      .eq('account_id', account_id)
      .eq('is_active', true)
      .not('stripchat_user_id', 'is', null);

    if (registeredCasts) {
      for (const rc of registeredCasts) {
        castIdentityMap.set(rc.cast_name, String(rc.stripchat_user_id));
      }
    }
  }

  // キューから取得
  const { data: tasks, error: fetchErr } = await supabase
    .from('dm_send_log')
    .select('id, user_name, message, campaign, cast_name')
    .eq('account_id', account_id)
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(Math.min(limit, 50));

  if (fetchErr || !tasks || tasks.length === 0) {
    return NextResponse.json({
      processed: 0,
      success: 0,
      error_count: 0,
      remaining: 0,
      message: 'キューにDMがありません',
    });
  }

  // StripchatAPI インスタンス
  const api = new StripchatAPI({
    id: session.id,
    session_cookie: session.session_cookie,
    csrf_token: session.csrf_token,
    csrf_timestamp: session.csrf_timestamp,
    stripchat_user_id: session.stripchat_user_id,
    front_version: session.front_version,
    cookies_json: session.cookies_json || {},
    jwt_token: session.jwt_token,
  });

  // バッチ処理（/api/dm/send を呼ばず直接処理）
  let successCount = 0;
  let errorCount = 0;
  const errors: Array<{ user_name: string; error: string }> = [];

  for (const task of tasks) {
    // status を sending に更新
    await supabase
      .from('dm_send_log')
      .update({ status: 'sending', sent_via: 'api' })
      .eq('id', task.id);

    // P0-5: タスクごとのキャスト身元検証ゲート
    if (task.cast_name && session.stripchat_user_id) {
      const registeredId = castIdentityMap.get(task.cast_name);
      if (registeredId && registeredId !== String(session.stripchat_user_id)) {
        errorCount++;
        const mismatchErr = `CAST_IDENTITY_MISMATCH: cast=${task.cast_name}(ID:${registeredId}) != session(${session.stripchat_user_id})`;
        errors.push({ user_name: task.user_name, error: mismatchErr });
        await supabase
          .from('dm_send_log')
          .update({ status: 'error', sent_via: 'api', error: mismatchErr })
          .eq('id', task.id);

        // 身元不一致は全件停止（同一セッションで全タスク同じ結果になるため）
        const currentIdx = tasks.indexOf(task);
        for (let i = currentIdx + 1; i < tasks.length; i++) {
          await supabase
            .from('dm_send_log')
            .update({ status: 'error', error: mismatchErr })
            .eq('id', tasks[i].id);
        }
        errorCount += tasks.length - currentIdx - 1;

        return NextResponse.json({
          processed: errorCount,
          success: 0,
          error_count: errorCount,
          remaining: 0,
          cast_identity_mismatch: true,
          errors,
        }, { status: 403 });
      }
    }

    try {
      // userId 解決
      const { userId: targetUserId, error: resolveError } =
        await api.resolveUserId(task.user_name, supabase);

      if (!targetUserId) {
        errorCount++;
        errors.push({ user_name: task.user_name, error: `userId解決失敗: ${resolveError}` });
        await supabase
          .from('dm_send_log')
          .update({ status: 'error', error: `userId解決失敗: ${resolveError}` })
          .eq('id', task.id);
        continue;
      }

      // DM送信
      const result = await api.sendDM(targetUserId, task.message, task.user_name);

      if (result.success) {
        successCount++;
        await supabase
          .from('dm_send_log')
          .update({
            status: 'success',
            sent_via: 'api',
            sent_at: new Date().toISOString(),
            error: null,
          })
          .eq('id', task.id);
      } else {
        errorCount++;
        errors.push({ user_name: task.user_name, error: result.error || 'Unknown error' });
        await supabase
          .from('dm_send_log')
          .update({ status: 'error', sent_via: 'api', error: result.error })
          .eq('id', task.id);

        // セッション切れならバッチ全体を中断
        if (result.sessionExpired) {
          await supabase
            .from('stripchat_sessions')
            .update({ is_valid: false, updated_at: new Date().toISOString() })
            .eq('id', session.id);

          // 残りをqueuedに戻す
          const currentIdx = tasks.indexOf(task);
          for (let i = currentIdx + 1; i < tasks.length; i++) {
            await supabase
              .from('dm_send_log')
              .update({ status: 'queued' })
              .eq('id', tasks[i].id);
          }

          return NextResponse.json({
            processed: successCount + errorCount,
            success: successCount,
            error_count: errorCount,
            remaining: tasks.length - successCount - errorCount,
            session_expired: true,
            fallback: 'extension',
            errors,
          });
        }
      }
    } catch (err) {
      errorCount++;
      errors.push({ user_name: task.user_name, error: String(err) });
      await supabase
        .from('dm_send_log')
        .update({ status: 'error', sent_via: 'api', error: String(err) })
        .eq('id', task.id);
      await reportError(err, { file: 'api/dm/batch', context: `DM送信 ${task.user_name}` });
    }

    // レート制限: 3秒間隔
    await sleep(3000);
  }

  // 残りのキュー数を取得
  const { count: remaining } = await supabase
    .from('dm_send_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', account_id)
    .eq('status', 'queued');

  return NextResponse.json({
    processed: successCount + errorCount,
    success: successCount,
    error_count: errorCount,
    remaining: remaining || 0,
    errors: errors.length > 0 ? errors : undefined,
  });
}
