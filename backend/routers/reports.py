"""Reports router - AI session analysis report generation"""
from datetime import datetime, timedelta
from collections import Counter
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
import anthropic
from config import get_supabase_admin, get_settings
from routers.auth import get_current_user

router = APIRouter()


class ReportGenerateRequest(BaseModel):
    account_id: str
    session_id: str


def _verify_account(sb, account_id: str, user_id: str):
    result = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Account not found")


def _get_cast_usernames(sb, account_id: str) -> set:
    result = sb.table("accounts").select("cast_usernames").eq("id", account_id).single().execute()
    if result.data and result.data.get("cast_usernames"):
        return set(result.data["cast_usernames"])
    return set()


@router.post("/generate")
async def generate_report(body: ReportGenerateRequest, user=Depends(get_current_user)):
    """セッション終了後のAI分析レポート生成"""
    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])

    # (a) セッション情報取得
    sess_result = sb.table("sessions").select("*").eq("session_id", body.session_id).single().execute()
    if not sess_result.data:
        raise HTTPException(status_code=404, detail="Session not found")
    session = sess_result.data

    # (b) 全メッセージ取得（キャスト除外）
    msgs_result = (sb.table("spy_messages")
                   .select("*")
                   .eq("session_id", body.session_id)
                   .order("message_time")
                   .limit(2000)
                   .execute())
    all_msgs = msgs_result.data or []

    cast_users = _get_cast_usernames(sb, body.account_id)
    # Also exclude cast_name matching user_name
    cast_name = all_msgs[0]["cast_name"] if all_msgs else ""
    msgs = [m for m in all_msgs if not (
        m.get("user_name") in cast_users or
        (m.get("metadata") or {}).get("is_cast") is True or
        (m.get("user_name") and m.get("user_name") == cast_name)
    )]

    if not msgs:
        raise HTTPException(status_code=400, detail="セッションにメッセージがありません")

    # (c) 統計算出
    started_at = session["started_at"]
    ended_at = session.get("ended_at") or msgs[-1]["message_time"]
    start_dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
    duration_min = max(1, int((end_dt - start_dt).total_seconds() / 60))

    total_messages = len(msgs)
    unique_users = len({m["user_name"] for m in msgs if m.get("user_name")})
    tip_msgs = [m for m in msgs if m.get("tokens", 0) > 0]
    total_coins = sum(m["tokens"] for m in tip_msgs)

    # コイン→円換算レート取得
    acct = sb.table("accounts").select("coin_rate").eq("id", body.account_id).single().execute()
    coin_rate = acct.data.get("coin_rate", 7.7) if acct.data else 7.7
    total_jpy = round(total_coins * coin_rate)

    # トップチッパー上位5名
    tipper_map: dict[str, int] = {}
    for m in tip_msgs:
        un = m.get("user_name", "unknown")
        tipper_map[un] = tipper_map.get(un, 0) + m["tokens"]
    top_tippers = sorted(tipper_map.items(), key=lambda x: -x[1])[:5]

    # 発言数上位5名
    chat_counter = Counter(m.get("user_name", "unknown") for m in msgs if m.get("user_name"))
    top_chatters = chat_counter.most_common(5)

    # msg_type別内訳
    type_counter = Counter(m.get("msg_type", "unknown") for m in msgs)
    type_breakdown = dict(type_counter)

    # 時間帯別アクティビティ（15分刻み）
    time_slots: dict[str, int] = {}
    for m in msgs:
        try:
            mt = datetime.fromisoformat(m["message_time"].replace("Z", "+00:00"))
            slot = mt.replace(minute=(mt.minute // 15) * 15, second=0, microsecond=0)
            slot_key = slot.strftime("%H:%M")
            time_slots[slot_key] = time_slots.get(slot_key, 0) + 1
        except (ValueError, KeyError):
            pass

    # (d) Claude APIにプロンプト送信
    stats_text = f"""【配信統計】
- 配信時間: {duration_min}分
- 総メッセージ数: {total_messages}
- ユニークユーザー数: {unique_users}
- チップ合計: {total_coins}コイン (約¥{total_jpy:,})
- チップ件数: {len(tip_msgs)}

【トップチッパー】
{chr(10).join(f"  {i+1}. {name}: {coins}コイン" for i, (name, coins) in enumerate(top_tippers))}

【発言数ランキング】
{chr(10).join(f"  {i+1}. {name}: {count}発言" for i, (name, count) in enumerate(top_chatters))}

【メッセージ種別】
{chr(10).join(f"  {k}: {v}件" for k, v in type_breakdown.items())}

【15分ごとのアクティビティ】
{chr(10).join(f"  {slot}: {count}件" for slot, count in sorted(time_slots.items()))}
"""

    # メッセージサンプル: チップ全件 + チャット最初50件 + 最後50件
    tip_lines = []
    for m in tip_msgs:
        tip_lines.append(f"[{m.get('message_time', '')[:16]}] {m.get('user_name', '?')}: [{m['tokens']}c] {m.get('message', '')}")

    chat_msgs = [m for m in msgs if m.get("msg_type") == "chat"]
    chat_first = chat_msgs[:50]
    chat_last = chat_msgs[-50:] if len(chat_msgs) > 50 else []

    chat_sample_lines = []
    for m in chat_first:
        chat_sample_lines.append(f"[{m.get('message_time', '')[:16]}] {m.get('user_name', '?')}: {m.get('message', '')}")
    if chat_last:
        chat_sample_lines.append(f"\n... ({len(chat_msgs) - 100}件省略) ...\n")
        for m in chat_last:
            chat_sample_lines.append(f"[{m.get('message_time', '')[:16]}] {m.get('user_name', '?')}: {m.get('message', '')}")

    messages_sample = f"""【チップメッセージ全件({len(tip_lines)}件)】
{chr(10).join(tip_lines) if tip_lines else "  (なし)"}

【チャットメッセージサンプル({len(chat_msgs)}件中)】
{chr(10).join(chat_sample_lines) if chat_sample_lines else "  (なし)"}
"""

    system_prompt = "あなたはライブ配信の分析アシスタントです。以下の配信セッションデータを分析し、日本語でレポートを生成してください。具体的な数値やユーザー名を引用して、実用的で読みやすいレポートを書いてください。"

    user_prompt = f"""{stats_text}

{messages_sample}

以下のセクションでレポートを生成してください:

## 📊 配信の要約
配信の概要を3行でまとめてください。

## 🔥 盛り上がりポイント
チップが集中した時間帯や、会話が盛り上がった瞬間を分析してください。

## 🐋 常連ファンの動向
よく発言するユーザーの特徴、太客の行動パターンを分析してください。

## 💡 改善提案
次回の配信に向けた具体的なアドバイスを3つ提示してください。

## 🎯 推奨アクション
DM送信候補のユーザーや、お礼すべきユーザーをリストアップしてください。理由も添えてください。
"""

    settings = get_settings()
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )

    report_text = response.content[0].text
    tokens_used = response.usage.input_tokens + response.usage.output_tokens
    cost_usd = round((response.usage.input_tokens * 3 + response.usage.output_tokens * 15) / 1_000_000, 6)

    # (e) ai_reportsにINSERT
    report_row = {
        "account_id": body.account_id,
        "session_id": body.session_id,
        "cast_name": cast_name,
        "report_type": "session_analysis",
        "output_text": report_text,
        "model": "claude-sonnet",
        "tokens_used": tokens_used,
        "cost_usd": cost_usd,
    }
    result = sb.table("ai_reports").insert(report_row).execute()

    # AI使用カウンター更新
    try:
        profile = sb.table("profiles").select("ai_used_this_month").eq("id", user["user_id"]).single().execute()
        if profile.data:
            sb.table("profiles").update({
                "ai_used_this_month": profile.data["ai_used_this_month"] + 1
            }).eq("id", user["user_id"]).execute()
    except Exception:
        pass

    return {
        "report_id": result.data[0]["id"],
        "content": report_text,
        "tokens_used": tokens_used,
        "cost_usd": cost_usd,
        "generated_at": result.data[0]["created_at"],
    }


@router.get("")
async def list_reports(
    account_id: str,
    session_id: str = None,
    limit: int = Query(default=10, le=50),
    user=Depends(get_current_user)
):
    """AIレポート一覧"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    query = (sb.table("ai_reports")
             .select("*")
             .eq("account_id", account_id)
             .eq("report_type", "session_analysis")
             .order("created_at", desc=True)
             .limit(limit))

    if session_id:
        query = query.eq("session_id", session_id)

    result = query.execute()
    return {"reports": result.data or []}
