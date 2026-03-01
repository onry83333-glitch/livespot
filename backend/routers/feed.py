"""Feed router - Cast feed posts management & analytics"""
from datetime import datetime, timedelta
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from config import get_supabase_admin
from routers.auth import get_current_user

router = APIRouter()


def _verify_account(sb, account_id: str, user_id: str):
    result = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Account not found")


class FeedPostCreate(BaseModel):
    account_id: str
    cast_name: str
    post_type: str = "text"
    content: Optional[str] = None
    media_url: Optional[str] = None
    posted_at: datetime


# ============================================================
# GET /posts
# ============================================================
@router.get("/posts")
async def list_posts(
    account_id: str,
    cast_name: str = None,
    since: str = None,
    limit: int = Query(default=50, le=200),
    user=Depends(get_current_user),
):
    """フィード投稿一覧"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    query = (sb.table("feed_posts")
             .select("id, cast_name, post_type, content, media_url, likes_count, comments_count, posted_at")
             .eq("account_id", account_id)
             .order("posted_at", desc=True)
             .limit(limit))

    if cast_name:
        query = query.eq("cast_name", cast_name)
    if since:
        query = query.gte("posted_at", since)

    result = query.execute()
    return {"posts": result.data or []}


# ============================================================
# POST /posts
# ============================================================
@router.post("/posts")
async def create_post(body: FeedPostCreate, user=Depends(get_current_user)):
    """フィード投稿を登録"""
    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])

    row = {
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "post_type": body.post_type,
        "content": body.content,
        "media_url": body.media_url,
        "posted_at": body.posted_at.isoformat(),
    }

    result = sb.table("feed_posts").insert(row).execute()
    inserted = result.data[0]
    return {"id": inserted["id"], "posted_at": inserted["posted_at"]}


# ============================================================
# GET /analytics
# ============================================================
@router.get("/analytics")
async def feed_analytics(
    account_id: str,
    days: int = Query(default=30, le=180),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user),
):
    """フィード分析: 週別投稿数、タイプ別内訳、セッション視聴者数との相関"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    # 投稿データ取得
    posts_q = (sb.table("feed_posts")
               .select("id, cast_name, post_type, content, media_url, likes_count, comments_count, posted_at")
               .eq("account_id", account_id)
               .gte("posted_at", since)
               .order("posted_at", desc=True)
               .limit(500))
    if cast_name:
        posts_q = posts_q.eq("cast_name", cast_name)
    posts_result = posts_q.execute()

    posts = posts_result.data or []

    # --- 週別投稿数 ---
    weekly: dict[str, int] = defaultdict(int)
    for p in posts:
        try:
            dt = datetime.fromisoformat(p["posted_at"].replace("Z", "+00:00"))
            # ISO week start (Monday)
            week_start = dt - timedelta(days=dt.weekday())
            week_key = week_start.strftime("%Y-%m-%d")
            weekly[week_key] += 1
        except (ValueError, KeyError):
            pass

    weekly_list = [{"week": k, "count": v} for k, v in sorted(weekly.items())]

    # --- post_type別内訳 ---
    by_type: dict[str, int] = defaultdict(int)
    for p in posts:
        by_type[p.get("post_type", "text")] += 1

    by_type_list = [{"type": k, "count": v} for k, v in sorted(by_type.items(), key=lambda x: -x[1])]

    # --- 直近投稿10件 ---
    recent = posts[:10]

    # --- セッション視聴者数との相関 ---
    # 各投稿日の翌セッションの視聴者数を取得
    sess_q = (sb.table("sessions")
              .select("session_id, started_at, unique_users, total_coins")
              .eq("account_id", account_id)
              .gte("started_at", since)
              .order("started_at")
              .limit(200))
    if cast_name:
        sess_q = sess_q.eq("cast_name", cast_name)
    sessions_result = sess_q.execute()

    sessions_list = sessions_result.data or []

    correlation = []
    for p in posts:
        try:
            post_dt = datetime.fromisoformat(p["posted_at"].replace("Z", "+00:00"))
            post_date = post_dt.strftime("%Y-%m-%d")

            # 投稿日以降の最初のセッションを探す
            next_session = None
            for s in sessions_list:
                sess_dt = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00"))
                if sess_dt >= post_dt:
                    next_session = s
                    break

            correlation.append({
                "post_id": p["id"],
                "post_date": post_date,
                "post_type": p.get("post_type", "text"),
                "next_session_viewers": next_session["unique_users"] if next_session else None,
                "next_session_coins": next_session["total_coins"] if next_session else None,
                "next_session_date": next_session["started_at"] if next_session else None,
            })
        except (ValueError, KeyError):
            pass

    return {
        "weekly": weekly_list,
        "by_type": by_type_list,
        "recent": recent,
        "correlation": correlation,
        "total_posts": len(posts),
    }
