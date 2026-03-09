---
name: notion-update
description: Notionタスクボードの更新手順。ステータス変更・完了日記入・成果レポート記録。
tools: mcp__claude_ai_Notion__notion-fetch, mcp__claude_ai_Notion__notion-update-page
---

# Notionページ更新手順

## トリガー
タスク完了時、または手動で `/notion-update` を実行

## ステータス更新手順

### 1. タスク開始時
```
page_id: {task_page_id}
command: update_properties
properties:
  ステータス: "🔧 In Progress"
```

### 2. タスク完了時
```
page_id: {task_page_id}
command: update_properties
properties:
  ステータス: "✅ Done"
  date:完了日:start: "{YYYY-MM-DD}"
  date:完了日:is_datetime: 0
```

### 3. 成果レポート記録（必須）
```
page_id: {task_page_id}
command: replace_content
new_str: |
  ## 成果レポート
  **完了日**: {日付}
  **所要時間**: {X分}
  ### 実施内容
  - {変更1}
  ### 変更ファイル
  - {ファイルパス1}
  ### テスト結果
  {ビルド/テスト結果}
```

### 4. ブロック時
```
properties:
  ステータス: "⏸ Blocked"
  ブロック理由: "{具体的な理由}"
```

## Notion接続情報
- タスクボード: collection://48e5a7f8-642b-476b-98b2-2f0f0baba967
- 統合コンテキスト: 30ba72d9e03b817892e1ebd9c1124453

## 注意
- 成果レポートはTelegram通知だけでは不可。Notionが正式な記録先
- 調査タスク: 発見事項・原因・修正方針を記録
- 修正タスク: 変更ファイル一覧・変更内容・ビルド結果を記録
