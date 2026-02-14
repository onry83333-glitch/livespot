"""LLM Engine - Ported from sync/llm_engine.py + sync/llm_chat_analysis.py"""
import os
import anthropic
from config import get_settings


def _get_client() -> anthropic.Anthropic:
    settings = get_settings()
    return anthropic.Anthropic(api_key=settings.anthropic_api_key)


async def generate_live_assist(
    cast_name: str,
    recent_messages: list[dict],
    context: str | None = None,
) -> dict:
    """配信中AIアシスト — 3セクション出力
    ・今すぐやること
    ・雰囲気の分析
    ・次のアクション提案
    """
    client = _get_client()

    # Format messages for prompt
    msg_lines = []
    for m in recent_messages[-50:]:  # Last 50 messages
        prefix = ""
        if m.get("tokens", 0) > 0:
            prefix = f"[🎁{m['tokens']}tk] "
        msg_lines.append(f"{m.get('user_name', '?')}: {prefix}{m.get('message', '')}")

    messages_text = "\n".join(msg_lines)

    prompt = f"""あなたはライブ配信の戦略アドバイザーです。
以下のチャットログを分析し、キャスト「{cast_name}」へのリアルタイムアドバイスを出してください。

【直近チャットログ】
{messages_text}

{f"【追加コンテキスト】{context}" if context else ""}

以下の3セクションで回答してください:

## 🚀 今すぐやること（1-2行）
最も優先度の高いアクション

## 🎭 雰囲気の分析（2-3行）
チャット全体のトーン、盛り上がり度、注目すべきユーザー

## 📋 次のアクション提案（2-3項目）
今後5-10分で試すべきこと
"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1000,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text
    tokens_used = response.usage.input_tokens + response.usage.output_tokens
    cost = (response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1_000_000

    return {
        "text": text,
        "model": "claude-sonnet",
        "tokens_used": tokens_used,
        "cost_usd": round(cost, 6),
    }


async def generate_daily_report(
    cast_name: str,
    recent_messages: list[dict],
    context: str | None = None,
) -> dict:
    """日次レポート生成"""
    client = _get_client()

    msg_lines = []
    for m in recent_messages[-100:]:
        prefix = ""
        if m.get("tokens", 0) > 0:
            prefix = f"[🎁{m['tokens']}tk] "
        msg_lines.append(f"{m.get('user_name', '?')}: {prefix}{m.get('message', '')}")

    messages_text = "\n".join(msg_lines)

    prompt = f"""あなたはライブ配信のマネージャーです。
以下の配信チャットログから、キャスト「{cast_name}」のマネージャー向けデイリーレポートを作成してください。

【チャットログ】
{messages_text}

{f"【売上・追加データ】{context}" if context else ""}

以下の形式で:

## 📊 配信サマリー
- 配信の雰囲気（1-2行）
- チャット活発度（高/中/低）

## 🐋 注目リスナー
太客・常連の動向、新規太客の出現

## 💡 改善ポイント
チャットの傾向から見える課題

## 🎯 次回配信への提案
具体的なアクションプラン
"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}],
    )

    text = response.content[0].text
    tokens_used = response.usage.input_tokens + response.usage.output_tokens
    cost = (response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1_000_000

    return {
        "text": text,
        "model": "claude-sonnet",
        "tokens_used": tokens_used,
        "cost_usd": round(cost, 6),
    }
