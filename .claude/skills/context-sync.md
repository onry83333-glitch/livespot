---
name: context-sync
description: 統合コンテキストページの同期。Context Crawlerを実行して全プロジェクトの最新情報をNotionに反映。
tools: Bash
---

# 統合コンテキスト同期手順

## トリガー
セッション終了時、または手動で `/context-sync` を実行

## 手順
1. C:/dev/kitakanto-os/context-crawler/update_unified_context.py を実行
2. 実行結果を確認（更新ブロック数、エラーの有無）
3. エラーがあればログを確認して対処

## 実行コマンド
```bash
cd C:/dev/kitakanto-os/context-crawler
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python update_unified_context.py
```

## dry-runモード
```bash
python update_unified_context.py --dry-run
```

## 対象ページ
- 統合コンテキスト: 30ba72d9e03b817892e1ebd9c1124453
- 9件の参照ページから最新情報を収集して更新
