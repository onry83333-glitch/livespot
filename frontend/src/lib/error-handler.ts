/**
 * error-handler.ts — SLS 共通エラーTelegram通知
 *
 * サーバーサイド専用（API Routes / Server Components）。
 * フォーマット: ❗ [SLS] エラー内容 / ファイル / スタックトレース
 *
 * 使い方:
 *   import { reportError } from '@/lib/error-handler';
 *
 *   try { ... } catch (err) {
 *     await reportError(err, { file: 'api/dm/send', context: 'DM送信中' });
 *   }
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8050153948';
const PROJECT = 'SLS';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function reportError(
  error: unknown,
  opts: { file?: string; context?: string } = {},
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[error-handler] Telegram not configured');
    return false;
  }

  const errMsg =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack || '' : '';

  const lines: string[] = [`❗ [${PROJECT}] <b>エラー発生</b>`];
  lines.push(`<code>${escapeHtml(errMsg.slice(0, 500))}</code>`);

  if (opts.file) {
    lines.push(`📄 ${opts.file}`);
  }
  if (opts.context) {
    lines.push(`💬 ${opts.context}`);
  }
  if (stack) {
    const trimmed = stack.slice(0, 800);
    lines.push(`\n<pre>${escapeHtml(trimmed)}</pre>`);
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: lines.join('\n'),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      console.warn(`[error-handler] Telegram HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (sendErr) {
    console.warn('[error-handler] Telegram send failed:', sendErr);
    return false;
  }
}
