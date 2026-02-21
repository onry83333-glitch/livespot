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


async def generate_competitive_analysis(
    data: dict,
    analysis_type: str = "overview",
) -> dict:
    """キャスト競合分析レポート生成"""
    client = _get_client()

    # トップチッパー情報
    tippers_text = "\n".join(
        f"  {i+1}. {t['name']}: {t['tokens']:,}tk"
        for i, t in enumerate(data.get("top_tippers", []))
    ) or "  データなし"

    # ピーク時間帯
    day_names = ["日", "月", "火", "水", "木", "金", "土"]
    peak_text = "\n".join(
        f"  {day_names[p['day']]}曜 {p['hour']}時台: {p['tokens']:.0f}tk/時"
        for p in data.get("peak_times", [])
    ) or "  データなし"

    prompt = f"""以下の配信データから、このキャストの特徴と成功要因を分析してください。

キャスト: {data['cast_name']}
配信時間: {data['total_hours']:.1f}時間（{data['total_sessions']}セッション）
総チップ: {data['total_tips']:,}tk
ユニークチッパー: {data['unique_tippers']}名
平均ピーク視聴者: {data['avg_peak_viewers']:.0f}名

トップチッパー:
{tippers_text}

チップ集中時間帯:
{peak_text}

以下の5項目で分析してください。各項目2-3行で簡潔に:

## 1. 収益パターン
パブ重視 / チケチャ回転 / ハイブリッドのどれか推定

## 2. 顧客構成の特徴
太客依存度、新規率、常連比率

## 3. 配信スタイルの推定
トークン取得パターンから推測される配信スタイル

## 4. 強み・弱み
数値から読み取れる特徴的な点

## 5. 改善提案
売上向上のための具体的アドバイス（2-3項目）
"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
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
        "cast_name": data["cast_name"],
        "analysis_type": analysis_type,
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
