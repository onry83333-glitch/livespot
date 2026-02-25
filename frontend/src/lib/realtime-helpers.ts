/**
 * Supabase Realtime subscribe ヘルパー
 * TIMED_OUT対策: タイムアウト延長(30秒) + 1回リトライ
 */
const SUBSCRIBE_TIMEOUT = 30000; // 30秒（デフォルト10秒）
const MAX_RETRIES = 1;

type Channel = {
  subscribe: (callback?: (status: string, err?: Error) => void, timeout?: number) => unknown;
  state: string;
};

/**
 * チャネルをsubscribeし、TIMED_OUT時に1回リトライする
 */
export function subscribeWithRetry(
  channel: Channel,
  onStatus?: (status: string, err?: Error) => void,
): void {
  let retries = 0;

  const doSubscribe = () => {
    channel.subscribe((status: string, err?: Error) => {
      console.log(`[Realtime] subscribe status: ${status}`, err?.message || '');

      if (status === 'TIMED_OUT' && retries < MAX_RETRIES) {
        retries++;
        console.warn(`[Realtime] TIMED_OUT, retry ${retries}/${MAX_RETRIES}...`);
        // 少し待ってからリトライ
        setTimeout(doSubscribe, 2000);
        return;
      }

      onStatus?.(status, err);
    }, SUBSCRIBE_TIMEOUT);
  };

  doSubscribe();
}
