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

### 方法A: Playwright headless（実装済み ✅ — 推奨）

**ファイル:** `src/auth/playwright-auth.ts`

Playwright headless Chrome でモデルページにアクセスし、CDP で WS 送信フレームから JWT を傍受。

**フロー:**
1. Chromium起動 → モデルページへアクセス
2. 年齢確認ゲート突破（「私は18歳以上です」ボタンクリック）
3. CDP `Network.webSocketFrameSent` で `{"connect":{"token":"eyJ..."}}` を傍受
4. cf_clearance cookie をブラウザコンテキストから取得
5. StripchatAuth を返却（55分 TTL）

**性能:**
- 所要時間: 8〜20秒（モデルページの読み込み速度次第）
- ゲストJWT: ログイン不要（userId は負数のゲストID）
- Cloudflare: headless でも突破可能（2026-02 時点）
- オフラインモデル: WS接続が確立される（配信中モデルへのフォールバックも用意）

**重要な発見:**
- 年齢確認ゲートを突破しないと WS 接続が確立されない
- ゲストでも Centrifugo WS JWT が発行される（ログイン不要）
- CDP `Network.webSocketCreated` → `webSocketFrameSent` の順で検出
- Centrifugo クライアントは複数コマンドを1フレームで送信（改行区切り）

### 方法B: .env 手動設定（フォールバック）

```env
STRIPCHAT_JWT=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
STRIPCHAT_CF_CLEARANCE=lWm9B5Eo8xDy8ONh7XuB...
```

DevTools → Network → WS → 最初の送信フレーム → `connect.token` をコピー。
有効期限: 推定30分〜1時間（3501エラーで切断される）。

### 方法C: Chrome拡張経由（将来検討）

`WebSocket.send()` モンキーパッチで JWT を自動キャプチャ。
方法Aが十分に機能するため、現時点では不要。

---

## 4. Collector での JWT 管理

### 現在の実装 (`src/auth/`)

```
auth/index.ts          — 統合認証モジュール（キャッシュ + フォールバックチェーン）
auth/stripchat-auth.ts — 方式B/C の実装
```

### フォールバックチェーン

1. **メモリキャッシュ** — 有効期限5分前まで再利用
2. **方式C: ページHTML** — `__PRELOADED_STATE__` から JWT 検索（通常失敗）
3. **方式B: REST API** — `/api/front/v2/config` から JWT 検索（通常失敗）
4. **方式A: Playwright** — headless Chrome で WS フレームから JWT 傍受 ✅
5. **.env フォールバック** — 手動設定 JWT

### 3501 エラー時のリカバリ

1. WS から `onAuthError` コールバック発火
2. `invalidateAuth()` でキャッシュ無効化
3. `getAuth()` で再取得試行
4. 新 JWT で WS 再接続

---

## 5. 次のアクション

### 完了 ✅
- [x] Playwright headless JWT 自動取得（方式A）
- [x] 年齢確認ゲート自動突破
- [x] cf_clearance cookie 自動取得
- [x] フォールバックチェーンに Playwright 統合
- [x] 3501 エラー時の自動リカバリ（invalidateAuth → 再取得）

### 残タスク
- [ ] JWT 有効期限の実測（何分で 3501 切断されるか → 55分 TTL で運用中）
- [ ] 複数アカウント対応（account_id 別に JWT 管理）
- [ ] Cloudflare がheadless をブロックした場合の対策（xvfb + headless:false）

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
