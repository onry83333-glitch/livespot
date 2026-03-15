# コイン同期 変更履歴・調査レポート

**生成日**: 2026-03-11
**ソース**: Notion全ページ + ローカルコードベース

---

## A) 変更履歴（時系列）

### Phase 1: 初期実装（〜2026-02-22）

| 日付 | 担当 | 内容 |
|------|------|------|
| 2026-02以前 | Claude Code | **MorningHook時代**: Streamlit + SQLite のローカル版。coin_api.py で Stripchat API を叩き、ローカルDBに保存。cast_nameの問題は存在しなかった（単一キャスト運用） |
| 2026-02-22 | YUUTA | **Stripchat API リバースエンジニアリング**: DevToolsで課金者リストAPI、トランザクションAPI、お気に入りAPI等を発見。Notion仕様書 `30fa72d9` に記録 |

### Phase 2: SaaS化（2026-02中旬〜02末）

| 日付 | 担当 | 内容 |
|------|------|------|
| 2026-02中旬 | Claude Code | **Chrome拡張 v1.0**: `content_coin_sync.js` 実装。background.js内のコイン同期コード（〜1,000行）、DM送信コード（〜2,100行）を含む巨大な拡張。alarmsベースの定期実行 |
| 2026-02中旬 | Claude Code | **Collector coin-sync.ts**: サーバーサイドのコイン同期を実装。registered_castsをループし、各キャストのuserIdでStripchat APIを呼び出す設計。**ここでバグが埋め込まれた** — スタジオアカウントのCookieで認証すると、userIdパラメータに関係なく全モデル分のトランザクションが返却される仕様を見落とし |
| 2026-02中旬 | Claude Code | **coin-sync-service.ts（PM2常駐版）**: coin-sync.tsと同じロジックで6時間間隔の自動同期。同じバグを継承 |
| 2026-02-22 16:41 UTC | (自動) | **コイン同期停止**: Chrome拡張のalarms依存でコイン同期が停止。JWT期限切れ→拡張リロード時にalarmsが再登録されなかった |

### Phase 3: 障害発覚と対応（2026-02-25〜03-02）

| 日付 | 担当 | 内容 |
|------|------|------|
| 2026-02-25 | YUUTA | hanshakun配信実績確認。今週売上 60,342tk。DMキャンペーン効果測定実施。コイン同期停止を発見 |
| 2026-02-26 | Claude Code | **2/26 障害分析**: Chrome拡張のalarms依存でコイン同期が2/22に停止していたことを確認。P0-8（Collector移植）+ P0-9（ヘルスチェック）をタスクボードに追加 |
| 2026-02-27 | Claude Code | **paid_usersの(unknown)キャスト修正**: `085_backfill_paid_users_cast_name.sql` で cast_name NULLレコードを修正 |
| 2026-03-01 | Claude Code | **cast_nameフィルタ欠落箇所の特定**: 全RPC・Viewを検索し、paid_usersのJOINにcast_name条件が欠落している箇所を修正 |
| 2026-03-01 | Claude Code | **データパイプライン検証**: Collector(spy/coin-sync/thumbnail) + Chrome拡張DM + トリガーエンジンの包括検証 |

### Phase 4: Chrome拡張のアーキテクチャ変更（2026-03-02）

| 日付 | 担当 | 内容 |
|------|------|------|
| **2026-03-02** | Claude Code | **Chrome拡張 v3.0.0 — 認証エクスポーター格下げ** (`15699bd`): background.js 6,531→3,153行（52%削減）。`content_coin_sync.js`を完全削除。DM送信コードも削除。認証Cookie取得 + SPY監視のみに機能を絞った。理由: coin-sync-serviceとdm-serviceがサーバーサイドで処理するため不要と判断 |
| 2026-03-02 | Claude Code | **E2E検証**: coin-sync-service → coin_transactions(66,860件) → paid_users(13,745人) → refresh_segments の一気通貫パイプラインが正常動作と判定 |

### Phase 5: studio payoutバグ発覚と修正（2026-03-05）

| 日付 | 担当 | 内容 |
|------|------|------|
| **2026-03-05** | Claude Code | **studio payoutのcast_name誤帰属修正** (`b6ae562`): coin-sync-service.tsで`type=studio`のトランザクションの`user_name`がキャスト自身である場合、正しいcast_nameを割り当てるロジックを追加。既存18件/1,279,257tkを修正。Migration 105適用 |

### Phase 6: Chrome拡張 Earnings同期復活（2026-03-10）

| 日付 | 担当 | 内容 |
|------|------|------|
| **2026-03-10** | Claude Code | **Chrome拡張 v3.1.0 — Earnings同期ボタン復活**: v3.0で削除した`content_coin_sync.js`を復元。Service Workerからの直接fetch→content script経由の同一オリジンfetchに変更。406エラーの原因はforbidden Cookieヘッダー（Service WorkerがCookieをリクエストに付与できない）だった |
| **2026-03-10** | Claude Code | **Stripchat API二軸設計書** 作成: 取得側（インバウンド）と送信側（アウトバウンド）の検証ゲート設計。coin-sync.tsの構造的バグを明文化 |
| **2026-03-10** | YUUTA | **キャスト混在問題発覚**: /castsでhanshakunの前週コインが9,297tkと表示されるが、前週は配信していない。Risaのデータがhanshakun側に混入 |

### Phase 7: データ修正（2026-03-11 = 今日）

| 日付 | 担当 | 内容 |
|------|------|------|
| **2026-03-11** | Claude Code | **hanshakun汚染データ削除**: coin_transactions 213件(03-03〜03-07 + created_at 03-06/03-10) + paid_users 9,198件を全削除。refresh_segments RPC実行 |
| **2026-03-11** | Claude Code | **API棚卸し完了**: stripchat-api-trace-report.md生成（34 READ + 4 WRITE経路）。Notion仕様書との差分レポート作成 |

---

## Chrome拡張バージョン推移

| バージョン | 日付 | 主な変更 |
|-----------|------|---------|
| **v1.0〜v2.x** | 〜2026-02末 | 全部入り（コイン同期 + DM送信 + SPY + 認証）。alarmsベース定期実行。background.js 6,531行 |
| **v3.0.0** | 2026-03-02 | 認証エクスポーター格下げ。`content_coin_sync.js`削除、DM送信削除。3,153行 |
| **v3.1.0** | 2026-03-10 | `content_coin_sync.js`復活。Earnings同期ボタン復活。content script経由のfetch方式に変更 |

---

## Collector coin-sync.ts / coin-sync-service.ts 変更履歴

| 日付 | コミット | 変更内容 |
|------|---------|---------|
| 2026-02中旬 | (初期) | 基本実装。registered_castsループ→各cast_nameで一律UPSERT |
| 2026-03-02 | - | E2E検証「正常」と判定（**この時点ではバグに気づいていない**） |
| 2026-03-05 | `b6ae562` | studio payoutのcast_name判定ロジック追加（`type=studio`のみ修正） |
| 2026-03-10 | - | 構造的バグを二軸設計書で明文化。**未修正** |

---

## バグの時系列

| # | 時期 | バグ | 原因 | 発覚 | 修正状態 |
|---|------|-----|------|------|---------|
| 1 | 2026-02中旬 | **coin-sync.ts キャスト混在** | スタジオCookieで全モデル分が返却される仕様を見落とし | 2026-03-10 | **未修正** |
| 2 | 2026-02-22 | **Chrome拡張 alarms停止** | JWT期限切れ→リロード時alarms未再登録 | 2026-02-26 | v3.0で設計変更（alarms廃止） |
| 3 | 2026-02〜 | **paid_users cast_name NULL** | UPSERT時にcast_name未設定 | 2026-02-27 | Migration 085で修正済み |
| 4 | 2026-02〜 | **RPC cast_nameフィルタ欠落** | JOIN条件にcast_name未含 | 2026-03-01 | Migration 076/078/094で修正済み |
| 5 | 2026-02〜 | **studio payout誤帰属** | ループ変数のcast_nameを一律付与 | 2026-03-05 | `b6ae562`で修正済み（studioタイプのみ） |
| 6 | 2026-03-02 | **v3.0 Earnings同期削除** | 不要と判断して削除 | 2026-03-10 | v3.1.0で復活済み |
| 7 | 2026-03-10 | **hanshakun汚染データ** | バグ#1の実害 | 2026-03-10 | データ削除済み。根本原因は未修正 |

---

## B) content_coin_sync.js の cast_name 振り分けロジック

### Chrome拡張がログイン中のキャストをどう判定しているか

`content_coin_sync.js`はcontent scriptとして**stripchat.com上で実行**される。以下の6段階フォールバックでuserIdを取得:

1. **`/api/front/v2/initial-dynamic`** API呼び出し（`credentials: 'include'`）→ `initialDynamic.user.id`
2. **Cookie** `stripchat_com_userId`
3. **`__NEXT_DATA__`** グローバル変数
4. **DOM**: Earnings/Settingsページの要素からパース
5. **`window.__INITIAL_STATE__`** グローバル変数
6. **URL**: `/user/{id}/` パターンマッチ

**重要ポイント**: content scriptは**同一オリジン**で実行されるため、`fetch`に`credentials: 'include'`を付けると、ブラウザが自動的にそのタブのログインセッションCookieを付与する。つまり:

- **Risa_06でログインしたタブ** → Risa_06のCookie → Risa_06のデータのみ返却
- **hanshakunでログインしたタブ** → hanshakunのCookie → hanshakunのデータのみ返却

**結論: Chrome拡張経由の同期は正しい。** ログイン中のキャストのCookieが自動付与されるため、別キャストのデータが混入することはない。

### 6,115名が返ってくる理由（スタジオ全体 vs キャスト単体）

Notion二軸設計書 + API仕様書から:

- **Chrome拡張（content script）**: ログイン中の**キャスト個人のCookie**で叩く → **キャスト単体の課金者のみ**返却
- **Collector（coin-sync-service.ts）**: `stripchat_sessions`テーブルから取得した**スタジオアカウントのCookie**で叩く → **スタジオ全体の全モデル分**を返却

6,115名が返る経路はCollector側。スタジオアカウント（ユーザーID: 178845750）のCookieで`/transactions/users`を叩くと、hanshakunとRisa_06の全課金者が混合して返ってくる。APIは`{userId}`パラメータを無視し、Cookie認証の主体（スタジオアカウント）に紐づく全データを返す。

**Chrome拡張経由では**: Risa_06でログインしたブラウザから叩くと、Risa_06の課金者（約4,574名）のみが返る。hanshakunでログインすれば、hanshakunの課金者のみ。混在は起きない。

---

## C) coin-sync.ts 修正の正しい方針

### Notionの記録に基づく修正方針

二軸設計書（`31fa72d9e03b81b3`）と二軸フレームワーク（`31fa72d9e03b8120`）に記載の方針:

#### 方針1: APIレスポンスにmodel_idが含まれるか確認（P1タスク）

**結論: 含まれない。** `stripchat-api-trace-report.md`の課金者リストAPIレスポンス調査により、トランザクションオブジェクトのフィールドは:
```
userId, username, totalTokens, lastPaid, publicTip, privateTip,
ticketShow, groupShow, content, cam2cam, fanClub, spy, private
```
model_idフィールドは存在しない。`/transactions`（個別トランザクション）のレスポンスも同様にmodel_idを含まない（content_coin_sync.jsのパース部分で確認済み）。

#### 方針2: 推奨修正案（Notionの設計方針 + 現状の知見を統合）

**案A: Chrome拡張のみに一本化（短期・推奨）**

Notionの記載:
> 「当面はChrome拡張のEarnings同期ボタンで手動運用（正しいデータが取れる）」

根拠:
- Chrome拡張（v3.1.0）は正しいcast_name振り分けが保証されている
- Collector経由はスタジオアカウントのCookieで全モデル分が返るため構造的に修正困難
- 各キャストのブラウザプロファイルでChrome拡張を起動すれば、自動的に正しいデータが取れる

実装:
1. coin-sync-service.tsの自動同期を**停止**（pm2 stop coin-sync）
2. Chrome拡張のEarnings同期を各キャストのブラウザで定期実行（手動 or alarms復活）
3. Collector側は認証Cookie供給のみ

**案B: Collector側でセッション突合振り分け（中期）**

Notion二軸設計書の記載:
> 「syncAccountCastsを『1回だけAPI呼び出し、全データを取得し、sessionsのタイムスタンプと突合してキャストを推定』に変更」

実装:
1. 最初のキャストで1回だけAPIを呼び出し（全データ取得）
2. 各トランザクションの`date`を`sessions`テーブルの`started_at`〜`ended_at`と突合
3. セッション中のトランザクション → そのキャストのcast_name
4. セッション外のトランザクション → `studio_wide=true`フラグで保留 + Telegram通知
5. studioタイプは既存の`user_name`ベースロジック（b6ae562で実装済み）を継続

リスク:
- セッション未記録の配信中トランザクションは振り分け不能
- 複数キャストが同時配信した場合の突合精度

**案C: キャスト別Cookieの厳格化（長期・理想）**

実装:
1. `stripchat_sessions`にcast_name別の専用Cookieを必須化
2. 各キャストのCookieで個別にAPIを呼び出し（フォールバック廃止）
3. Cookie未登録キャストはスキップ + Telegramアラート

根拠: coin-sync-service.tsの既存コード（L489-496）に「専用Cookie → キャスト自身のmodel_id」「フォールバック → スタジオ全体」の分岐が既にある。フォールバックを禁止するだけ。

### 推奨順序

1. **即時**: coin-sync-serviceのPM2プロセスを停止（汚染データの追加投入を防止）
2. **短期**: Chrome拡張（v3.1.0）の手動Earnings同期で運用
3. **中期**: 案Cを実装（キャスト別Cookie厳格化 + フォールバック廃止）
4. **参考**: 案Bはフォールバックとして残すが、主経路にはしない

---

## 参照ドキュメント

| ドキュメント | Notion ID | 要点 |
|-------------|-----------|------|
| Stripchat API仕様書 | `30fa72d9e03b81509934f31a1b45a2c4` | API一覧、未活用API、棚卸し差分 |
| Stripchat API仕様書（初版） | `30fa72d9e03b81da869bf6203622a3b6` | 初期リバースエンジニアリング結果 |
| 二軸設計書 | `31fa72d9e03b81b3b212d64c3c1fa3cd` | 取得/送信の検証ゲート設計 |
| 二軸フレームワーク | `31fa72d9e03b8120ac77ce4412dc92de` | 取得経路一覧と修正方針 |
| 緊急タスク | `31fa72d9e03b810e93a4d8c9090de2a7` | キャスト混在問題の調査・修正記録 |
| Chrome拡張 v3.0 格下げ | `316a72d9e03b8140bc99f1baecb136e2` | content_coin_sync.js削除の経緯 |
| Chrome拡張 v3.1 復活 | `31fa72d9e03b81e8a283c41a60d84066` | Earnings同期ボタン復活 |
| studio payout修正 | `31aa72d9e03b81bf82dbe88043ee9dac` | cast_name誤帰属修正（18件/1.28M tk） |
| E2E検証 | `316a72d9e03b81d4a046ecb37ce8aefc` | パイプライン正常判定（03-02時点） |
| 2/26障害分析 | `313a72d9e03b8153ae13e7901e3a741d` | alarms停止の発覚 |
| SLSマニュアル Part 2 | `31ba72d9e03b81418a2edcdcb9f2b7af` | コイン同期の3方式解説 |
| SLSマニュアル Part 4 | `31ba72d9e03b81428d1ccfe8dd262500` | トラブルシューティング |
| 困りごとリスト | `320a72d9e03b819787d8de2a381a2336` | 現在のタスク優先順位 |
| コイン同期ロードマップ | `316a72d9e03b81fca0cbf0d83dd848ff` | Phase 4A マイルストーン |
| API完全トレース | ローカル `stripchat-api-trace-report.md` | 34 READ + 4 WRITE経路 |
