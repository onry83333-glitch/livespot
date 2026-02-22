import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function POST(req: NextRequest) {
  // 認証
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const token = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    return NextResponse.json({ error: '認証トークンが無効です' }, { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

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

  // 有効なセッション確認
  const { data: session } = await supabase
    .from('stripchat_sessions')
    .select('id, is_valid')
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

  // バッチ処理
  let successCount = 0;
  let errorCount = 0;
  const errors: Array<{ user_name: string; error: string }> = [];

  // 内部URL構築（自身の /api/dm/send を呼ぶ）
  const origin = req.headers.get('origin') || req.headers.get('host') || '';
  const protocol = origin.startsWith('localhost') ? 'http' : 'https';
  const baseUrl = origin.startsWith('http') ? origin : `${protocol}://${origin}`;

  for (const task of tasks) {
    // status を sending に更新
    await supabase
      .from('dm_send_log')
      .update({ status: 'sending', sent_via: 'api' })
      .eq('id', task.id);

    try {
      const sendRes = await fetch(`${baseUrl}/api/dm/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          target_username: task.user_name,
          message: task.message,
          account_id,
          dm_log_id: task.id,
          campaign: task.campaign,
          cast_name: task.cast_name,
        }),
      });

      const sendData = await sendRes.json().catch(() => ({}));

      if (sendData.success) {
        successCount++;
      } else {
        errorCount++;
        errors.push({
          user_name: task.user_name,
          error: sendData.error || 'Unknown error',
        });

        // セッション切れならバッチ全体を中断
        if (sendData.fallback === 'extension' && sendRes.status === 401) {
          // 残りのタスクのステータスをqueuedに戻す
          const remainingIds = tasks
            .slice(tasks.indexOf(task) + 1)
            .map(t => t.id);
          if (remainingIds.length > 0) {
            // 個別に戻す（bulk update）
            for (const rid of remainingIds) {
              await supabase
                .from('dm_send_log')
                .update({ status: 'queued' })
                .eq('id', rid);
            }
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
      errors.push({
        user_name: task.user_name,
        error: String(err),
      });
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
