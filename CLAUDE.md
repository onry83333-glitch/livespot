# CLAUDE.md — Wisteria Creation SLS

## 理念
「アダルト配信業界で最も技術力のある事務所」
便利ツールを作って発信すること自体が、キャストを集める力になる。

SLSのゴール: 「管理者ゼロでキャストが自走できるOS」
石村がSLSを毎日使い、データ分析→改善サイクルを自分だけで回せる状態。

## ゴール確認
タスクに着手する前に必ず確認せよ:
- このタスクのゴールは何か？
- これが完了したら誰が何をできるようになるか？
- 理念に沿っているか？

## 事業OS
事業OS v1.1 トップ: https://www.notion.so/320a72d9e03b8136a50cd1a159d4584e

タスクに着手する前に必ず通る道:
1. プロジェクト設計書を読む
2. タスクボードで既存タスクとの重複を確認
3. 操作マニュアルで既存の仕組みを確認
4. ユースケースが定義されているか確認

## 開発ルール

### 1. ビルド成功 ≠ 機能完了
タスク完了の定義:
1. コードが書かれている
2. マイグレーションがSupabaseに適用されている
3. RPC/テーブルがSupabaseに存在する（SQLで確認）
4. 実データが入っている
5. 画面上で正しいデータが表示される
1だけでDoneにするな。全て揃って初めてDone。

### 2. フロント + バックはセットで完了
UIコンポーネントを書いたら、それが参照するRPC/テーブルも同時に作成すること。
supabase.rpc('xxx') をフロントに書いて、マイグレーションは「後で」にするな。

### 3. 検証はSQLで行う
タスク完了時、必ずSupabaseにSQLを投げて確認:
```
SELECT routine_name FROM information_schema.routines WHERE routine_schema = 'public';
SELECT COUNT(*) FROM [table_name];
```

### 4. タスク完了時はNotionを更新
- ステータスを ✅ Done に変更
- 完了日を設定
- メモに実施内容を追記

### 5. 定期ヘルスチェック
大きな実装後に全RPC存在確認 + 全テーブルデータ件数確認を実行する。

## DBルール
- paid_usersは必ずcast_name条件を付ける
- coin_transactionsはtokensカラムで集計（user_nameカラム、usernameではない）
- 2025-02-15以降のデータのみ使用
- LLMを常時実行する処理に組み込むな（手動 or 1日1回cronのみ）
- sessions.total_tokensは参考値（不正確）。正確な売上はcoin_transactionsで集計
- studio payoutを売上に含めるな
- 「今週」の定義: 月曜03:00 JST〜現在

## 安全ルール
- 上書き前にバックアップ(.bak)を取る
- 削除系コマンドは実行しない
- 既存の動作中機能を壊さない
- Stripchat APIを直接叩くな（BANリスク）
- /api/front/v2/configは廃止(404)。絶対に叩くな
- CSRF取得: Content Scriptでwindow.__logger.kibanaLogger.api.csrfParamsから抽出。token+timestampはペア照合（動的生成NG）

## 絶対にやるな
- Notionを読まずに推測でコードを変更すること
- 1つの機能を直すために別の機能を殺すこと
- 「元々どう動いていたか」を確認せずに新しいロジックを書くこと
- ユースケースが定義されていないタスクを実装に進めること
- cast_personas（複数形）テーブルを使うこと（cast_persona単数形に統一済み）
- 同一ファイルを複数タブから同時に編集すること
- dm-serviceを再起動すること（pm2停止済み、Chrome拡張直接送信に切り替え済み）
- /api/front/v2/config を叩くこと（廃止404）
- 自動実行系（poller等）を復活させること
- DM_TEST_MODE=falseをデフォルトにすること
- studio payoutを売上に含めること
- stripchat_sessionsのユニーク制約を変更すること

## インシデント・ナレッジ
| 事象 | 時期 | 教訓 |
|------|------|------|
| poller暴走 | 2026/03/01〜4日 | 自動実行系は全廃止 |
| DM誤送信 | 2026/02/26 | AMP cookie複数→6層L4で対策 |
| coin-sync混在 | 2026/03月 | account単位API→キャスト混在。Chrome拡張が正 |
| 13項目→504 | 2026/03/13-14 | 段階的に追加しろ。N×4クエリ+LLM 8000トークンが60秒超過 |

## 参照
- 事業OS: https://www.notion.so/320a72d9e03b8136a50cd1a159d4584e
- 理念: https://www.notion.so/31ea72d9e03b81c39eedf0eb576ee1bd
- SLS設計書: https://www.notion.so/31ea72d9e03b818491c9de2d096ee547
- 開発ルール: https://www.notion.so/320a72d9e03b81569d18dc1ccae25ce9
- API仕様書: https://www.notion.so/30fa72d9e03b81509934f31a1b45a2c4
- 操作マニュアル: https://www.notion.so/31ba72d9e03b8171b215f05594d7a887
- キー管理: https://www.notion.so/320a72d9e03b81a68868c0522223a3e9
- 配信FBレポート設計書: https://www.notion.so/320a72d9e03b8145a839e8894fb85756
- AIペルソナビジョン: https://www.notion.so/320a72d9e03b8167b3f1e021e6129fd7
- DM復旧作業ログ: https://www.notion.so/322a72d9e03b818fb21fd44c24522195
- DMナレッジ集: https://www.notion.so/321a72d9e03b815db3ede7e8250d3aa9
- DM誤送信インシデント: https://www.notion.so/314a72d9e03b8173984fdf3a5bbd0b80
- v1.1設計書: https://www.notion.so/320a72d9e03b81a1bca2e03ac5c26c11
- 壁打ち絶対参照: https://www.notion.so/31aa72d9e03b81ee8721db8138c1c987
- タスクボードDB: https://www.notion.so/48e5a7f8642b476b98b22f0f0baba967
- 自律型AI組織設計書: https://www.notion.so/320a72d9e03b8144acd3c2a65a8669fb
