# Stripchat JWT/Cookie 自動取得 — 調査結果と実装

## 概要

Stripchat WebSocket (Centrifugo v3) への接続にはJWTトークンが必須。
手動でDevToolsからコピーする運用は非持続的なため、自動取得の仕組みを実装した。

## 発見事項

### 2つのWebSocketプロトコル

| 項目 | Centrifugo v3 | Bayeux/CometD |
|---|---|---|
| URL | `wss://websocket-sp-v6.stripchat.com/connection/websocket` | `wss://websocket.stripchat.com/...` |
| 認証 | JWT必須 | 認証不要（clientId自動発行） |
| 接続手順 | `{"connect":{"token":"JWT","name":"js"},"id":1}` → subscribe | `/meta/handshake` → `/meta/subscribe` |
| チャンネル形式 | `{event}@{modelId}` | `{event}:{modelId}` |
| Keepalive | `{}` 双方向 25秒 | `/meta/connect` ロングポーリング |

現在の実装はCentrifugo v3を使用（`ws-client.ts`, `poc.ts`）。

### Centrifugo JWT構造

```
Header: { "alg": "HS256", "typ": "JWT" }
Payload: {
  "sub": "guest_xxxxx",     // ユーザーID（ゲストでも発行される）
  "exp": 1740000000,        // 有効期限（Unix秒）
  "iss": "stripchat",
  "channels": {...}          // 購読可能チャンネル
}
```

- ゲスト（非ログイン）アクセスでもJWTが発行される
- 有効期限は通常1〜2時間
- `exp` をデコードして期限管理が可能

### JWTの取得元

1. **ページHTML** (`__PRELOADED_STATE__`)
   - `https://stripchat.com/{modelName}` をGET
   - HTML内の `window.__PRELOADED_STATE__ = {...};` をパース
   - 既知のパス: `state.config.centrifugoToken`, `state.configV3.centrifugoToken`, etc.
   - JWT-like文字列（`eyJ...`）のディープスキャンも実装

2. **REST API** (`/api/front/v2/config`)
   - `https://stripchat.com/api/front/v2/config` をGET
   - レスポンスJSONから `centrifugoToken` を検索
   - WebSocket URLも同時に取得可能

3. **Playwright** (最終手段)
   - Cloudflareがfetchを拒否する場合のみ
   - headless Chromiumでアクセス → Cookie + JWTを抽出
   - 現在はプレースホルダー実装（未使用）

## 実装アーキテクチャ

### フォールバックチェーン

```
getAuth(modelName?)
  ├─ 1. メモリキャッシュ（JWT有効期限 - 5分マージン）
  ├─ 2. 方式C: ページHTML → __PRELOADED_STATE__
  ├─ 3. 方式B: REST API /config
  ├─ 4. .envフォールバック（STRIPCHAT_JWT 手動設定）
  └─ 5. 全失敗 → 空JWT（WS接続は3501で拒否される）
```

### ファイル構成

```
collector/src/auth/
  ├── stripchat-auth.ts   # 方式B/C実装 + JWTデコード + ヘルパー
  └── index.ts            # 統合モジュール（キャッシュ + フォールバック制御）
```

### キャッシュ戦略

- **メモリ内キャッシュ**: `cachedAuth` 変数
- **有効期限**: JWTの `exp` クレームから取得、5分前にリフレッシュ
- **無効化**: `invalidateAuth()` で手動クリア（WS auth error時）
- **自動リフレッシュ**: WsClient `onAuthError` コールバック → cache invalidate → re-fetch → reconnect

### WsClient統合

```typescript
// collector.ts
const auth = await getAuth();
const client = new StripchatWsClient(
  castName,
  modelId,
  handler,
  auth.jwt,           // ← Centrifugo JWT
  () => handleAuthError(state),  // ← 3501エラー時のコールバック
);
```

WsClientの接続フロー（修正後）:
1. `ws.on('open')` → `{"connect":{"token":"JWT","name":"js"},"id":1}` 送信
2. `{"connect":{"client":"..."},"id":1}` 受信 → 接続成功
3. チャンネルにsubscribe
4. `{"error":{"code":3501}}` 受信 → `onAuthError()` → トークン再取得 → 再接続

## 使用方法

### PoC (手動テスト)

```bash
# 自動認証（デフォルト）
npx tsx src/poc.ts --cast-name Risa_06

# 手動認証（auto-authが失敗する場合）
npx tsx src/poc.ts --no-auto-auth --token "eyJ..." --cookie "cf_clearance=..."
```

### Collector (本番)

```bash
npx tsx src/index.ts
# → startCollector() が自動でgetAuth()を呼び、JWTをキャッシュ
# → 各キャストのWS接続にJWTを渡す
# → auth error時は自動で再取得+再接続
```

### .env設定

```env
# デフォルト: 自動取得（設定不要）
AUTH_AUTO_REFRESH=true

# 自動取得が失敗する場合のフォールバック:
STRIPCHAT_JWT=eyJ...
STRIPCHAT_CF_CLEARANCE=xxx
```

## 既知の制限

1. **Cloudflare Bot検知**: サーバーIPからの大量アクセスは403になる可能性
   - 対策: User-Agent偽装、リクエスト間隔調整
   - 最終手段: Playwright方式（未実装）

2. **ゲストJWTの制限**: ログインユーザーJWTと比べて購読できるイベントが制限される可能性
   - 現時点では `newChatMessage`, `newModelEvent`, `userUpdated` は取得可能

3. **レート制限**: 短時間に複数キャストのページを取得するとブロックされる可能性
   - 対策: JWTキャッシュで再取得頻度を最小化（通常1-2時間に1回）

## 変更履歴

- 2026-02-23: 初版作成（方式B/C実装、ws-client.ts修正、collector.ts統合）
