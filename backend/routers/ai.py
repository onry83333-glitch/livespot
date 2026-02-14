"""AI router - Live assist, daily report, DM suggestions"""
from fastapi import APIRouter, Depends, HTTPException
from config import get_supabase_admin, get_settings
from routers.auth import get_current_user
from models.schemas import AIAssistRequest
from services.llm_engine import generate_live_assist, generate_daily_report

router = APIRouter()


@router.post("/live-assist")
async def live_assist(body: AIAssistRequest, user=Depends(get_current_user)):
    """配信中AIアシスト（手動ボタン）"""
    sb = get_supabase_admin()

    # Check AI usage limit
    profile = sb.table("profiles").select("ai_used_this_month, max_ai_per_month").eq("id", user["user_id"]).single().execute()
    if profile.data["max_ai_per_month"] > 0 and profile.data["ai_used_this_month"] >= profile.data["max_ai_per_month"]:
        raise HTTPException(status_code=403, detail="Monthly AI limit reached")

    # Call LLM
    result = await generate_live_assist(
        cast_name=body.cast_name,
        recent_messages=body.recent_messages,
        context=body.context,
    )

    # Save report
    sb.table("ai_reports").insert({
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "report_type": "live_assist",
        "output_text": result["text"],
        "model": result["model"],
        "tokens_used": result["tokens_used"],
        "cost_usd": result["cost_usd"],
    }).execute()

    # Increment usage
    sb.table("profiles").update({
        "ai_used_this_month": profile.data["ai_used_this_month"] + 1
    }).eq("id", user["user_id"]).execute()

    return result


@router.post("/daily-report")
async def daily_report(body: AIAssistRequest, user=Depends(get_current_user)):
    """日次レポート生成"""
    sb = get_supabase_admin()

    profile = sb.table("profiles").select("ai_used_this_month, max_ai_per_month").eq("id", user["user_id"]).single().execute()
    if profile.data["max_ai_per_month"] > 0 and profile.data["ai_used_this_month"] >= profile.data["max_ai_per_month"]:
        raise HTTPException(status_code=403, detail="Monthly AI limit reached")

    result = await generate_daily_report(
        cast_name=body.cast_name,
        recent_messages=body.recent_messages,
        context=body.context,
    )

    sb.table("ai_reports").insert({
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "report_type": "daily_summary",
        "output_text": result["text"],
        "model": result["model"],
        "tokens_used": result["tokens_used"],
        "cost_usd": result["cost_usd"],
    }).execute()

    sb.table("profiles").update({
        "ai_used_this_month": profile.data["ai_used_this_month"] + 1
    }).eq("id", user["user_id"]).execute()

    return result


@router.get("/reports")
async def list_reports(
    account_id: str,
    report_type: str = None,
    limit: int = 20,
    user=Depends(get_current_user)
):
    sb = get_supabase_admin()
    query = (sb.table("ai_reports")
             .select("*")
             .eq("account_id", account_id)
             .order("created_at", desc=True)
             .limit(limit))
    if report_type:
        query = query.eq("report_type", report_type)
    return query.execute().data
