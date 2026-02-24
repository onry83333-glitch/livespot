# SPY自動巡回（自社）- 配信開始検出+自動起動 実装計画

## 概要
registered_castsテーブルに登録されたis_active=trueの自社キャストの配信開始を自動検出し、
Stripchatタブを自動オープンしてSPY監視を起動する機能をbackground.jsに追加する。

## 配信開始検出の方式: Stripchat公開APIポーリング

- エンドポイント: `https://stripchat.com/api/front/v2/models/username/{castName}`
- レスポンスにモデルの `status` が含まれる（`public`, `private`, `off` 等）
- 認証不要（公開API）
- chrome.alarms `spyAutoPatrol` で3分間隔ポーリング

## 実装箇所（background.js のみ）

### 1. 状態管理変数（ファイル上部、既存変数の後）
- `autoPatrolEnabled` — ON/OFF（storage: auto_patrol_enabled、デフォルトON）
- `monitoredCastStatus` — キャスト別前回ステータスキャッシュ
- `autoPatrolTabs` — 自動オープンしたタブのトラッキング

### 2. chrome.alarm `spyAutoPatrol`（3分間隔）
- 既存アラーム（keepalive, coinSyncPeriodic, coinSyncRetry, coinSyncAfterStream, dm_schedule_*）と衝突なし

### 3. 関数追加（Lifecycleセクションの前）
- `checkCastOnlineStatus(castName)` — Stripchat公開APIでステータス確認
- `isStreamingStatus(status)` — public/private/p2pを配信中と判定
- `runAutoPatrol()` — メイン巡回ロジック
  - registeredCastNamesキャッシュ（既存）を利用
  - offline→online変化時: タブ自動オープン + SPY自動ON + Chrome通知
  - online→offline変化時: Chrome通知のみ（タブは閉じない）
  - 二重オープン防止: 既存タブチェック
  - 複数キャスト間の間隔: 1秒
- `initAutoPatrol()` — storage復元 + 初回即時巡回

### 4. 既存コードへの最小限の追加
- `chrome.alarms.onAlarm` に `spyAutoPatrol` ハンドラ追加
- `chrome.tabs.onRemoved` に autoPatrolTabs クリーンアップ追加
- `GET_STATUS` レスポンスに autoPatrolEnabled, monitoredCasts 追加
- `TOGGLE_AUTO_PATROL` メッセージハンドラ追加
- Lifecycle初期化パス2箇所に `initAutoPatrol()` 追加
- `storage.onChanged` に `auto_patrol_enabled` 監視追加

## 変更しないもの
- manifest.json（既にtabs, alarms, scripting, notifications権限あり）
- content_spy.js（既存の自動開始フローをそのまま利用）
- 他チームメンバーの担当箇所

## コンフリクトリスク: なし
- メンバーA: handleCoinSync内cast_name解決 → 当タスクは触らない
- メンバーB: processCoinSyncData周辺トークン計算 → 当タスクは触らない

## 状態: 実装済み・構文チェック通過済み
