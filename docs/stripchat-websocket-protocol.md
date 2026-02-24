# Stripchat WebSocket/API リバースエンジニアリング レポート

**作成日**: 2026-02-23
**ステータス**: 調査完了 — 実装可能

---

## エグゼクティブサマリー

Stripchatのチャットリアルタイム配信は **Bayeux/CometD風カスタムプロトコル** をWebSocket上で実装している。
現行Chrome拡張（content_spy.js）はDOM MutationObserverによる100%クライアントサイド監視であり、
WebSocket直接接続に切り替えることで **Chrome不要のNode.jsサーバーサイド監視** が実現可能。

### アーキテクチャ概要
```
┌─────────────────────────────────────┐
│  Stripchat Infrastructure           │
│                                     │
│  REST API (front/v2)                │ ← モデル情報・設定取得
│  WebSocket (websocket.stripchat.com)│ ← リアルタイムイベント
│  HLS CDN (doppiocdn.com)            │ ← 動画ストリーミング (Flashphoner)
└─────────────────────────────────────┘
```

- **REST API**: `https://stripchat.com/api/front/v2/` — モデル情報、視聴者リスト、設定
- **WebSocket**: `wss://websocket.stripchat.com/...` — チャット・チップ・イベント配信
- **HLS**: `https://b-{server}.doppiocdn.com/hls/` — 動画配信（Flashphoner WCS）

**重要**: FlashphonerはHLS動画配信専用。チャットWebSocketはStripchat独自実装。

---

## 1. WebSocket接続先URL

### ドメイン
```
websocket.stripchat.com
```
- Cloudflare CDN経由（IP: 104.17.121.115 / 104.17.122.115）
- プロトコル: `wss://` (TLS暗号化WebSocket)

### URL取得方法
WebSocket URLは **動的に生成** される。取得方法：

**方法A: ページHTML内の `__PRELOADED_STATE__`**
```javascript
// Stripchatモデルページを取得
const html = await fetch('https://stripchat.com/{modelName}');
const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.+?});/s);
const state = JSON.parse(match[1]);
// state.configV3 内にWebSocketサーバー設定あり
```

**方法B: Chrome DevToolsで確認**
1. モデルページを開く
2. DevTools > Network > WS タブ
3. `websocket.stripchat.com` への接続を確認
4. URLの完全パスとクエリパラメータを記録

### モデルID取得
```
GET https://stripchat.com/api/front/v2/models/username/{modelName}/cam
```
レスポンス: `user.user.id` = 数値モデルID（例: `178845750`）

---

## 2. 認証方式

### WebSocket接続
**認証不要（匿名接続可能）**

shiny-potato実装の分析結果：
- WebSocket接続時にカスタムヘッダーなし（`Dial(url, nil)`）
- Cookie不要
- APIキー不要
- WebSocket URL自体に認証情報が埋め込まれている可能性あり

### REST API
公開エンドポイント（認証不要）：
- `/api/front/v2/models/username/{name}/cam` — モデル情報
- `/api/front/v2/config` — グローバル設定（403の場合あり）

認証付きエンドポイント（ログインCookie必要）：
- `/api/front/models/username/{name}/members` — 視聴者リスト
- DM送信系API

---

## 3. WebSocketプロトコル仕様

### 接続フロー

```
Client                          Server
  |                                |
  |---- WebSocket Handshake ------>|
  |<--- 101 Switching Protocols ---|
  |                                |
  |<--- connected メッセージ ------|   ← clientId取得
  |                                |
  |---- subscribe x18 ----------->|   ← イベント購読
  |                                |
  |<--- newChatMessage ------------|   ← リアルタイムイベント
  |<--- tip -----------------------|
  |<--- modelStatusChanged --------|
  |    ...                         |
```

### Step 1: 接続確認メッセージ（サーバー→クライアント）
```json
{
  "subscriptionKey": "connected",
  "params": {
    "clientId": "abc123def456"
  }
}
```

### Step 2: イベント購読（クライアント→サーバー）
```json
{
  "id": "1708700000000-sub-newChatMessage:178845750",
  "method": "PUT",
  "url": "/front/clients/abc123def456/subscriptions/newChatMessage:178845750"
}
```

フォーマット：
- `id`: `{unixMillis}-sub-{eventName}:{modelId}`
- `method`: `"PUT"`
- `url`: `/front/clients/{clientId}/subscriptions/{eventName}:{modelId}`

### Step 3: イベント受信（サーバー→クライアント）
```json
{
  "subscriptionKey": "newChatMessage:178845750",
  "params": {
    "message": {
      "type": "tip",
      "userdata": {
        "username": "someUser123"
      },
      "details": {
        "amount": 100,
        "lovenseDetails": {
          "type": "...",
          "detail": {
            "name": "...",
            "amount": 50
          }
        }
      }
    }
  }
}
```

---

## 4. 購読可能イベント一覧（18種類）

| # | イベント名 | スコープ | 用途 |
|---|---|---|---|
| 1 | `lotteryChanged` | グローバル（modelIdなし） | 抽選イベント |
| 2 | `userBanned:{modelId}` | モデル固有 | ユーザーBAN |
| 3 | `goalChanged:{modelId}` | モデル固有 | ゴール変更 |
| 4 | `modelStatusChanged:{modelId}` | モデル固有 | オンライン/オフライン |
| 5 | `broadcastSettingsChanged:{modelId}` | モデル固有 | 配信設定変更 |
| 6 | `tipMenuUpdated:{modelId}` | モデル固有 | チップメニュー更新 |
| 7 | `topicChanged:{modelId}` | モデル固有 | トピック変更 |
| 8 | `userUpdated:{modelId}` | モデル固有 | ユーザーステータス変更 |
| 9 | `interactiveToyStatusChanged:{modelId}` | モデル固有 | Lovense連携 |
| 10 | `groupShow:{modelId}` | モデル固有 | グループショー |
| 11 | `deleteChatMessages:{modelId}` | モデル固有 | メッセージ削除 |
| 12 | `tipLeaderboardSettingsUpdated:{modelId}` | モデル固有 | チップランキング更新 |
| 13 | `modelAppUpdated:{modelId}` | モデル固有 | モデルアプリ更新 |
| 14 | `newKing:{modelId}` | モデル固有 | キング交代 |
| 15 | `privateMessageSettingsChanged:{modelId}` | モデル固有 | PM設定変更 |
| 16 | **`newChatMessage:{modelId}`** | モデル固有 | **チャットメッセージ（最重要）** |
| 17 | `fanClubUpdated:{modelId}` | モデル固有 | ファンクラブ更新 |
| 18 | `viewServerChanged:hls-07` | 固定値 | 配信サーバー変更 |

### LiveSpotで必要なイベント
- **`newChatMessage`** — チャットログ（tip含む）→ spy_messages
- **`modelStatusChanged`** — 配信開始/終了検出 → sessions
- **`userUpdated`** — ユーザーオンライン/オフライン
- **`groupShow`** — GC検出 → coin_transactions
- **`goalChanged`** — ゴール進捗 → spy_messages

---

## 5. メッセージJSONスキーマ

### 共通エンベロープ
```typescript
interface StripchatWSMessage {
  subscriptionKey: string;  // "{eventName}" or "{eventName}:{modelId}"
  params: {
    clientId?: string;      // "connected" メッセージのみ
    model?: {
      status: "on" | "off";
    };
    user?: {
      status: "on" | "off";
    };
    message?: ChatMessage;
  };
}
```

### チャットメッセージ（`newChatMessage`イベント内）
```typescript
interface ChatMessage {
  type: string;           // "tip" | "message" | "enter" | "leave" | etc.
  userdata: {
    username: string;     // ユーザー名（3文字未満は匿名チップ）
  };
  details: {
    amount: number | string;  // チップ金額（数値 or 文字列）
    lovenseDetails?: {
      type: string;
      detail: {
        name: string;
        amount: number | string;
      };
    };
  };
}
```

### メッセージタイプ一覧（推定）
| type | 説明 | spy_messages.msg_type マッピング |
|---|---|---|
| `tip` | チップ送信 | `tip` |
| `message` | 通常チャット | `chat` |
| `enter` | 入室 | `enter` |
| `leave` | 退室 | `leave` |
| `system` | システムメッセージ | `system` |
| `gift` | ギフト | `gift` |
| `goal` | ゴール達成 | `goal` |
| `group_join` | GC参加 | `group_join` |
| `group_end` | GC終了 | `group_end` |

※ 確認済みは `tip` のみ。他のタイプは推定（DOM監視 content_spy.js の分類と対応）

---

## 6. Node.js 最小接続コード

```typescript
import WebSocket from 'ws';

interface WSMessage {
  subscriptionKey: string;
  params: {
    clientId?: string;
    message?: {
      type: string;
      userdata: { username: string };
      details: { amount: number | string };
    };
    model?: { status: string };
    user?: { status: string };
  };
}

// ============================================================
// Step 1: モデルID取得
// ============================================================
async function getModelId(modelName: string): Promise<string> {
  const res = await fetch(
    `https://stripchat.com/api/front/v2/models/username/${modelName}/cam`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }
  );
  const data = await res.json();
  return String(data.user.user.id);
}

// ============================================================
// Step 2: WebSocket URL取得
// ============================================================
async function getWebSocketUrl(modelName: string): Promise<string> {
  // 方法: ページHTMLから __PRELOADED_STATE__ を抽出
  const res = await fetch(`https://stripchat.com/${modelName}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...' },
  });
  const html = await res.text();

  // __PRELOADED_STATE__ からWebSocket設定を抽出
  const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.+?});\s*<\/script>/s);
  if (!match) throw new Error('__PRELOADED_STATE__ not found');

  const state = JSON.parse(match[1]);

  // WebSocket URLは以下のいずれかのパスにある可能性:
  // - state.configV3.static.features.featuresV2.webSocketServer
  // - state.config.data.webSocketServer
  // - 直接 "wss://websocket.stripchat.com/ws" のような固定URL

  // TODO: DevToolsで実際のパスを確認して以下を修正
  return 'wss://websocket.stripchat.com/ws';
}

// ============================================================
// Step 3: WebSocket接続 + イベント購読
// ============================================================
function connectAndSubscribe(wsUrl: string, modelId: string) {
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('[WS] Connected');
  });

  ws.on('message', (raw: Buffer) => {
    const msg: WSMessage = JSON.parse(raw.toString());

    // Step 3a: 接続確認 → イベント購読
    if (msg.subscriptionKey === 'connected') {
      const clientId = msg.params.clientId!;
      console.log(`[WS] ClientId: ${clientId}`);

      // 必要なイベントを購読
      const events = [
        `newChatMessage:${modelId}`,
        `modelStatusChanged:${modelId}`,
        `userUpdated:${modelId}`,
        `groupShow:${modelId}`,
        `goalChanged:${modelId}`,
        `tipMenuUpdated:${modelId}`,
        `userBanned:${modelId}`,
      ];

      for (const event of events) {
        const sub = {
          id: `${Date.now()}-sub-${event}`,
          method: 'PUT',
          url: `/front/clients/${clientId}/subscriptions/${event}`,
        };
        ws.send(JSON.stringify(sub));
        console.log(`[WS] Subscribed: ${event}`);
      }
      return;
    }

    // Step 3b: チャットメッセージ処理
    if (msg.subscriptionKey?.startsWith('newChatMessage:')) {
      const m = msg.params.message;
      if (!m) return;

      if (m.type === 'tip') {
        const amount = typeof m.details.amount === 'string'
          ? parseInt(m.details.amount, 10)
          : m.details.amount;
        console.log(`[TIP] ${m.userdata.username}: ${amount} tokens`);
      } else {
        console.log(`[CHAT] ${m.userdata?.username}: type=${m.type}`);
      }
      return;
    }

    // Step 3c: モデルステータス変更
    if (msg.subscriptionKey?.includes('modelStatusChanged')) {
      console.log(`[STATUS] Model: ${msg.params.model?.status}`);
      if (msg.params.model?.status === 'off') {
        console.log('[STATUS] Model went offline, closing...');
        ws.close();
      }
      return;
    }

    // Step 3d: その他のイベント
    console.log(`[EVENT] ${msg.subscriptionKey}`);
  });

  ws.on('close', (code, reason) => {
    console.log(`[WS] Closed: ${code} ${reason}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error: ${err.message}`);
  });

  return ws;
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const modelName = 'Risa_06';

  const modelId = await getModelId(modelName);
  console.log(`Model ID: ${modelId}`);

  const wsUrl = await getWebSocketUrl(modelName);
  console.log(`WebSocket URL: ${wsUrl}`);

  connectAndSubscribe(wsUrl, modelId);
}

main().catch(console.error);
```

---

## 7. 現行実装との比較

| 項目 | 現行 (content_spy.js) | 新方式 (WebSocket直接) |
|---|---|---|
| 動作環境 | Chrome拡張（ブラウザ必須） | Node.jsサーバー（ブラウザ不要） |
| 監視方式 | DOM MutationObserver | WebSocket購読 |
| データ精度 | DOM解析に依存（パース失敗あり） | サーバー送信JSONをそのまま利用 |
| 認証 | 不要（ページ表示だけで動作） | 不要（匿名WebSocket） |
| 並列監視 | タブ数分の負荷 | 1プロセスで複数モデル監視可能 |
| 安定性 | DOM構造変更で破損リスク | WebSocket APIは安定 |
| チップ金額 | DOM解析（不正確な場合あり） | `details.amount` フィールド（正確） |
| GC/Private | content_spy.jsで一部対応 | `groupShow` イベントで対応 |
| 配信状態 | ページ表示で判断 | `modelStatusChanged` で検出 |

---

## 8. LiveSpot統合計画

### Phase 1: 概念実証（PoC）
1. Chrome DevToolsでWebSocket URLの完全パスを確認
2. 最小Node.jsスクリプトでWebSocket接続テスト
3. `newChatMessage` の全メッセージタイプを記録・分類
4. spy_messages テーブルへの書き込みテスト

### Phase 2: バックエンド統合
1. FastAPIに WebSocket監視エンドポイント追加
2. 複数キャスト同時監視（1つのNode.jsプロセスで複数WebSocket）
3. spy_messages リアルタイム書き込み
4. VIPチェッカー（vip_checker.py）との統合

### Phase 3: Chrome拡張廃止
1. content_spy.js のWebSocket版を並行運用
2. データ整合性検証（DOM版 vs WebSocket版）
3. Chrome拡張からWebSocket監視へ完全移行

---

## 9. 未解決事項

### 要確認
1. **WebSocket URLの完全パス**: `wss://websocket.stripchat.com/???`
   - DevToolsのNetwork > WSタブで確認必要
   - `__PRELOADED_STATE__` 内のキー名も確認必要
2. **`newChatMessage` の全メッセージタイプ**: `tip` 以外のtype値
   - 実際に接続してログを取得して確認
3. **接続上限**: 1 IPからの同時WebSocket接続数制限
4. **レート制限**: 購読数の上限
5. **接続寿命**: タイムアウトまでの時間

### 既知の制約
- WebSocket URLの取得方法が不明確（外部から渡される前提）
- `amount` フィールドは数値 or 文字列の両方が来る（パース注意）
- 匿名チップ: username が3文字未満の場合あり

---

## 10. 参考資料・出典

- [GitHub: statbate/shiny-potato](https://github.com/statbate/shiny-potato) — Stripchat WebSocketデータコレクター（Go）
- [GitHub: Damianonymous/streamlink-plugins/stripchat.py](https://github.com/Damianonymous/streamlink-plugins/blob/master/stripchat.py) — HLSストリーム取得
- [GitHub: yt-dlp/yt-dlp Stripchat extractor](https://github.com/yt-dlp/yt-dlp) — `__PRELOADED_STATE__` 解析
- [GitHub: flashphoner/flashphoner_client](https://github.com/flashphoner/flashphoner_client) — Flashphoner SDK（動画配信のみ）
- [Flashphoner WCS Documentation](https://docs.flashphoner.com) — WebSocket Room/Chat API（※Stripchatのチャットには使われていない）
- Stripchat REST API: `/api/front/v2/models/username/{name}/cam`
- Stripchat Members API: `/api/front/models/username/{name}/members`
