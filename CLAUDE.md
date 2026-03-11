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

## 安全ルール
- 上書き前にバックアップ(.bak)を取る
- 削除系コマンドは実行しない
- 既存の動作中機能を壊さない
- Stripchat APIを直接叩くな（BANリスク）

## 絶対にやるな
- Notionを読まずに推測でコードを変更すること
- 1つの機能を直すために別の機能を殺すこと
- 「元々どう動いていたか」を確認せずに新しいロジックを書くこと
- ユースケースが定義されていないタスクを実装に進めること
- cast_personas（複数形）テーブルを使うこと（cast_persona単数形に統一済み）
- 同一ファイルを複数タブから同時に編集すること

## 参照
- 事業OS: https://www.notion.so/320a72d9e03b8136a50cd1a159d4584e
- 理念: https://www.notion.so/31ea72d9e03b81c39eedf0eb576ee1bd
- SLS設計書: https://www.notion.so/31ea72d9e03b818491c9de2d096ee547
- 開発ルール: https://www.notion.so/320a72d9e03b81569d18dc1ccae25ce9
- API仕様書: https://www.notion.so/30fa72d9e03b81509934f31a1b45a2c4
- 操作マニュアル: https://www.notion.so/31ba72d9e03b8171b215f05594d7a887
- キー管理: https://www.notion.so/320a72d9e03b81a68868c0522223a3e9
