# Stripchat データ棚卸し — 取得可能な全データの完全インベントリ

> 作成日: 2026-03-06
> 目的: SLSを「研究ツール」として再定義するため、Stripchatから取得可能な全データを棚卸しする

---

## 目次

1. [調査1: 現在取得しているデータ](#調査1-現在取得しているデータ)
2. [調査2: Stripchat APIで取得可能な全データ](#調査2-stripchat-apiで取得可能な全データ)
3. [調査3: 未取得データ（ギャップ分析）](#調査3-未取得データギャップ分析)

---

## 調査1: 現在取得しているデータ

### 1.1 データ収集パイプライン全体像

```
Stripchat
  ├── [WS] Centrifugo WebSocket ──→ Collector (single-cast.ts) ──→ spy_messages / chat_logs / sessions
  ├── [REST] /models/username/{name}/cam ──→ Collector (ws-client.ts) ──→ sessions (status, topic, modelId, viewerCount)
  ├── [REST] /models/username/{name}/members ──→ Collector (ws-client.ts) ──→ spy_viewers
  ├── [REST] /users/{uid}/transactions ──→ coin-sync-service.ts ──→ coin_transactions
  ├── [REST] /users/{uid}/transactions/users ──→ coin-sync-service.ts ──→ paid_users
  ├── [DOM] チャットDOM監視 ──→ Chrome拡張 (content_spy.js) ──→ spy_messages
  ├── [DOM] 視聴者パネル監視 ──→ Chrome拡張 (content_spy.js) ──→ viewer_stats
  ├── [DOM] プロフィール抽出 ──→ Chrome拡張 (content_spy.js) ──→ cast_profiles
  ├── [DOM] フィード抽出 ──→ Chrome拡張 (content_spy.js) ──→ cast_feeds
  ├── [REST] /initial-dynamic ──→ Chrome拡張 (background.js) ──→ stripchat_sessions (userId, username)
  ├── [Cookie] chrome.cookies API ──→ Chrome拡張 (background.js) ──→ stripchat_sessions
  ├── [REST] サムネイルCDN ──→ Chrome拡張 (background.js) ──→ screenshots
  ├── [REST] /api/front/v2/config ──→ DM service (stripchat-api.ts) ──→ csrfToken取得
  ├── [REST] DM送信API ──→ DM service (dm-service/) ──→ dm_send_log
  └── [REST] /auth/login ──→ coin-sync.ts (Playwright) ──→ 認証セッション取得
```

### 1.2 収集元別データ一覧

#### A. WebSocket (Centrifugo v3) — Collector `single-cast.ts` + `ws-client.ts`

| データ項目 | APIソース | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| チャットメッセージ (テキスト) | WS `newChatMessage@{modelId}` | JWT (ゲスト可) | spy_messages | userName, message, createdAt |
| チップ金額 | WS `newChatMessage` (type=tip) | JWT | spy_messages | details.amount → tokens |
| メッセージ種別 | WS `newChatMessage` (type) | JWT | spy_messages.msg_type | chat/tip/goal |
| ユーザーランキング (league) | WS `newChatMessage` userData.userRanking.league | JWT | spy_messages.metadata | gold/diamond/etc |
| ユーザーレベル | WS `newChatMessage` userData.userRanking.level | JWT | spy_messages.metadata | 数値 |
| isModel フラグ | WS `newChatMessage` userData.isModel | JWT | spy_messages.metadata | 配信者自身のメッセージ判定 |
| isKing / isKnight | WS `newChatMessage` additionalData | JWT | spy_messages.metadata | 王/騎士フラグ |
| isFanClub | WS `newChatMessage` details.fanClubNumberMonthsOfSubscribed | JWT | spy_messages.metadata | FC加入月数 |
| Stripchat userId | WS `newChatMessage` userData.id | JWT | spy_messages.metadata | ユーザーID (数値) |
| ゴール変更 | WS `goalChanged@{modelId}` | JWT | spy_messages (goal type) | 購読のみ、詳細パース未実装 |
| モデルイベント | WS `newModelEvent@{modelId}` | JWT | (未保存) | 購読のみ |
| ユーザー更新 | WS `userUpdated@{modelId}` | JWT | (未保存) | 購読のみ |
| チャットクリア | WS `clearChatMessages@{modelId}` | JWT | (未保存) | 購読のみ |

**WS購読チャンネル**: `newChatMessage`, `newModelEvent`, `goalChanged`, `clearChatMessages`, `userUpdated`

#### B. REST API — Collector `ws-client.ts` (ステータスポーリング)

| データ項目 | APIエンドポイント | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| 配信ステータス | GET `/api/front/v2/models/username/{name}/cam` | 不要 | sessions.status | public/private/off/p2p/ticketShow/groupShow |
| 視聴者数 | 同上 → `user.viewersCount` | 不要 | sessions (間接) | ポーリング時に取得 |
| モデルID | 同上 → `user.id` | 不要 | sessions (間接) | WS購読に必要 |
| 配信タイトル | 同上 → `user.broadcastSettings.topic` / `user.topicText` | 不要 | sessions.broadcast_title | |
| スナップショットタイムスタンプ | 同上 → `user.snapshotTimestamp` | 不要 | screenshots (間接) | CDNサムネイルURL構築用 |
| RAW APIレスポンス全体 | 同上 | 不要 | (rawData変数のみ、未保存) | **多くの未保存フィールドあり** |

#### C. REST API — Collector `ws-client.ts` (視聴者リスト)

| データ項目 | APIエンドポイント | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| 視聴者ユーザー名 | GET `/api/front/models/username/{name}/groupShow/members` | Cookie/JWT | spy_viewers | |
| 視聴者Stripchat ID | 同上 → `members[].user.id` | Cookie/JWT | spy_viewers.user_id_stripchat | |
| 視聴者リーグ | 同上 → `members[].user.userRanking.league` | Cookie/JWT | spy_viewers.league | |
| 視聴者レベル | 同上 → `members[].user.userRanking.level` | Cookie/JWT | spy_viewers.level | |
| FC加入状態 | 同上 → `members[].fanClubTier` | Cookie/JWT | spy_viewers.is_fan_club | |
| isGreen | 同上 → `members[].user.isGreen` | Cookie/JWT | (未保存) | **取得しているが未保存** |
| isUltimate | 同上 → `members[].user.isUltimate` | Cookie/JWT | (未保存) | **取得しているが未保存** |
| fanClubNumberMonthsOfSubscribed | 同上 → `members[].fanClubNumberMonthsOfSubscribed` | Cookie/JWT | (未保存) | **FC加入月数、未保存** |

#### D. REST API — Collector `coin-sync-service.ts` / `coin-sync.ts` (コイン同期)

| データ項目 | APIエンドポイント | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| トランザクションID | GET `/api/front/users/{uid}/transactions?offset=N&limit=100` | Cookie | coin_transactions.stripchat_tx_id | |
| ユーザー名 | 同上 → `userName` | Cookie | coin_transactions.user_name | |
| ユーザーID | 同上 → `userId` | Cookie | coin_transactions.user_id | |
| トークン数 | 同上 → `tokens` | Cookie | coin_transactions.tokens | |
| 金額 (amount) | 同上 → `amount` | Cookie | coin_transactions.amount | |
| トランザクション種別 | 同上 → `type` | Cookie | coin_transactions.type | tip/private/cam2cam/ticket/group等 |
| ソース | 同上 → `source` | Cookie | coin_transactions.source | |
| 日時 | 同上 → `date` / `createdAt` | Cookie | coin_transactions.transacted_at | |
| 説明 | 同上 → `description` | Cookie | coin_transactions.description | |
| ソース詳細 | 同上 → `sourceDetail` | Cookie | coin_transactions.source_detail | |
| 匿名フラグ | 同上 → `isAnonymous` | Cookie | coin_transactions.is_anonymous | |

| データ項目 | APIエンドポイント | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| 課金ユーザーID | GET `/api/front/users/{uid}/transactions/users?offset=N&limit=100` | Cookie | paid_users.stripchat_user_id | |
| 課金ユーザー名 | 同上 → `username` | Cookie | paid_users.user_name | |
| 累計トークン | 同上 → `totalTokens` | Cookie | paid_users.total_tokens | |
| 最終課金日 | 同上 → `lastPaid` | Cookie | paid_users.last_payment | |
| publicTip | 同上 → `publicTip` | Cookie | paid_users.public_tip | |
| privateTip | 同上 → `privateTip` | Cookie | paid_users.private_tip | |
| ticketShow | 同上 → `ticketShow` | Cookie | paid_users.ticket_show | |
| groupShow | 同上 → `groupShow` | Cookie | paid_users.group_show | |
| content | 同上 → `content` | Cookie | paid_users.content | |
| cam2cam | 同上 → `cam2cam` | Cookie | paid_users.cam2cam | |
| fanClub | 同上 → `fanClub` | Cookie | paid_users.fan_club | |
| spy | 同上 → `spy` | Cookie | paid_users.spy | |
| private | 同上 → `private` | Cookie | paid_users.private | |

#### E. Chrome拡張 — `content_spy.js` (DOM監視)

| データ項目 | 取得方法 | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| チャットメッセージ | DOM MutationObserver | ブラウザログイン | spy_messages | Collectorと重複取得 |
| チップ金額 | DOM `.tipAmount` class | ブラウザログイン | spy_messages.tokens | |
| ユーザーカラー | DOM `style.color` | ブラウザログイン | spy_messages.user_color | RGB値 |
| ユーザーリーグ | DOM badge class | ブラウザログイン | spy_messages.user_league | |
| ユーザーレベル | DOM level element | ブラウザログイン | spy_messages.user_level | |
| VIPフラグ | DOM css class判定 | ブラウザログイン | spy_messages.is_vip | |
| 入退室メッセージ | DOM system message | ブラウザログイン | spy_messages (enter/leave) | |
| 視聴者数 (total) | DOM 視聴者パネル | ブラウザログイン | viewer_stats.total | |
| コインユーザー数 | DOM 視聴者パネル | ブラウザログイン | viewer_stats.coin_users | |
| Ultimateカウント | DOM 視聴者パネル | ブラウザログイン | viewer_stats.ultimate_count | |
| 配信タイトル | DOM `.view-cam-info-topic` | ブラウザログイン | sessions.broadcast_title | |
| プロフィール情報 | DOM プロフィールセクション | ブラウザログイン | cast_profiles | age, origin, body_type, ethnicity等 |
| フォロワー数 | DOM プロフィール | ブラウザログイン | cast_profiles.followers_count | |
| チップメニュー | DOM プロフィール | ブラウザログイン | cast_profiles.tip_menu | |
| エピックゴール | DOM プロフィール | ブラウザログイン | cast_profiles.epic_goal | |
| フィード投稿 | DOM フィードセクション | ブラウザログイン | cast_feeds | post_text, post_date, likes_count |

#### F. Chrome拡張 — `background.js` (Cookie/API)

| データ項目 | 取得方法 | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| セッションCookie | chrome.cookies API | ブラウザ | stripchat_sessions.session_cookie | 30分ごと自動エクスポート |
| 全Cookie JSON | chrome.cookies.getAll | ブラウザ | stripchat_sessions.cookies_json | |
| Stripchat userId | Cookie / /initial-dynamic API | Cookie | stripchat_sessions.stripchat_user_id | |
| Stripchat username | /initial-dynamic API | Cookie | stripchat_sessions (間接) | |
| JWT トークン | content_jwt_capture.js | ブラウザ | stripchat_sessions.jwt_token | |
| CSRFトークン | /api/front/v2/config | Cookie | stripchat_sessions.csrf_token | |
| サムネイルURL (CDN) | /api/front/v2/models/username/{name}/cam → CDN URL構築 | 不要 | screenshots.thumbnail_url | |
| スクリーンショット画像 | chrome.tabs.captureVisibleTab | ブラウザ | screenshots (Storage) | フォールバック方式 |
| 配信開始/終了検出 | /api/front/v2/models/username/{name}/cam | 不要 | sessions (自動作成/終了) | 3分ごとAutoPatrol |
| last_seen_online | AutoPatrol/SpyRotation | 不要 | registered_casts / spy_casts | |
| is_extinct (消滅判定) | 30日間オフラインチェック | 不要 | registered_casts / spy_casts | 24時間ごと |

#### G. DM Service — `collector/src/dm-service/`

| データ項目 | APIエンドポイント | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| DM送信結果 | POST `/api/front/users/{uid}/conversations/{targetId}/messages` | Cookie + CSRF | dm_send_log | |
| ユーザーID解決 | GET `/api/front/v2/models/username/{name}` | Cookie | (キャッシュ) | username → userId |
| 画像アップロード | POST `/api/front/users/{uid}/albums/0/photos` | Cookie + CSRF | dm_send_log (間接) | DM添付用 |
| セッション有効性 | GET `/api/front/users/{uid}` | Cookie | (テスト用) | testConnection() |

#### H. 認証 — `coin-sync.ts` (Playwright/Login API)

| データ項目 | APIエンドポイント | 認証 | 保存先テーブル | 備考 |
|---|---|---|---|---|
| ログインセッション | POST `/api/front/auth/login` | email + password | stripchat_sessions | |
| ユーザー情報 | GET `/api/front/v2/user/me` | Cookie | (userId取得用) | |
| 初期データ | GET `/api/front/v2/initial-dynamic?requestType=initial` | Cookie | (userId/username取得用) | |
| cf_clearance | Playwright headless | ブラウザ自動化 | stripchat_sessions | Cloudflare bypass |

---

## 調査2: Stripchat APIで取得可能な全データ

### 2.1 公開API (認証不要)

#### `/api/front/v2/models/username/{name}/cam`

配信状態・モデル基本情報。認証なしでアクセス可能。

| フィールド | パス | 型 | 説明 | 現在取得 |
|---|---|---|---|---|
| id | user.id | number | モデルID | ✅ |
| username | user.username | string | ユーザー名 | ✅ (間接) |
| status | user.status | string | public/private/off/p2p/ticketShow/groupShow | ✅ |
| viewersCount | user.viewersCount | number | 視聴者数 | ✅ |
| snapshotTimestamp | user.snapshotTimestamp | number | サムネイルタイムスタンプ | ✅ |
| topic / topicText | user.broadcastSettings.topic | string | 配信タイトル | ✅ |
| gender | user.gender | string | 性別 | ❌ |
| ethnicity | user.ethnicity | string | 人種 | ❌ (DOMで取得) |
| age | user.age / user.birthday | number/string | 年齢 | ❌ (DOMで取得) |
| languages | user.languages | string[] | 対応言語 | ❌ |
| country | user.country | string | 国 | ❌ |
| bodyType | user.bodyType | string | 体型 | ❌ (DOMで取得) |
| hairColor | user.hairColor | string | 髪色 | ❌ (DOMで取得) |
| eyeColor | user.eyeColor | string | 目色 | ❌ (DOMで取得) |
| isNew | user.isNew | boolean | 新人フラグ | ❌ |
| isFeatured | user.isFeatured | boolean | 注目フラグ | ❌ |
| favoritesCount | user.favoritesCount | number | お気に入り数 | ❌ |
| followersCount | user.followersCount | number | フォロワー数 | ❌ (DOMで取得) |
| subscribersCount | user.subscribersCount | number | FC加入者数 | ❌ |
| videosCount | user.videosCount | number | 動画数 | ❌ |
| photosCount | user.photosCount | number | 写真数 | ❌ |
| previewUrlThumbBig | user.previewUrlThumbBig | string | プレビュー画像URL | ❌ |
| broadcastGender | user.broadcastGender | string | 配信ジャンダー | ❌ |
| isHD | user.isHd | boolean | HD配信か | ❌ |
| isVR | user.isVr | boolean | VR配信か | ❌ |
| isMobile | user.isMobile | boolean | モバイル配信か | ❌ |
| isInteractiveToy | user.isInteractiveToy | boolean | インタラクティブトイ使用 | ❌ |
| goalAmount | user.goal.amount | number | ゴール目標額 | ❌ |
| goalCurrent | user.goal.current | number | ゴール現在額 | ❌ |
| goalDescription | user.goal.description | string | ゴール説明 | ❌ |
| tipMenu | user.tipMenu | object[] | チップメニュー | ❌ (DOMで取得) |
| tags | user.tags | string[] | タグ | ❌ |
| prices | user.prices | object | private/cam2cam/ticket等の価格設定 | ❌ |
| schedule | user.schedule | object | 配信スケジュール | ❌ |
| awards | user.awards | object[] | 受賞歴 | ❌ |
| aboutMe | user.aboutMe | string | 自己紹介 | ❌ (DOMで取得) |
| wishList | user.wishList | object[] | ウィッシュリスト | ❌ |
| socialLinks | user.socialLinks | object | SNSリンク | ❌ |

#### CDNサムネイル

| フィールド | URL | 認証 | 現在取得 |
|---|---|---|---|
| サムネイル画像 | `https://img.doppiocdn.org/thumbs/{snapshotTimestamp}/{modelId}_webp` | 不要 | ✅ |

### 2.2 認証必須API (Cookie)

#### `/api/front/users/{uid}/transactions`
コイントランザクション履歴。offset/limitページネーション。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| id | number | トランザクションID | ✅ |
| userName | string | ユーザー名 | ✅ |
| userId | number | ユーザーID | ✅ |
| tokens | number | トークン数 | ✅ |
| amount | number | 金額 | ✅ |
| type | string | 種別 (tip/private/cam2cam/ticket/group/spy/fanClub/content) | ✅ |
| source | string | ソース | ✅ |
| date | string | トランザクション日時 | ✅ |
| createdAt | string | 作成日時 | ✅ |
| description | string | 説明 | ✅ |
| sourceDetail | string | ソース詳細 | ✅ |
| isAnonymous | boolean | 匿名チップか | ✅ |

#### `/api/front/users/{uid}/transactions/users`
課金ユーザー一覧（累計）。sort=lastPaid&order=desc。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| userId | number | ユーザーID | ✅ |
| username | string | ユーザー名 | ✅ |
| totalTokens | number | 累計トークン | ✅ |
| lastPaid | string | 最終課金日 | ✅ |
| publicTip | number | 公開チップ | ✅ |
| privateTip | number | プライベートチップ | ✅ |
| ticketShow | number | チケットショー | ✅ |
| groupShow | number | グループショー | ✅ |
| content | number | コンテンツ課金 | ✅ |
| cam2cam | number | cam2cam | ✅ |
| fanClub | number | ファンクラブ | ✅ |
| spy | number | スパイ | ✅ |
| private | number | プライベート | ✅ |

#### `/api/front/users/{uid}/favorites`
お気に入りリスト（フォロワー一覧）。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| favorites[] | object[] | お気に入りモデル一覧 | ❌ |
| favorites[].id | number | モデルID | ❌ |
| favorites[].username | string | モデル名 | ❌ |
| favorites[].status | string | 現在の配信状態 | ❌ |
| favorites[].lastBroadcast | string | 最終配信日時 | ❌ |

#### `/api/front/users/{uid}/fanClubs/subscriptions`
ファンクラブ加入者リスト。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| subscriptions[] | object[] | FC加入者一覧 | ❌ |
| subscriptions[].userId | number | ユーザーID | ❌ |
| subscriptions[].username | string | ユーザー名 | ❌ |
| subscriptions[].tier | string | FCティア | ❌ |
| subscriptions[].monthsSubscribed | number | 加入月数 | ❌ |
| subscriptions[].subscribedAt | string | 加入日時 | ❌ |

#### `/api/front/v2/config`
サイト設定・CSRFトークン。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| csrfToken | string | CSRFトークン | ✅ (DM送信用) |
| config | object | サイト全体設定 | ❌ (csrfTokenのみ) |

#### `/api/front/v2/user/me`
ログインユーザー自身の情報。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| id | number | ユーザーID | ✅ |
| username | string | ユーザー名 | ✅ |
| その他プロフィール | various | 自分のプロフィール全体 | ❌ (id/usernameのみ) |

#### `/api/front/v2/initial-dynamic`
初期ダイナミックデータ（ログイン状態含む）。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| initialDynamic.user.id | number | ユーザーID | ✅ |
| initialDynamic.user.username | string | ユーザー名 | ✅ |
| initialDynamic (全体) | object | サイト初期化データ | ❌ (user部分のみ) |

#### `/api/front/users/{uid}/conversations/{targetId}/messages`
DM送信。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| message.id | number | メッセージID | ✅ (送信結果) |
| message.createdAt | string | 送信日時 | ✅ |
| message.senderId | number | 送信者ID | ✅ |
| message.recipientId | number | 受信者ID | ✅ |
| message.body | string | 本文 | ✅ |

#### `/api/front/users/{uid}/relation`
フォロー/お気に入り操作。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| (POST) | - | フォロー/お気に入り設定 | ❌ |

#### `/api/front/users/{uid}/albums/0/photos`
写真アップロード（DM添付用）。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| photo.id | number | 写真ID（mediaId） | ✅ (DM添付用) |

#### `/api/front/auth/login`
ログインAPI。

| フィールド | 型 | 説明 | 現在取得 |
|---|---|---|---|
| (POST body) loginOrEmail | string | ログインID | ✅ (Playwright経由) |
| (POST body) password | string | パスワード | ✅ (Playwright経由) |
| (response) セッションCookie | Cookie | 認証セッション | ✅ |

### 2.3 WebSocket (Centrifugo v3)

URL: `wss://websocket-sp-v6.stripchat.com/connection/websocket`

#### 購読チャンネル

| チャンネル | 説明 | 現在購読 | データ活用 |
|---|---|---|---|
| `newChatMessage@{modelId}` | チャットメッセージ（text/tip/goal） | ✅ | ✅ spy_messages |
| `newModelEvent@{modelId}` | モデルイベント（入退室等） | ✅ | ❌ 購読のみ |
| `goalChanged@{modelId}` | ゴール変更 | ✅ | ❌ 購読のみ |
| `clearChatMessages@{modelId}` | チャットクリア | ✅ | ❌ 購読のみ |
| `userUpdated@{modelId}` | ユーザー情報更新 | ✅ | ❌ 購読のみ |
| `modelStatusChanged@{modelId}` | 配信状態変更 | ❌ | - |
| `privateShowRequest@{modelId}` | プライベートショーリクエスト | ❌ | - |
| `groupShowStart@{modelId}` | グループショー開始 | ❌ | - |
| `ticketShowStart@{modelId}` | チケットショー開始 | ❌ | - |
| `fanClubTierUpgraded@{modelId}` | FCティアアップグレード | ❌ | - |
| `newFollower@{modelId}` | 新規フォロワー | ❌ | - |

### 2.4 視聴者リストAPI

#### `/api/front/models/username/{name}/groupShow/members`
（注: `/api/front/v2/models/username/{name}/members` もある可能性）

| フィールド | パス | 型 | 説明 | 現在取得 |
|---|---|---|---|---|
| username | members[].user.username | string | ユーザー名 | ✅ |
| id | members[].user.id | number | ユーザーID | ✅ |
| league | members[].user.userRanking.league | string | リーグ | ✅ |
| level | members[].user.userRanking.level | number | レベル | ✅ |
| isGreen | members[].user.isGreen | boolean | グリーンユーザー | ❌ |
| isUltimate | members[].user.isUltimate | boolean | Ultimateメンバー | ❌ |
| fanClubTier | members[].fanClubTier | string/null | FCティア | ✅ (boolean変換) |
| fanClubMonths | members[].fanClubNumberMonthsOfSubscribed | number | FC加入月数 | ❌ |

---

## 調査3: 未取得データ（ギャップ分析）

### 3.1 取得可能だが現在取得していないデータ

#### 優先度: 高 — 研究価値が高く、実装コスト低

| # | データ項目 | API/方法 | 認証 | 推定工数 | 研究用途 |
|---|---|---|---|---|---|
| G-01 | `/cam` API全フィールド保存 | GET /models/username/{name}/cam | 不要 | 2h | モデルプロフィール分析、配信設定の傾向分析 |
| G-02 | ゴール金額/進捗/説明 | `/cam` API → goal.amount/current/description | 不要 | 1h | ゴール設定と達成率の相関分析 |
| G-03 | 価格設定 (private/cam2cam/ticket) | `/cam` API → prices | 不要 | 1h | 価格戦略と売上の相関 |
| G-04 | チップメニュー (API版) | `/cam` API → tipMenu | 不要 | 1h | チップメニュー構成と売上の関係 |
| G-05 | isGreen / isUltimate (視聴者) | /members API → user.isGreen/isUltimate | Cookie/JWT | 30m | 視聴者の課金傾向分析 |
| G-06 | FC加入月数 (視聴者) | /members API → fanClubNumberMonthsOfSubscribed | Cookie/JWT | 30m | FCリテンション分析 |
| G-07 | `goalChanged` イベント詳細パース | WS goalChanged@{modelId} | JWT | 1h | リアルタイムゴール進捗追跡 |
| G-08 | `newModelEvent` イベント詳細パース | WS newModelEvent@{modelId} | JWT | 1h | 入退室・イベントの詳細分析 |
| G-09 | `userUpdated` イベント詳細パース | WS userUpdated@{modelId} | JWT | 1h | ユーザー状態変化の追跡 |

#### 優先度: 中 — 新規APIアクセスが必要

| # | データ項目 | API/方法 | 認証 | 推定工数 | 研究用途 |
|---|---|---|---|---|---|
| G-10 | お気に入りリスト | GET /users/{uid}/favorites | Cookie | 3h | フォロワー分析、競合キャストへの流出検出 |
| G-11 | FC加入者リスト | GET /users/{uid}/fanClubs/subscriptions | Cookie | 3h | FCリテンション、収益安定性分析 |
| G-12 | `modelStatusChanged` WS購読 | WS modelStatusChanged@{modelId} | JWT | 2h | 状態遷移パターン分析（RESTポーリング不要化） |
| G-13 | 配信スケジュール (API版) | `/cam` API → schedule | 不要 | 30m | スケジュール遵守率と売上の関係 |
| G-14 | タグ (API版) | `/cam` API → tags | 不要 | 30m | タグ戦略と集客の相関 |
| G-15 | SNSリンク | `/cam` API → socialLinks | 不要 | 30m | SNS連携と集客力の関係 |
| G-16 | 動画/写真数 | `/cam` API → videosCount/photosCount | 不要 | 30m | コンテンツ量と売上の関係 |

#### 優先度: 低 — 実装コスト高 or 研究価値限定的

| # | データ項目 | API/方法 | 認証 | 推定工数 | 研究用途 |
|---|---|---|---|---|---|
| G-17 | privateShowRequest WS | WS privateShowRequest@{modelId} | JWT | 2h | プライベートショーの頻度分析 |
| G-18 | groupShowStart WS | WS groupShowStart@{modelId} | JWT | 2h | GS開始トリガー分析 |
| G-19 | ticketShowStart WS | WS ticketShowStart@{modelId} | JWT | 2h | TS開始トリガー分析 |
| G-20 | newFollower WS | WS newFollower@{modelId} | JWT | 2h | フォロワー獲得タイミング分析 |
| G-21 | fanClubTierUpgraded WS | WS fanClubTierUpgraded@{modelId} | JWT | 2h | FCアップグレード追跡 |
| G-22 | /relation API | POST /users/{uid}/relation | Cookie | 3h | フォロー操作自動化 |
| G-23 | DM受信 (会話取得) | GET /users/{uid}/conversations | Cookie | 4h | DM返信率・会話分析 |

### 3.2 現在取得しているが保存していないデータ

| # | データ | 取得場所 | 理由 | 対応案 |
|---|---|---|---|---|
| S-01 | `/cam` rawData全体 | ws-client.ts pollCastStatus() | rawData変数に保持するが未保存 | cast_snapshots テーブルに定期保存 |
| S-02 | isGreen (視聴者) | viewer.ts parseViewerList() | パースはしているがViewerEntryに含めていない | ViewerEntry型にフィールド追加 |
| S-03 | isUltimate (視聴者) | viewer.ts parseViewerList() | 同上 | ViewerEntry型にフィールド追加 |
| S-04 | fanClubMonths (視聴者) | viewer.ts (APIレスポンスにあるが未パース) | パーサーが読み飛ばしている | parseViewerList()で取得 |
| S-05 | goalChanged詳細 | ws-client.ts (チャンネル購読済み) | ハンドラで受信するが無視 | parseCentrifugoGoal()を実装 |
| S-06 | newModelEvent詳細 | ws-client.ts (チャンネル購読済み) | 同上 | parseModelEvent()を実装 |
| S-07 | userUpdated詳細 | ws-client.ts (チャンネル購読済み) | 同上 | parseUserUpdated()を実装 |

### 3.3 推奨実装ロードマップ

#### Phase A: 低コスト高価値（即実装可能）

1. **G-01: `/cam` APIフルフィールド保存** — pollCastStatus()の rawData を定期的にDB保存。`cast_snapshots` テーブル追加。全フィールドをJSONBで保存し、分析時にクエリ。
2. **S-02/S-03: 視聴者 isGreen/isUltimate保存** — ViewerEntry型にフィールド追加、spy_viewersテーブルにカラム追加。
3. **G-07/G-08/G-09: WS購読済みイベントのパース** — 既に購読しているがハンドラで無視しているデータをパースして保存。

#### Phase B: 新規APIアクセス

4. **G-10: お気に入りリスト取得** — /favorites APIを定期ポーリング（1日1回）。フォロワーの流入/流出を追跡。
5. **G-11: FC加入者リスト取得** — /fanClubs/subscriptions APIを定期ポーリング。FCリテンション分析。
6. **G-12: modelStatusChanged WS購読** — RESTポーリングの代替。リアルタイム状態遷移検出。

#### Phase C: 新規WS購読

7. **G-17〜G-21: 追加WSチャンネル** — privateShowRequest, groupShowStart, ticketShowStart, newFollower, fanClubTierUpgraded の購読追加。

---

## 付録: テーブル×データソース マッピング

| テーブル | データソース | 更新頻度 | レコード規模 |
|---|---|---|---|
| spy_messages | WS + Chrome DOM | リアルタイム | 数千件/日/キャスト |
| coin_transactions | REST /transactions | 1-6時間ごと | 数百件/日/キャスト |
| paid_users | REST /transactions/users | 1-6時間ごと | 累積数千件/キャスト |
| sessions | REST /cam (ポーリング) + Chrome拡張 | 5秒サイクル | 数件/日/キャスト |
| viewer_stats | Chrome DOM (視聴者パネル) | 30秒〜3分 | 数百件/日/キャスト |
| spy_viewers | REST /members + Chrome DOM | 1分ごと | 数十件/ポーリング |
| screenshots | CDN URL + captureVisibleTab | 1-5分ごと | 数十件/日/キャスト |
| stripchat_sessions | Chrome cookies + /initial-dynamic | 30分ごと | 数件/アカウント |
| cast_profiles | Chrome DOM (プロフィールセクション) | 配信ページ開いた時 | 1件/キャスト |
| cast_feeds | Chrome DOM (フィードセクション) | 配信ページ開いた時 | 数件/キャスト |
| dm_send_log | POST /conversations/messages | オンデマンド | 数十件/日 |
| chat_logs | WS (v2テーブル) | リアルタイム | spy_messagesと並行 |

---

*最終更新: 2026-03-06*
