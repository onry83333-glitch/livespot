/**
 * Auth Manager HTTP Server — localhost:3847
 *
 * エンドポイント:
 *   GET  /auth     → 現在の認証データを返す（JWT, cfClearance, expiresAt）
 *   GET  /health   → ヘルスチェック（有効残り秒数、リフレッシュ回数）
 *   POST /refresh  → 強制リフレッシュをトリガー
 */

import * as http from 'http';
import * as store from './store.js';

const PORT = parseInt(process.env.AUTH_MANAGER_PORT || '3847', 10);

let forceRefreshCallback: (() => Promise<void>) | null = null;

export function setRefreshCallback(cb: () => Promise<void>): void {
  forceRefreshCallback = cb;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // CORS for local development
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (method === 'GET' && url === '/auth') {
    const auth = store.get();
    if (!auth || !store.isValid()) {
      jsonResponse(res, 503, { ok: false, error: 'No valid auth available' });
      return;
    }
    jsonResponse(res, 200, {
      ok: true,
      jwt: auth.jwt,
      cfClearance: auth.cfClearance,
      wsUrl: auth.wsUrl,
      userId: auth.userId,
      expiresAt: auth.expiresAt,
      method: auth.method,
      remainingSeconds: store.remainingSeconds(),
    });
    return;
  }

  if (method === 'GET' && url === '/health') {
    const auth = store.get();
    jsonResponse(res, 200, {
      ok: true,
      status: store.isValid() ? 'healthy' : 'expired',
      remainingSeconds: store.remainingSeconds(),
      refreshCount: auth?.refreshCount ?? 0,
      acquiredAt: auth?.acquiredAt ?? null,
      method: auth?.method ?? null,
    });
    return;
  }

  if (method === 'POST' && url === '/refresh') {
    if (!forceRefreshCallback) {
      jsonResponse(res, 500, { ok: false, error: 'Refresh callback not set' });
      return;
    }
    forceRefreshCallback()
      .then(() => {
        const auth = store.get();
        jsonResponse(res, 200, {
          ok: true,
          message: 'Refresh completed',
          remainingSeconds: store.remainingSeconds(),
          method: auth?.method ?? null,
        });
      })
      .catch((err) => {
        jsonResponse(res, 500, { ok: false, error: String(err) });
      });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: 'Not found' });
}

export function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[auth-manager] Port ${PORT} already in use — another auth-manager running?`);
        reject(err);
      } else {
        reject(err);
      }
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[auth-manager] HTTP server listening on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

export { PORT };
