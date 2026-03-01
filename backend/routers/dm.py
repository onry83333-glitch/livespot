"""DM router - Queue management, templates, effectiveness, thank-you candidates, churn risk, ADM trigger"""
import re
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from config import get_supabase_admin
from routers.auth import get_current_user
from models.schemas import (
    DMQueueCreate, DMBatchCreate, DMBatchResponse, DMBatchStatus,
    DMStatusUpdate, DMTemplateCreate, DMLogResponse,
)
from services.adm_engine import run_adm_cycle

router = APIRouter()


def _verify_account_ownership(sb, account_id: str, user_id: str):
    """Verify user owns the account"""
    result = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Account not found")


def _get_first_account_id(sb, user_id: str) -> str:
    """ユーザーの最初のaccountを取得"""
    result = sb.table("accounts").select("id").eq("user_id", user_id).limit(1).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="アカウントが見つかりません。先にアカウントを作成してください。")
    return result.data[0]["id"]


def _extract_username(target: str) -> str:
    """URLまたはユーザー名からユーザー名を抽出"""
    # https://ja.stripchat.com/user/username → username
    match = re.search(r'/user/([^/?#]+)', target)
    if match:
        return match.group(1)
    # URLでなければそのまま返す
    return target.strip()


# ============================================================
# DM Queue — Web UI 一斉送信
# ============================================================
@router.post("/queue", response_model=DMBatchResponse)
async def create_dm_batch(
    body: DMBatchCreate,
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user),
):
    """Web UIからの一斉送信キュー登録"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    # プラン上限チェック
    profile = sb.table("profiles").select("dm_used_this_month, max_dm_per_month").eq("id", user["user_id"]).single().execute()
    remaining = profile.data["max_dm_per_month"] - profile.data["dm_used_this_month"]
    if remaining <= 0:
        raise HTTPException(status_code=403, detail="今月のDM送信上限に達しました")

    # ターゲット処理
    targets = body.targets[:remaining]
    batch_id = f"batch_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}_{user['user_id'][:8]}"

    rows = []
    for t in targets:
        user_name = _extract_username(t)
        profile_url = t if t.startswith("http") else None
        row = {
            "account_id": account_id,
            "user_name": user_name,
            "profile_url": profile_url,
            "message": body.message,
            "image_url": body.image_url,
            "image_sent": body.image_url is not None,
            "status": "queued",
            "campaign": batch_id,
            "template_name": "",
        }
        if cast_name:
            row["cast_name"] = cast_name
        rows.append(row)

    result = sb.table("dm_send_log").insert(rows).execute()

    # 使用カウンター更新
    sb.table("profiles").update({
        "dm_used_this_month": profile.data["dm_used_this_month"] + len(rows)
    }).eq("id", user["user_id"]).execute()

    return DMBatchResponse(
        queued=len(result.data),
        batch_id=batch_id,
        send_order=body.send_order,
        send_mode=body.send_mode,
        concurrent_tabs=body.concurrent_tabs,
    )


# ============================================================
# DM Batch Status
# ============================================================
@router.get("/status/{batch_id}", response_model=DMBatchStatus)
async def get_batch_status(batch_id: str, user=Depends(get_current_user)):
    """バッチの送信状況を取得"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    result = (sb.table("dm_send_log")
              .select("*")
              .eq("account_id", account_id)
              .eq("campaign", batch_id)
              .order("queued_at")
              .execute())

    items = result.data or []

    counts = {"queued": 0, "sending": 0, "success": 0, "error": 0, "pending": 0}
    for item in items:
        s = item.get("status", "queued")
        if s in counts:
            counts[s] += 1

    return DMBatchStatus(
        batch_id=batch_id,
        total=len(items),
        queued=counts["queued"] + counts["pending"],
        sending=counts["sending"],
        success=counts["success"],
        error=counts["error"],
        items=items,
    )


# ============================================================
# DM History
# ============================================================
@router.get("/history")
async def get_dm_history(
    limit: int = Query(default=100, le=500),
    user=Depends(get_current_user)
):
    """直近の送信履歴を返す"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    result = (sb.table("dm_send_log")
              .select("*")
              .eq("account_id", account_id)
              .order("queued_at", desc=True)
              .limit(limit)
              .execute())

    return {"items": result.data or []}


# ============================================================
# DM Queue — Chrome拡張ポーリング用
# ============================================================
@router.get("/queue")
async def get_dm_queue(
    account_id: str,
    status: str = "queued",
    limit: int = Query(default=10, le=50),
    user=Depends(get_current_user)
):
    """Chrome extension polls this to get pending DM tasks"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    result = (sb.table("dm_send_log")
              .select("*")
              .eq("account_id", account_id)
              .eq("status", status)
              .order("queued_at")
              .limit(limit)
              .execute())
    return result.data


@router.put("/queue/{dm_id}/status")
async def update_dm_status(dm_id: int, body: DMStatusUpdate, user=Depends(get_current_user)):
    """Chrome extension reports send result"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    update_data = {"status": body.status}
    if body.error:
        update_data["error"] = body.error
    if body.sent_at:
        update_data["sent_at"] = body.sent_at.isoformat()
    elif body.status == "success":
        update_data["sent_at"] = datetime.utcnow().isoformat()

    result = sb.table("dm_send_log").update(update_data).eq("id", dm_id).eq("account_id", account_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="DM log not found")
    return result.data[0]


# ============================================================
# DM Logs (レガシー互換)
# ============================================================
@router.get("/log")
async def get_dm_log(
    account_id: str,
    campaign: str = None,
    days: int = Query(default=30, le=365),
    limit: int = Query(default=100, le=1000),
    user=Depends(get_current_user)
):
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    query = (sb.table("dm_send_log")
             .select("*")
             .eq("account_id", account_id)
             .gte("queued_at", since)
             .order("queued_at", desc=True)
             .limit(limit))

    if campaign:
        query = query.eq("campaign", campaign)

    return query.execute().data


# ============================================================
# DM Effectiveness
# ============================================================
@router.get("/effectiveness")
async def get_dm_effectiveness(
    account_id: str,
    window_days: int = Query(default=7, le=30),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """DM送信後N日以内の再課金率（キャンペーン別）"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    params = {"p_account_id": account_id, "p_window_days": window_days}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("dm_effectiveness", params).execute()

    return result.data


# ============================================================
# Templates
# ============================================================
@router.get("/templates")
async def list_templates(account_id: str, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])
    result = sb.table("dm_templates").select("*").eq("account_id", account_id).order("created_at").execute()
    return result.data


@router.post("/templates")
async def create_template(body: DMTemplateCreate, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    _verify_account_ownership(sb, body.account_id, user["user_id"])

    result = sb.table("dm_templates").insert({
        "account_id": body.account_id,
        "name": body.name,
        "message": body.message,
        "image_url": body.image_url,
        "is_default": body.is_default,
    }).execute()
    return result.data[0]


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    sb.table("dm_templates").delete().eq("id", template_id).execute()
    return {"deleted": True}


# ============================================================
# Thank-you DM Candidates
# ============================================================
@router.get("/thankyou-candidates")
async def get_thankyou_candidates(
    account_id: str,
    cast_name: str = Query(..., description="対象キャスト名"),
    session_id: Optional[str] = Query(default=None, description="セッションID（省略時は最新セッション）"),
    min_tokens: int = Query(default=100, ge=0, description="最小トークン数"),
    user=Depends(get_current_user),
):
    """配信終了後のお礼DM候補を取得"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    try:
        result = sb.rpc("get_thankyou_dm_candidates", {
            "p_account_id": account_id,
            "p_cast_name": cast_name,
            "p_session_id": session_id,
            "p_min_tokens": min_tokens,
        }).execute()
        return {"data": result.data, "count": len(result.data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"お礼DM候補の取得に失敗: {e}")


# ============================================================
# Churn Risk Detection
# ============================================================
@router.get("/churn-risk")
async def get_churn_risk(
    account_id: str,
    cast_name: str = Query(..., description="対象キャスト名"),
    lookback_sessions: int = Query(default=7, ge=1, le=30, description="遡るセッション数"),
    absence_threshold: int = Query(default=2, ge=1, le=10, description="連続欠席の閾値"),
    user=Depends(get_current_user),
):
    """離脱予兆ユーザーを検出"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    try:
        result = sb.rpc("detect_churn_risk", {
            "p_account_id": account_id,
            "p_cast_name": cast_name,
            "p_lookback_sessions": lookback_sessions,
            "p_absence_threshold": absence_threshold,
        }).execute()
        return {"data": result.data, "count": len(result.data)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"離脱予兆の検出に失敗: {e}")


# ============================================================
# ADM Trigger — 新規ユーザー自動DM発火
# ============================================================
@router.post("/trigger")
async def trigger_adm(
    lookback_hours: int = Query(default=24, ge=1, le=168, description="新規ユーザー検出の遡り時間"),
    user=Depends(get_current_user),
):
    """
    ADM（自動DM）トリガーを実行。
    paid_usersの新規ユーザーを検出し、dm_triggersルールに基づいてDMを自動発火する。
    """
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    try:
        result = await run_adm_cycle(sb, account_id, lookback_hours=lookback_hours)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ADMトリガー実行に失敗: {e}")


# ============================================================
# DM Triggers CRUD — トリガー一覧/作成/更新/削除
# ============================================================
@router.get("/triggers")
async def list_triggers(user=Depends(get_current_user)):
    """有効・無効を含む全トリガーの一覧を返す"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    result = (
        sb.table("dm_triggers")
        .select("*")
        .eq("account_id", account_id)
        .order("priority")
        .execute()
    )
    return {"data": result.data or []}


@router.post("/triggers")
async def create_trigger(body: dict, user=Depends(get_current_user)):
    """新規トリガーを作成する"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    VALID_TRIGGER_TYPES = {
        "first_visit", "vip_no_tip", "churn_risk", "segment_upgrade",
        "competitor_outflow", "post_session", "cross_promotion",
    }
    trigger_type = body.get("trigger_type")
    if trigger_type not in VALID_TRIGGER_TYPES:
        raise HTTPException(status_code=400, detail=f"無効なtrigger_type: {trigger_type}")

    trigger_name = body.get("trigger_name", "").strip()
    if not trigger_name:
        raise HTTPException(status_code=400, detail="trigger_nameは必須です")

    insert_data = {
        "account_id": account_id,
        "trigger_name": trigger_name,
        "trigger_type": trigger_type,
        "cast_name": body.get("cast_name"),
        "condition_config": body.get("condition_config", {}),
        "action_type": body.get("action_type", "direct_dm"),
        "message_template": body.get("message_template"),
        "scenario_id": body.get("scenario_id"),
        "target_segments": body.get("target_segments", []),
        "cooldown_hours": body.get("cooldown_hours", 168),
        "daily_limit": body.get("daily_limit", 50),
        "enabled": body.get("enabled", True),
        "priority": body.get("priority", 100),
    }

    result = sb.table("dm_triggers").insert(insert_data).execute()
    return {"data": result.data[0] if result.data else None}


@router.put("/triggers/{trigger_id}")
async def update_trigger(trigger_id: str, body: dict, user=Depends(get_current_user)):
    """既存トリガーを更新する"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    # 所有権チェック
    existing = (
        sb.table("dm_triggers")
        .select("id")
        .eq("id", trigger_id)
        .eq("account_id", account_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="トリガーが見つかりません")

    UPDATABLE_FIELDS = {
        "trigger_name", "cast_name", "condition_config", "action_type",
        "message_template", "scenario_id", "target_segments",
        "cooldown_hours", "daily_limit", "enabled", "priority",
    }
    update_data = {k: v for k, v in body.items() if k in UPDATABLE_FIELDS}
    if not update_data:
        raise HTTPException(status_code=400, detail="更新フィールドがありません")

    result = (
        sb.table("dm_triggers")
        .update(update_data)
        .eq("id", trigger_id)
        .eq("account_id", account_id)
        .execute()
    )
    return {"data": result.data[0] if result.data else None}


@router.delete("/triggers/{trigger_id}")
async def delete_trigger(trigger_id: str, user=Depends(get_current_user)):
    """トリガーを削除する"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    # 所有権チェック
    existing = (
        sb.table("dm_triggers")
        .select("id")
        .eq("id", trigger_id)
        .eq("account_id", account_id)
        .execute()
    )
    if not existing.data:
        raise HTTPException(status_code=404, detail="トリガーが見つかりません")

    sb.table("dm_triggers").delete().eq("id", trigger_id).eq("account_id", account_id).execute()
    return {"success": True}


@router.get("/trigger-logs")
async def list_trigger_logs(
    trigger_id: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    user=Depends(get_current_user),
):
    """トリガー発火ログを取得する"""
    sb = get_supabase_admin()
    account_id = _get_first_account_id(sb, user["user_id"])

    query = (
        sb.table("dm_trigger_logs")
        .select("*")
        .eq("account_id", account_id)
        .order("fired_at", desc=True)
        .limit(limit)
    )
    if trigger_id:
        query = query.eq("trigger_id", trigger_id)

    result = query.execute()
    return {"data": result.data or []}
