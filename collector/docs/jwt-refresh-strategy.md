# Stripchat Centrifugo JWT — 取得・更新戦略

## 調査日: 2026-02-23

---

## 1. Centrifugo JWTとは

Stripchat の WebSocket (Centrifugo v3) 接続に必要な認証トークン。

```
WS URL:  wss://websocket-sp-v6.stripchat.com/connection/websocket
Connect: {"connect":{"token":"eyJ...","name":"js"},"id":1}
```

### JWTペイロード例
```json
{
  "sub": "178962943",
  "info": {
    "isGuest": false,
    "userId": 178962943
  }
}
```

- 署名方式: HS256 (HMAC-SHA256)
- 有効期限: `exp` クレームなし → サーバー側で管理（推定30分〜1時間）
- 匿名接続: 不可（空トークンは 3501 拒否）

---

## 2. 調査結果

### テスト済みの取得方法

| 方法 | 結果 | 備考 |
|------|------|------|
| 匿名接続（空JWT） | 3501 拒否 | ゲスト不可 |
| ページHTML `__PRELOADED_STATE__` | JWTなし | centrifugoToken フィールド不在 |
| REST API /api/front/v2/config | 404 | エンドポイント不在 |
| REST API /api/front/v2/me | 404 | エンドポイント不在 |
| REST API /api/front/v2/auth/* | 404 | エンドポイント不在 |
| REST API /api/front/v3/* | 404 | エンドポイント不在 |
| ja.stripchat.com API | 404 | 同上 |
| Session Cookie認証 API | 404 | Cookie有効だがAPI不在 |
| stripchat_sessions.jwt_token | null | Chrome拡張未キャプチャ |

### 結論

Centrifugo JWT は **Stripchat フロントエンド JavaScript** がランタイムで取得する。
公開API経由では取得不可。取得元は以下のいずれか:

1. ページ読込時に JS バンドルが内部 API を呼び出す（未特定）
2. WebSocket 接続時に JS が別途生成（HMAC秘密鍵がフロントに埋め込まれている可能性は低い）
3. SSR 時に HTML に埋め込まれるが、非ログイン状態では空

---

## 3. 実用的な取得方法（推奨順）

### 方法A: Chrome拡張経由（推奨）

**現在の実装:** `content_jwt_capture.js` が XHR/fetch の Authorization ヘッダーをキャプチャ。

**問題:** REST API JWT は捕捉するが、Centrifugo WS トークンは異なるソース（WS 第1フレーム）。

**改修案:**
1. `content_jwt_capture.js` で `WebSocket.send()` をモンキーパッチ
2. 最初の `{"connect":{"token":"eyJ..."}}` フレームから Centrifugo JWT を抽出
3. `window.postMessage({type: 'LS_CENTRIFUGO_JWT', jwt: ...})` で送信
4. `background.js` で受信 → `stripchat_sessions.jwt_token` に保存
5. Collector は `stripchat_sessions.jwt_token` を読み取って使用

```javascript
// content_jwt_capture.js に追加
const origWsSend = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) {
  try {
    if (typeof data === 'string' && data.includes('"connect"')) {
      const msg = JSON.parse(data);
      if (msg.connect?.token) {
        window.postMessage({
          type: 'LS_CENTRIFUGO_JWT',
          jwt: msg.connect.token,
          timestamp: Date.now(),
        }, '*');
      }
    }
  } catch {}
  return origWsSend.call(this, data);
};
```

### 方法B: .env 手動設定（フォールバック）

```env
STRIPCHAT_JWT=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
STRIPCHAT_CF_CLEARANCE=lWm9B5Eo8xDy8ONh7XuB...
```

DevTools → Network → WS → 最初の送信フレーム → `connect.token` をコピー。
有効期限: 推定30分〜1時間（3501エラーで切断される）。

### 方法C: Headless Chrome（最終手段）

Playwright/Puppeteer で Stripchat にログイン → WS フレームを傍受。
- 重い（Chrome起動必要）
- Cloudflare 対策が必要
- 本番向けではない

---

## 4. Collector での JWT 管理

### 現在の実装 (`src/auth/`)

```
auth/index.ts          — 統合認証モジュール（キャッシュ + フォールバックチェーン）
auth/stripchat-auth.ts — 方式B/C の実装
```

### フォールバックチェーン

1. **メモリキャッシュ** — 有効期限5分前まで再利用
2. **方式C: ページHTML** — `__PRELOADED_STATE__` から JWT 検索
3. **方式B: REST API** — `/api/front/v2/config` から JWT 検索
4. **.env フォールバック** — 手動設定 JWT

### 3501 エラー時のリカバリ

1. WS から `onAuthError` コールバック発火
2. `invalidateAuth()` でキャッシュ無効化
3. `getAuth()` で再取得試行
4. 新 JWT で WS 再接続

---

## 5. 次のアクション

### 短期（即実行可能）
- [ ] Chrome拡張に WebSocket.send() モンキーパッチ追加
- [ ] Centrifugo JWT を `stripchat_sessions.jwt_token` に保存
- [ ] Collector が起動時に DB から JWT 読み込み

### 中期
- [ ] JWT 有効期限の実測（何分で 3501 切断されるか）
- [ ] Supabase Realtime で jwt_token 更新を購読（Chrome拡張がリフレッシュしたら即反映）
- [ ] 複数アカウント対応（account_id 別に JWT 管理）

### 長期（検討中）
- [ ] Headless Chrome 自動 JWT 取得（Cloudflare 対策含む）
- [ ] JS バンドル解析による直接 API エンドポイント特定

---

## 6. 検証結果サマリ

### 動作確認済み
- Centrifugo WS 接続: **OK** (JWTがあれば)
- チャットメッセージ受信: **OK** (3件受信 / 26秒間)
- チップ検出: **OK** (90tk rio1252)
- pong レスポンス: **OK** (1回送信確認)
- メッセージ構造解析: **OK** (docs/websocket-message-samples.json)

### 確認されたメッセージ構造
```
data.message.userData.username             — ユーザー名
data.message.details.body                  — メッセージ本文
data.message.details.amount                — チップ額 (type=tip のみ)
data.message.type                          — "text" | "tip"
data.message.createdAt                     — ISO タイムスタンプ
data.message.userData.userRanking.league   — "gold" | "diamond" | ...
data.message.userData.userRanking.level    — ユーザーレベル (1-99)
data.message.userData.isGreen              — 課金ユーザー
data.message.additionalData.isKing         — キングバッジ
data.message.additionalData.isKnight       — ナイトバッジ
data.message.details.fanClubTier           — ファンクラブ tier
data.message.details.isAnonymous           — 匿名チップ
```
