# Stripchat API 取得経路・送信経路 完全トレースレポート

**生成日**: 2026-03-10
**対象**: C:/dev/livespot 全コードベース（collector / chrome-extension / frontend / backend）

---

## 取得側（READ: Stripchat API → DB）

### R-01: ログインAPI
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-sync.ts:507 |
| エンドポイント | `POST https://stripchat.com/api/front/auth/login` |
| 認証方法 | Username + Password（.env） |
| cast_name決定 | registered_casts の stripchat_user_id/model_id から逆引き |
| INSERT先 | `stripchat_sessions`（UPSERT） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-02: ユーザー情報取得
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-sync.ts:834 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/user/me` |
| 認証方法 | Cookie（sessionId） |
| cast_name決定 | cookies_json の stripchat_com_userId → registered_casts |
| INSERT先 | `stripchat_sessions`（UPDATE stripchat_user_id） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-03: Initial-Dynamic（userId解決フォールバック）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-sync.ts:863 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/initial-dynamic?requestType=initial` |
| 認証方法 | Cookie |
| cast_name決定 | registered_casts フォールバック |
| INSERT先 | `stripchat_sessions`（UPDATE stripchat_user_id） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-04: コイントランザクション取得（Collector メイン）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-sync.ts:1026 |
| エンドポイント | `GET https://stripchat.com/api/front/users/{userId}/transactions?offset={n}&limit=100` |
| 認証方法 | Cookie（sessionId） |
| cast_name決定 | syncCastCoins関数の引数（registered_casts.cast_name由来） |
| INSERT先 | `coin_transactions`（UPSERT onConflict=account_id,stripchat_tx_id） |
| 検証ゲート | **なし** :triangular_flag_on_post: — cast_nameはパラメータ信頼 |

### R-05: コイントランザクション取得（PM2常駐版）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-sync-service.ts:201 |
| エンドポイント | `GET https://stripchat.com/api/front/users/{userId}/transactions?offset={n}&limit=100` |
| 認証方法 | Cookie |
| cast_name決定 | registered_casts.cast_name |
| INSERT先 | `coin_transactions`（UPSERT） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-06: 課金ユーザー一覧取得（PM2常駐版）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-sync-service.ts:273 |
| エンドポイント | `GET https://stripchat.com/api/front/users/{userId}/transactions/users?sort=lastPaid&order=desc` |
| 認証方法 | Cookie |
| cast_name決定 | registered_casts（プライマリキャスト） |
| INSERT先 | `paid_users`（UPSERT onConflict=account_id,user_name） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-07: Cookie検証（手動インポート）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/coin-import.ts:107 |
| エンドポイント | `GET https://stripchat.com/api/front/users/{userId}/transactions?page=1&limit=1` |
| 認証方法 | Cookie（手動ペースト） |
| cast_name決定 | registered_casts の stripchat_user_id マッチ |
| INSERT先 | `stripchat_sessions`（UPSERT） |
| 検証ゲート | **あり** — HTTP 200でCookie有効性を確認 |

### R-08: キャストステータス取得（WebSocket Poller）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/ws-client.ts（config.ts参照） |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/models/username/{castName}/cam` |
| 認証方法 | なし（公開API）、cfClearanceオプション |
| cast_name決定 | パラメータ（config / registered_casts / spy_casts） |
| INSERT先 | `sessions`, `spy_messages`（ステータス変化時） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-09: 視聴者リスト取得
| 項目 | 値 |
|---|---|
| ファイル | collector/src/ws-client.ts |
| エンドポイント | `GET https://stripchat.com/api/front/v2/models/username/{castName}/members` |
| 認証方法 | JWT Bearer / Cookie |
| cast_name決定 | CastTarget.castName パラメータ |
| INSERT先 | `spy_viewers`（UPSERT）, `spy_profiles` |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-10: WebSocket接続（リアルタイムイベント）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/ws-client.ts:147 |
| エンドポイント | `wss://websocket-sp-v6.stripchat.com/connection/websocket` |
| 認証方法 | Centrifugo JWT（connectペイロード） |
| cast_name決定 | コンストラクタパラメータ |
| INSERT先 | `spy_messages`（INSERT）, `sessions`（メタデータ更新） |
| 検証ゲート | **なし** :triangular_flag_on_post: — JWT認証のみ |

### R-11: ページHTML取得（centrifugoToken抽出）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/auth/stripchat-auth.ts:51-69 |
| エンドポイント | `GET https://stripchat.com/{modelName}` |
| 認証方法 | なし（公開ページ） |
| cast_name決定 | modelNameパラメータ（デフォルト'Risa_06'） |
| INSERT先 | なし（StripchatAuthオブジェクト返却） |
| 検証ゲート | **なし** |

### R-12: Config API（centrifugoToken取得）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/auth/stripchat-auth.ts:159-179 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/config` |
| 認証方法 | なし |
| cast_name決定 | N/A |
| INSERT先 | なし |
| 検証ゲート | **なし** |

### R-13: Cookie検証（Cloudflareリフレッシュ）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/refresh-cookies.ts:110 |
| エンドポイント | `GET https://stripchat.com/api/front/users/{userId}/transactions?page=1&limit=1` |
| 認証方法 | リフレッシュ済みCookie |
| cast_name決定 | N/A |
| INSERT先 | なし |
| 検証ゲート | **あり** — Cloudflareバイパス成功確認 |

### R-14: Initial-Dynamic（Chrome拡張 userId取得）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/content_coin_sync.js:89 |
| エンドポイント | `GET /api/front/v2/initial-dynamic?requestType=initial` |
| 認証方法 | Cookie（credentials: 'include'） |
| cast_name決定 | stripchat_com_userId Cookie |
| INSERT先 | N/A（ヘルパー） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-15: コイントランザクション取得（Chrome拡張 プライマリ）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/content_coin_sync.js:234 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/users/{userId}/transactions?from=...&until=...&offset=...&limit=100` |
| 認証方法 | Cookie（credentials: 'include'） |
| cast_name決定 | userId → registered_castsマッチ |
| INSERT先 | `coin_transactions`（UPSERT） |
| 検証ゲート | **なし** :triangular_flag_on_post: — cast_nameはDB逆引きだが照合なし |
| レート制限 | 429リトライ×3（10秒待機）、10ページ毎2秒スリープ |

### R-16: コイン履歴取得（Chrome拡張 v2フォールバック）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/content_coin_sync.js:538 |
| エンドポイント | `GET /api/front/v2/earnings/coins-history?page={n}&limit=100` |
| 認証方法 | Cookie |
| cast_name決定 | プライマリと同じ |
| INSERT先 | `coin_transactions` |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-17: 課金ユーザー一覧（Chrome拡張）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/content_coin_sync.js:424 |
| エンドポイント | `GET /api/front/users/{userId}/transactions/users?sort=lastPaid&order=desc` |
| 認証方法 | Cookie |
| cast_name決定 | userId パラメータ |
| INSERT先 | 直接INSERTなし（result.payingUsersに格納） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-18: キャストオンライン確認（Chrome拡張 AutoPatrol）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/background.js:2160 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/models/username/{castName}/cam` |
| 認証方法 | なし（公開API） |
| cast_name決定 | パラメータ |
| INSERT先 | `registered_casts`（ステータス更新） |
| 検証ゲート | **なし** |
| ポーリング間隔 | 3分 |

### R-19: サムネイル取得（Chrome拡張）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/background.js:2589 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/models/username/{username}/cam` |
| 認証方法 | なし（公開API） |
| cast_name決定 | パラメータ |
| INSERT先 | `screenshots` |
| 検証ゲート | **なし** |

### R-20: グループショーメンバー取得（Chrome拡張）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/background.js:2985 |
| エンドポイント | `GET https://stripchat.com/api/front/models/username/{castName}/groupShow/members` |
| 認証方法 | JWT Bearer / Cookie |
| cast_name決定 | パラメータ |
| INSERT先 | `viewer_stats` |
| 検証ゲート | **あり** — 401/403でJWT無効化 |

### R-21: Initial-Dynamic（Chrome拡張 セッションエクスポート）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/background.js:3186 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/initial-dynamic?requestType=initial` |
| 認証方法 | Cookie（chrome.cookies.getAll） |
| cast_name決定 | レスポンスのusername → registered_castsマッチ |
| INSERT先 | `stripchat_sessions` |
| 検証ゲート | **あり** — registered_casts.cast_nameとの一致確認 |

### R-22: Config/CSRFトークン取得（Chrome拡張）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/background.js:3273 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/config` |
| 認証方法 | Cookie |
| cast_name決定 | N/A |
| INSERT先 | `stripchat_sessions`（CSRFトークン保存） |
| 検証ゲート | **なし** |

### R-23: JWT傍受（XHR）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/content_jwt_capture.js:16-31 |
| エンドポイント | 全XMLHttpRequest（Authorization: Bearer ヘッダー傍受） |
| 認証方法 | JWT（パッシブキャプチャ） |
| cast_name決定 | JWTペイロードから（上流処理） |
| INSERT先 | `stripchat_sessions` |
| 検証ゲート | **なし** — パッシブ傍受 |

### R-24: JWT傍受（fetch）
| 項目 | 値 |
|---|---|
| ファイル | chrome-extension/content_jwt_capture.js:37-72 |
| エンドポイント | 全fetch（Authorization: Bearer ヘッダー傍受） |
| 認証方法 | JWT（パッシブキャプチャ） |
| cast_name決定 | JWTペイロードから |
| INSERT先 | `stripchat_sessions` |
| 検証ゲート | **あり** — 重複排除（lastCapturedJwt） |

### R-25: スクリーンショットCDN取得（Frontend）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/app/api/screenshot/route.ts:17 |
| エンドポイント | `GET https://img.strpst.com/thumbs/{unix_ts}/{modelId}_webp` |
| 認証方法 | なし（公開CDN） |
| cast_name決定 | POSTボディパラメータ |
| INSERT先 | `cast_screenshots` |
| 検証ゲート | **あり** — authenticateAndValidateAccount() |

### R-26: Stripchat接続テスト（Frontend）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/app/api/stripchat/test/route.ts:24 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/models/username/{cast}/cam` |
| 認証方法 | なし |
| cast_name決定 | クエリパラメータ（デフォルト: Risa_06） |
| INSERT先 | なし（テスト用） |
| 検証ゲート | **なし** — テスト専用 |

### R-27: Config/CSRFトークン取得（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:113 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/config` |
| 認証方法 | Cookie |
| cast_name決定 | N/A |
| INSERT先 | なし |
| 検証ゲート | **なし** |

### R-28: ユーザーID解決（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:177 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/models/username/{username}` |
| 認証方法 | Cookie |
| cast_name決定 | メソッドパラメータ |
| INSERT先 | `user_profiles`（userId キャッシュ） |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-29: モデル情報取得（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:375 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/models/username/{username}/cam` |
| 認証方法 | なし |
| cast_name決定 | メソッドパラメータ |
| INSERT先 | なし |
| 検証ゲート | **なし** |

### R-30: グループショーメンバー取得（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:417 |
| エンドポイント | `GET https://stripchat.com/api/front/models/username/{castName}/groupShow/members` |
| 認証方法 | Cookie / JWT |
| cast_name決定 | メソッドパラメータ |
| INSERT先 | なし |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-31: 接続テスト（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:445 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/config` |
| 認証方法 | Cookie |
| cast_name決定 | N/A |
| INSERT先 | なし |
| 検証ゲート | **あり** — Cloudflare検出（cf-mitigated） |

### R-32: DM用Config/CSRF取得（Collector DM Service）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/dm-service/stripchat-api.ts:105 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/v2/config` |
| 認証方法 | Cookie |
| cast_name決定 | SessionData.stripchat_user_id |
| INSERT先 | なし |
| 検証ゲート | **なし** |

### R-33: ユーザーID解決（Collector DM Service）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/dm-service/stripchat-api.ts:133 |
| エンドポイント | `GET https://stripchat.com/api/front/v2/models/username/{username}` |
| 認証方法 | Cookie |
| cast_name決定 | ターゲットユーザーのusername |
| INSERT先 | なし |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### R-34: セッション有効性テスト（Collector DM Service）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/dm-service/stripchat-api.ts:262 |
| エンドポイント | `GET https://ja.stripchat.com/api/front/users/{stripchat_user_id}` |
| 認証方法 | Cookie |
| cast_name決定 | SessionData.stripchat_user_id |
| INSERT先 | なし |
| 検証ゲート | **あり** — response.ok + cf-mitigated検出 |

---

## 送信側（WRITE: アプリ → Stripchat にアクション実行）

### W-01: DM送信（Collector DM Service）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/dm-service/stripchat-api.ts:177 |
| エンドポイント | `POST https://ja.stripchat.com/api/front/users/{stripchat_user_id}/conversations/{targetUserId}/messages` |
| 認証方法 | Cookie + CSRFトークン（bodyに含む） |
| cast_name決定 | SessionData.stripchat_user_id（送信者） |
| 検証ゲート | **なし** :triangular_flag_on_post: — cast_name/model_id照合なし |

### W-02: 写真アップロード（Collector DM Service）
| 項目 | 値 |
|---|---|
| ファイル | collector/src/dm-service/stripchat-api.ts:229 |
| エンドポイント | `POST https://ja.stripchat.com/api/front/users/{stripchat_user_id}/albums/0/photos` |
| 認証方法 | Cookie + CSRFトークン（form dataに含む） |
| cast_name決定 | SessionData.stripchat_user_id |
| 検証ゲート | **なし** :triangular_flag_on_post: |

### W-03: DM送信（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:247 |
| エンドポイント | `POST https://ja.stripchat.com/api/front/users/{stripchat_user_id}/conversations/{targetUserId}/messages` |
| 認証方法 | Cookie + CSRFトークン + front-version |
| cast_name決定 | dm/sendルートのbodyパラメータ |
| 検証ゲート | **あり** — registered_casts.stripchat_user_id == session.stripchat_user_id（Identity Check） |
| 追加検証 | キャンペーン必須、cast_name必須、テストモードホワイトリスト |

### W-04: 写真アップロード（Frontend stripchat-api.ts）
| 項目 | 値 |
|---|---|
| ファイル | frontend/src/lib/stripchat-api.ts:323 |
| エンドポイント | `POST https://ja.stripchat.com/api/front/users/{stripchat_user_id}/albums/0/photos` |
| 認証方法 | Cookie + CSRFトークン + front-version |
| cast_name決定 | DM送信フローから |
| 検証ゲート | **あり** — セッション有効性必須 |

---

## 赤旗サマリー（検証ゲートなし箇所）

### 取得側の赤旗

| ID | ファイル | リスク | 説明 |
|---|---|---|---|
| R-01 | coin-sync.ts:507 | 中 | ログインAPIに直接認証情報を送信。model_id照合なし |
| R-02 | coin-sync.ts:834 | 低 | userId解決。DB更新あるがcast_name照合なし |
| R-03 | coin-sync.ts:863 | 低 | フォールバックuserId解決 |
| R-04 | coin-sync.ts:1026 | **高** | coin_transactionsへの主要データ投入経路。cast_nameはパラメータ信頼のみ |
| R-05 | coin-sync-service.ts:201 | **高** | R-04と同じリスク。PM2常駐で常時稼働 |
| R-06 | coin-sync-service.ts:273 | **高** | paid_usersへの主要データ投入経路。cast_name照合なし |
| R-08 | ws-client.ts | 中 | sessionsテーブル更新。cast_nameパラメータ信頼 |
| R-09 | ws-client.ts | 中 | spy_viewersテーブル更新。cast_nameパラメータ信頼 |
| R-10 | ws-client.ts:147 | 中 | spy_messagesへのリアルタイムINSERT。認証はJWTのみ |
| R-14 | content_coin_sync.js:89 | 低 | userId取得ヘルパー |
| R-15 | content_coin_sync.js:234 | **高** | Chrome拡張からのcoin_transactions投入。DB逆引きだが照合なし |
| R-16 | content_coin_sync.js:538 | **高** | フォールバック経路。同上 |
| R-17 | content_coin_sync.js:424 | 中 | 課金ユーザー取得 |
| R-28 | stripchat-api.ts:177 | 低 | user_profilesキャッシュ更新 |
| R-30 | stripchat-api.ts:417 | 低 | データ返却のみ |
| R-33 | dm-service/stripchat-api.ts:133 | 低 | ユーザーID解決 |

### 送信側の赤旗

| ID | ファイル | リスク | 説明 |
|---|---|---|---|
| **W-01** | dm-service/stripchat-api.ts:177 | **最高** | DM送信にcast_name/model_id検証ゲートなし。誤キャストからDM送信のリスク |
| **W-02** | dm-service/stripchat-api.ts:229 | **最高** | 写真アップロードに検証ゲートなし |

### 検証ゲートあり（安全な箇所）

| ID | ファイル | 検証内容 |
|---|---|---|
| R-07 | coin-import.ts:107 | HTTP 200でCookie有効性確認 |
| R-13 | refresh-cookies.ts:110 | Cloudflareバイパス成功確認 |
| R-20 | background.js:2985 | 401/403でJWT無効化 |
| R-21 | background.js:3186 | registered_casts.cast_nameとの一致確認 |
| R-24 | content_jwt_capture.js:37 | 重複排除（lastCapturedJwt） |
| R-25 | screenshot/route.ts:17 | authenticateAndValidateAccount() |
| R-31 | stripchat-api.ts:445 | Cloudflare検出 |
| R-34 | dm-service/stripchat-api.ts:262 | response.ok + cf-mitigated検出 |
| **W-03** | stripchat-api.ts:247 | **Identity Check: registered_casts.stripchat_user_id照合** |
| **W-04** | stripchat-api.ts:323 | セッション有効性確認 |

---

## 統計サマリー

| カテゴリ | 件数 |
|---|---|
| 取得側（READ）合計 | 34 |
| 送信側（WRITE）合計 | 4 |
| 検証ゲートあり | 10 |
| 検証ゲートなし（赤旗） | 28 |
| **最高リスク（送信+検証なし）** | **2（W-01, W-02）** |
| **高リスク（DB投入+検証なし）** | **5（R-04, R-05, R-06, R-15, R-16）** |

---

## 推奨アクション

1. **W-01/W-02（Collector DM Service）**: Frontend版（W-03）と同等のIdentity Check（verifyCastIdentity: registered_casts.stripchat_user_id照合）を追加すべき
2. **R-04/R-05/R-06（Collector Coin Sync）**: userId → registered_casts.stripchat_user_id の照合ゲートを追加し、不一致時はINSERTを拒否すべき
3. **R-15/R-16（Chrome拡張 Coin Sync）**: 同上。Chrome拡張側でもDB逆引き後にcast_name照合を追加すべき
4. **全取得経路**: APIレスポンス内のuserIdとセッションのstripchat_user_idの一致確認を標準パターン化すべき
