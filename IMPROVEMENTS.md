# Strip Live Spot - 改善案リスト

監査日: 2026-02-15

---

## 1. 【緊急】セキュリティ問題

| # | 問題 | 対象ファイル | 詳細 |
|---|------|-------------|------|
| S-1 | ログインパスワードがプレースホルダーに表示 | login/page.tsx, signup/page.tsx | `placeholder="admin@livespot.jp"` — 本番メールアドレスがヒントとして露出。ダミー値に変更すべき |
| S-2 | Chrome拡張にSupabase ANON_KEY直書き | config.js, popup.js | ANON_KEYは公開前提だがService Keyと混同しないよう注意。現状はOK |
| S-3 | CORS設定にlocalhost含む | backend/.env | 本番デプロイ時に `CORS_ORIGINS` からlocalhost削除必須 |
| S-4 | JWT Secret が.envに平文保存 | backend/.env | 本番ではSecret Managerを使用すべき |

---

## 2. 【重要】データ整合性問題

| # | 問題 | 詳細 |
|---|------|------|
| D-1 | profiles テーブルが空 | auth.users作成時のトリガー `handle_new_user()` が動作していない可能性。RLSで参照不可の可能性も |
| D-2 | paying_users マテリアライズドビューが空 | `refresh_paying_users()` が未実行。coin_transactionsに10件あるのにビューに反映なし |
| D-3 | viewer_stats テーブルが空 | Chrome拡張のSPYが視聴者数を送信していないか、テーブル未作成 |
| D-4 | feed_posts テーブルが空 | フィード機能未使用。空テーブルは問題ないがUI側でempty stateが必要 |
| D-5 | dm_send_log が空 | DM送信未実行。Chrome拡張のDM Executor未接続のため |
| D-6 | sessions が1件のみ | session管理がChrome拡張側で未完成のため |

---

## 3. 【改善】UX改善

| # | 問題 | 対象ファイル | 改善案 |
|---|------|-------------|--------|
| U-1 | エラーハンドリング不足 | 全page.tsx | 全Supabaseクエリにtry-catch追加、ユーザー向けエラーメッセージ表示 |
| U-2 | ローディング状態不足 | alerts/page.tsx, dm/page.tsx | `handleSelectUser`, `detectWhales`等にローディングインジケータ追加 |
| U-3 | レスポンシブ未対応 | alerts/page.tsx, spy/page.tsx | 3カラムレイアウトがモバイルで崩れる。lg:以下で1カラムに |
| U-4 | Empty state不統一 | 各ページ | 空データ時のUI表現を統一（共通EmptyStateコンポーネント作成） |
| U-5 | ページ間ナビゲーション | users/page.tsx → dm | ユーザーカードからDM送信への導線追加 |
| U-6 | 日付フィルタ未実装 | users/[username], analytics/compare | カスタム日付範囲選択が未実装 |

---

## 4. 【最適化】パフォーマンス

| # | 問題 | 対象ファイル | 改善案 |
|---|------|-------------|--------|
| P-1 | users/page.tsx で全spy_messages取得 | users/page.tsx | 1750件全取得→クライアント集計は非効率。RPC関数でサーバー側集計に変更 |
| P-2 | analytics/compare で逐次クエリ | analytics/compare/page.tsx | キャストごとにシーケンシャルにクエリ。`Promise.all`で並列化 |
| P-3 | console.log残留（11箇所） | spy, sessions, feed, hooks | 本番環境で不要。全削除またはログレベル制御 |
| P-4 | use-realtime-spy のcast_name取得にaccount_idフィルタなし | hooks/use-realtime-spy.ts | RLS依存ではなく明示的にaccount_idフィルタ追加 |
| P-5 | spy/page.tsx の複数setInterval | spy/page.tsx | 3つのsetInterval（elapsed/lastMsg/viewerStats）を1つにまとめる |
| P-6 | analytics/compare の recharts バンドルサイズ | analytics/compare/page.tsx | 105kB。dynamic importで遅延読み込みに変更 |

---

## 5. 【提案】新機能・拡張アイデア

| # | 機能 | 優先度 | 説明 |
|---|------|--------|------|
| F-1 | ユーザータイムラインからDM直接送信 | 高 | /users/[username] からワンクリックDM |
| F-2 | キャスト比較のCSVエクスポート | 中 | analytics/compare の比較結果をCSVダウンロード |
| F-3 | プッシュ通知（VIP入室） | 高 | Service Worker + Web Push APIでブラウザ通知 |
| F-4 | ダークモード/ライトモード切替 | 低 | 現在はダークのみ。ライトモード追加 |
| F-5 | キーボードショートカット | 中 | SPYページでCtrl+F検索、Ctrl+Dデモ挿入等 |
| F-6 | paying_users 自動リフレッシュ | 高 | pg_cronまたはEdge Functionで定期実行 |
| F-7 | オフライン対応 | 低 | Service Workerでオフラインキャッシュ |
| F-8 | 多言語対応（i18n） | 低 | 現在は日本語固定。英語対応で海外展開 |
| F-9 | user_timeline統合ビュー | 高 | CLAUDE.mdのPhase 3に記載。課金/DM/入室/チャットを1ユーザーの時系列で串刺し |
| F-10 | アクティビティログ | 中 | 管理者の操作履歴（誰がいつDMを送ったか等） |

---

## データ現状サマリー

| テーブル | レコード数 | 状態 |
|---------|-----------|------|
| accounts | 1 | ✅ 正常 |
| spy_messages | 1,750 | ✅ 正常（cast_name NULL: 0, user_name NULL(非system): 0） |
| sessions | 1 | ⚠️ 少ない（Chrome拡張未接続） |
| coin_transactions | 10 | ✅ デモデータ |
| paid_users | 複数 | ✅ デモデータ |
| paying_users (MV) | 0 | ❌ 未リフレッシュ |
| profiles | 0 (RLS制限?) | ⚠️ 要調査 |
| dm_send_log | 0 | ⚠️ DM未使用 |
| viewer_stats | 0 | ⚠️ Chrome拡張未接続 |
| feed_posts | 0 | ⚠️ フィード未使用 |

## フロントエンドページ状態

| パス | HTTP | 状態 |
|-----|------|------|
| / | 200 | ✅ |
| /login | 200 | ✅ |
| /signup | 200 | ✅ |
| /spy | 200 | ✅ |
| /sessions | 200 | ✅ |
| /alerts | 200 | ✅ |
| /dm | 200 | ✅ |
| /analytics | 200 | ✅ |
| /analytics/compare | 200 | ✅ |
| /users | 200 | ✅ |
| /reports | 200 | ✅ |
| /feed | 200 | ✅ |
| /settings | 200 | ✅ |
