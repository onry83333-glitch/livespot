"""SPY router - Message ingestion, VIP alerts, comment pickup, sessions"""
from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from config import get_supabase_admin
from routers.auth import get_current_user
from models.schemas import SpyMessageCreate, SessionCreate, SessionUpdate, VIPAlert, ViewerStatsCreate, ViewerStatsBatchCreate, CastTagsUpdate
from services.vip_checker import check_vip, classify_comment

router = APIRouter()


def _verify_account(sb, account_id: str, user_id: str):
    result = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Account not found")


def _get_cast_usernames(sb, account_id: str) -> set:
    """キャスト除外用: accountsのcast_usernamesを取得（カラム未作成時は空setを返す）"""
    try:
        result = sb.table("accounts").select("cast_usernames").eq("id", account_id).single().execute()
        if result.data and result.data.get("cast_usernames"):
            return set(result.data["cast_usernames"])
    except Exception:
        # cast_usernames カラムが存在しない場合（406）はスキップ
        pass
    return set()


# ============================================================
# Message Ingestion (Chrome Extension → API)
# ============================================================
@router.post("/messages")
async def receive_message(body: SpyMessageCreate, user=Depends(get_current_user)):
    """Chrome extension sends intercepted chat messages here."""
    sb = get_supabase_admin()

    # Check VIP (paid_users テーブルが空でもエラーにしない)
    try:
        vip_info = await check_vip(sb, body.account_id, body.user_name)
    except Exception:
        vip_info = None
    is_vip = vip_info is not None

    # Classify comment
    classification = classify_comment(body.message, body.msg_type, body.tokens)

    # キャスト除外チェック (cast_usernames カラム未作成でもエラーにしない)
    cast_users = _get_cast_usernames(sb, body.account_id)
    is_cast = body.user_name in cast_users if body.user_name else False

    metadata = {
        **body.metadata,
        "classification": classification,
        "is_cast": is_cast,
    }
    if vip_info:
        metadata["vip"] = vip_info

    row = {
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "message_time": body.message_time.isoformat(),
        "msg_type": body.msg_type,
        "user_name": body.user_name,
        "message": body.message,
        "tokens": body.tokens,
        "is_vip": is_vip,
        "metadata": metadata,
    }
    if body.user_color:
        row["user_color"] = body.user_color
    if body.user_league:
        row["user_league"] = body.user_league
    if body.user_level is not None:
        row["user_level"] = body.user_level

    # session_id/session_title: カラムが存在する場合のみ付与
    # (マイグレーション 003 適用後に有効)
    if body.session_id:
        row["session_id"] = body.session_id
    if body.session_title:
        row["session_title"] = body.session_title

    try:
        result = sb.table("spy_messages").insert(row).execute()
    except Exception:
        # session_id/session_title カラムが無い場合はそれらを除外してリトライ
        row.pop("session_id", None)
        row.pop("session_title", None)
        result = sb.table("spy_messages").insert(row).execute()

    return {
        "id": result.data[0]["id"],
        "is_vip": is_vip,
        "is_cast": is_cast,
        "vip_alert": vip_info,
        "classification": classification,
    }


# ============================================================
# Batch Messages (for bulk import)
# ============================================================
@router.post("/messages/batch")
async def receive_messages_batch(messages: list[SpyMessageCreate], user=Depends(get_current_user)):
    """Batch insert for catching up or importing CSV logs"""
    sb = get_supabase_admin()

    rows = [{
        "account_id": m.account_id,
        "cast_name": m.cast_name,
        "message_time": m.message_time.isoformat(),
        "msg_type": m.msg_type,
        "user_name": m.user_name,
        "message": m.message,
        "tokens": m.tokens,
        "is_vip": False,
        "metadata": m.metadata,
        **({"session_id": m.session_id} if m.session_id else {}),
        **({"user_color": m.user_color} if m.user_color else {}),
        **({"user_league": m.user_league} if m.user_league else {}),
        **({"user_level": m.user_level} if m.user_level is not None else {}),
    } for m in messages]

    result = sb.table("spy_messages").insert(rows).execute()
    return {"inserted": len(result.data)}


# ============================================================
# Query Messages
# ============================================================
@router.get("/messages")
async def get_messages(
    account_id: str,
    cast_name: str = None,
    session_id: str = None,
    hours: int = Query(default=6, le=72),
    msg_type: str = None,
    vip_only: bool = False,
    exclude_cast: bool = False,
    limit: int = Query(default=200, le=2000),
    user=Depends(get_current_user)
):
    sb = get_supabase_admin()
    since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()

    query = (sb.table("spy_messages")
             .select("*")
             .eq("account_id", account_id)
             .gte("message_time", since)
             .order("message_time", desc=True)
             .limit(limit))

    if cast_name:
        query = query.eq("cast_name", cast_name)
    if session_id:
        query = query.eq("session_id", session_id)
    if msg_type:
        query = query.eq("msg_type", msg_type)
    if vip_only:
        query = query.eq("is_vip", True)

    result = query.execute()
    data = result.data or []

    # キャスト除外（Python側フィルタ — cast_usernamesカラムがJSONBでないため）
    if exclude_cast and data:
        cast_users = _get_cast_usernames(sb, account_id)
        if cast_users:
            data = [m for m in data if m.get("user_name") not in cast_users]

    return data


# ============================================================
# VIP Alerts
# ============================================================
@router.get("/vip-alerts")
async def get_vip_alerts(
    account_id: str,
    hours: int = Query(default=6, le=24),
    user=Depends(get_current_user)
):
    """Recent VIP entries (deduplicated)"""
    sb = get_supabase_admin()
    since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()

    result = (sb.table("spy_messages")
              .select("*")
              .eq("account_id", account_id)
              .eq("is_vip", True)
              .gte("message_time", since)
              .order("message_time", desc=True)
              .limit(50)
              .execute())

    # Deduplicate by user_name (keep latest)
    seen = set()
    alerts = []
    for msg in result.data:
        if msg["user_name"] not in seen:
            seen.add(msg["user_name"])
            vip_data = msg.get("metadata", {}).get("vip", {})
            alerts.append({
                "user_name": msg["user_name"],
                "level": vip_data.get("level", "unknown"),
                "total_tokens": vip_data.get("total_tokens", 0),
                "last_paid": vip_data.get("last_paid"),
                "user_level": vip_data.get("user_level", 0),
                "lifecycle": vip_data.get("lifecycle", "unknown"),
                "alert_message": vip_data.get("alert_message", ""),
                "message_time": msg["message_time"],
            })

    return alerts


# ============================================================
# Comment Pickup
# ============================================================
@router.get("/pickup")
async def get_pickup_comments(
    account_id: str,
    cast_name: str,
    hours: int = Query(default=3, le=12),
    filter_type: str = Query(default="all", regex="^(all|whale|gift|question)$"),
    exclude_cast: bool = False,
    user=Depends(get_current_user)
):
    """Filtered comment pickup (whale/gift/question)"""
    sb = get_supabase_admin()
    since = (datetime.utcnow() - timedelta(hours=hours)).isoformat()

    result = (sb.table("spy_messages")
              .select("*")
              .eq("account_id", account_id)
              .eq("cast_name", cast_name)
              .gte("message_time", since)
              .order("message_time", desc=True)
              .limit(500)
              .execute())

    data = result.data or []

    # キャスト除外
    if exclude_cast and data:
        cast_users = _get_cast_usernames(sb, account_id)
        if cast_users:
            data = [m for m in data if m.get("user_name") not in cast_users]

    if filter_type == "all":
        return data

    # Filter by classification
    filtered = []
    for msg in data:
        cls = msg.get("metadata", {}).get("classification", {})
        if filter_type == "whale" and cls.get("is_whale"):
            filtered.append(msg)
        elif filter_type == "gift" and msg["msg_type"] in ("gift", "tip"):
            filtered.append(msg)
        elif filter_type == "question" and cls.get("is_question"):
            filtered.append(msg)

    return filtered


# ============================================================
# Cast Tags (genre / benchmark / category / notes)
# ============================================================
@router.patch("/casts/{cast_id}/tags")
async def update_cast_tags(cast_id: int, body: CastTagsUpdate, user=Depends(get_current_user)):
    """Update tags (genre, benchmark, category, notes) for a cast."""
    sb = get_supabase_admin()
    update_data: dict = {}
    if body.genre is not None:
        update_data["genre"] = body.genre or None
    if body.benchmark is not None:
        update_data["benchmark"] = body.benchmark or None
    if body.category is not None:
        update_data["category"] = body.category or None
    if body.notes is not None:
        update_data["notes"] = body.notes or None

    if not update_data:
        raise HTTPException(status_code=400, detail="更新データがありません")

    update_data["updated_at"] = datetime.utcnow().isoformat()

    # Try spy_casts first (BIGSERIAL id), then registered_casts
    try:
        result = sb.table("spy_casts").update(update_data).eq("id", cast_id).execute()
        if result.data:
            return result.data[0]
    except Exception:
        pass

    try:
        result = sb.table("registered_casts").update(update_data).eq("id", cast_id).execute()
        if result.data:
            return result.data[0]
    except Exception:
        pass

    raise HTTPException(status_code=404, detail="Cast not found")


# ============================================================
# Sessions
# ============================================================
@router.post("/sessions")
async def create_session(body: SessionCreate, user=Depends(get_current_user)):
    """配信セッション開始"""
    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])

    row = {
        "account_id": body.account_id,
        "session_id": body.session_id,
        "title": body.title,
        "started_at": body.started_at.isoformat(),
    }
    result = sb.table("sessions").insert(row).execute()
    return result.data[0]


@router.put("/sessions/{session_id}")
async def update_session(session_id: str, body: SessionUpdate, user=Depends(get_current_user)):
    """配信セッション終了・更新"""
    sb = get_supabase_admin()

    update_data = {}
    if body.ended_at:
        update_data["ended_at"] = body.ended_at.isoformat()
    if body.title:
        update_data["title"] = body.title

    if not update_data:
        raise HTTPException(status_code=400, detail="更新データがありません")

    result = sb.table("sessions").update(update_data).eq("session_id", session_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Session not found")

    # セッション統計を更新
    try:
        sb.rpc("update_session_stats", {"p_session_id": session_id}).execute()
    except Exception:
        pass

    return result.data[0]


@router.get("/sessions")
async def list_sessions(
    account_id: str,
    limit: int = Query(default=20, le=100),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """セッション一覧"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    q = (sb.table("sessions")
         .select("*")
         .eq("account_id", account_id)
         .order("started_at", desc=True)
         .limit(limit))
    if cast_name:
        q = q.eq("cast_name", cast_name)
    result = q.execute()
    return result.data


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, user=Depends(get_current_user)):
    """セッション詳細"""
    sb = get_supabase_admin()

    result = sb.table("sessions").select("*").eq("session_id", session_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Session not found")

    return result.data


# ============================================================
# Viewer Stats
# ============================================================
@router.post("/viewer-stats")
async def create_viewer_stat(body: ViewerStatsCreate, user=Depends(get_current_user)):
    """視聴者数データを1件記録"""
    sb = get_supabase_admin()

    row = {
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "total": body.total,
        "coin_users": body.coin_users,
        "others": body.others,
    }
    if body.ultimate_count is not None:
        row["ultimate_count"] = body.ultimate_count
    if body.coin_holders is not None:
        row["coin_holders"] = body.coin_holders
    if body.others_count is not None:
        row["others_count"] = body.others_count
    if body.recorded_at:
        row["recorded_at"] = body.recorded_at.isoformat()

    try:
        result = sb.table("viewer_stats").insert(row).execute()
        return {"id": result.data[0]["id"], "recorded_at": result.data[0]["recorded_at"]}
    except Exception as e:
        # viewer_stats テーブルが未作成の場合
        raise HTTPException(status_code=501, detail=f"viewer_statsテーブル未作成: {e}")


@router.post("/viewer-stats/batch")
async def create_viewer_stats_batch(body: ViewerStatsBatchCreate, user=Depends(get_current_user)):
    """視聴者数データを一括記録"""
    sb = get_supabase_admin()

    rows = [{
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "total": s.get("total"),
        "coin_users": s.get("coin_users"),
        "others": s.get("others"),
        **({"ultimate_count": s["ultimate_count"]} if s.get("ultimate_count") is not None else {}),
        **({"coin_holders": s["coin_holders"]} if s.get("coin_holders") is not None else {}),
        **({"others_count": s["others_count"]} if s.get("others_count") is not None else {}),
        **({"recorded_at": s["recorded_at"]} if s.get("recorded_at") else {}),
    } for s in body.stats]

    try:
        result = sb.table("viewer_stats").insert(rows).execute()
        return {"inserted": len(result.data)}
    except Exception as e:
        raise HTTPException(status_code=501, detail=f"viewer_statsテーブル未作成: {e}")


@router.get("/viewer-stats")
async def get_viewer_stats(
    account_id: str,
    cast_name: str = None,
    session_id: str = None,
    since: str = None,
    until: str = None,
    user=Depends(get_current_user)
):
    """視聴者数データ取得"""
    sb = get_supabase_admin()

    query = (sb.table("viewer_stats")
             .select("*")
             .eq("account_id", account_id)
             .order("recorded_at"))

    if cast_name:
        query = query.eq("cast_name", cast_name)

    # session_id → sessionsテーブルからstarted_at/ended_atを取得してフィルタ
    if session_id:
        sess = sb.table("sessions").select("started_at, ended_at").eq("session_id", session_id).single().execute()
        if sess.data:
            query = query.gte("recorded_at", sess.data["started_at"])
            if sess.data.get("ended_at"):
                query = query.lte("recorded_at", sess.data["ended_at"])

    if since:
        query = query.gte("recorded_at", since)
    if until:
        query = query.lte("recorded_at", until)

    result = query.limit(500).execute()
    data = result.data or []

    # Summary
    totals = [d["total"] for d in data if d.get("total") is not None]
    summary = {
        "count": len(data),
        "max": max(totals) if totals else 0,
        "min": min(totals) if totals else 0,
        "avg": round(sum(totals) / len(totals)) if totals else 0,
    }

    return {"stats": data, "summary": summary}
