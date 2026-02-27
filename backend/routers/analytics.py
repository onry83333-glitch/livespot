"""Analytics router - Sales dashboard + funnel analysis + new-whale detection
Ported from sync/coin_db.py aggregation functions
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from config import get_supabase_admin
from routers.auth import get_current_user

router = APIRouter()


def _verify_account(sb, account_id: str, user_id: str):
    result = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user_id).single().execute()
    if not result.data:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Account not found")


# ============================================================
# Sales Dashboard (5 tabs)
# ============================================================

@router.get("/sales/daily")
async def daily_sales(
    account_id: str,
    days: int = Query(default=90, le=365),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """日別売上（棒グラフ用）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    params = {"p_account_id": account_id, "p_since": since}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("daily_sales", params).execute()
    return result.data


@router.get("/sales/cumulative")
async def cumulative_sales(
    account_id: str,
    days: int = Query(default=90, le=365),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """累計推移（折れ線グラフ用）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    # Get daily data and compute cumulative client-side
    params = {"p_account_id": account_id, "p_since": since}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("daily_sales", params).execute()

    cumulative = []
    total = 0
    for day in result.data:
        total += day["tokens"]
        cumulative.append({**day, "cumulative": total})
    return cumulative


@router.get("/users/ranking")
async def top_users(
    account_id: str,
    limit: int = Query(default=15, le=50),
    user=Depends(get_current_user)
):
    """太客ランキング"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    result = (sb.table("paying_users")
              .select("*")
              .eq("account_id", account_id)
              .order("total_tokens", desc=True)
              .limit(limit)
              .execute())
    return result.data


@router.get("/revenue/breakdown")
async def revenue_breakdown(
    account_id: str,
    days: int = Query(default=90, le=365),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """収入源内訳（ドーナツチャート用）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    params = {"p_account_id": account_id, "p_since": since}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("revenue_breakdown", params).execute()
    return result.data


@router.get("/revenue/hourly")
async def hourly_revenue(
    account_id: str,
    days: int = Query(default=30, le=90),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """時間帯分析（ヒートマップ用）— UTC→JST変換"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    params = {"p_account_id": account_id, "p_since": since}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("hourly_revenue", params).execute()
    return result.data


# ============================================================
# Funnel Analysis (8 subtabs)
# ============================================================

@router.get("/funnel/arpu")
async def arpu_trend(
    account_id: str,
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """ARPU推移（月別: 総売上 ÷ ユニーク課金者数）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    params = {"p_account_id": account_id}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("arpu_trend", params).execute()
    return result.data


@router.get("/funnel/ltv")
async def ltv_distribution(account_id: str, user=Depends(get_current_user)):
    """LTV分布（ユーザー別累計tk、6ティア分布）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    result = (sb.table("paying_users")
              .select("total_tokens")
              .eq("account_id", account_id)
              .execute())

    # Tier distribution
    tiers = {"0-99": 0, "100-499": 0, "500-999": 0,
             "1000-4999": 0, "5000-9999": 0, "10000+": 0}
    for row in result.data:
        t = row["total_tokens"]
        if t < 100: tiers["0-99"] += 1
        elif t < 500: tiers["100-499"] += 1
        elif t < 1000: tiers["500-999"] += 1
        elif t < 5000: tiers["1000-4999"] += 1
        elif t < 10000: tiers["5000-9999"] += 1
        else: tiers["10000+"] += 1

    return {"tiers": tiers, "total_users": len(result.data)}


@router.get("/funnel/retention")
async def retention_cohort(
    account_id: str,
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """リテンション（最終支払月別ユーザー分布）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    params = {"p_account_id": account_id}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("retention_cohort", params).execute()
    return result.data


@router.get("/funnel/revenue-trend")
async def revenue_trend(
    account_id: str,
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """収入源推移（月別×タイプ別 積み上げエリア）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    params = {"p_account_id": account_id}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("revenue_trend", params).execute()
    return result.data


@router.get("/funnel/top-users")
async def top_users_detail(
    account_id: str,
    limit: int = Query(default=15, le=50),
    cast_name: Optional[str] = Query(default=None),
    user=Depends(get_current_user)
):
    """太客詳細（累計tk、初課金日、最終課金日、継続月数、主要収入源）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    params = {"p_account_id": account_id, "p_limit": limit}
    if cast_name:
        params["p_cast_name"] = cast_name
    result = sb.rpc("top_users_detail", params).execute()
    return result.data


@router.get("/funnel/segments")
async def funnel_segments(
    account_id: str,
    days: int = Query(default=30, le=90),
    user=Depends(get_current_user)
):
    """ファネル分析: セグメント別ユーザー分布"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    # 課金ユーザー取得
    paying = (sb.table("paying_users")
              .select("user_name, total_tokens, last_paid, first_paid, tx_count")
              .eq("account_id", account_id)
              .execute())

    whale, regular, light, free_seg = [], [], [], []
    paying_names = set()
    for u in (paying.data or []):
        paying_names.add(u["user_name"])
        t = u.get("total_tokens", 0) or 0
        if t >= 1000:
            whale.append(u)
        elif t >= 100:
            regular.append(u)
        elif t >= 10:
            light.append(u)
        else:
            free_seg.append(u)

    # チャットのみユーザー（Lead）
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    msgs = (sb.table("spy_messages")
            .select("user_name")
            .eq("account_id", account_id)
            .eq("msg_type", "chat")
            .gte("message_time", since)
            .limit(2000)
            .execute())

    chat_users = set()
    for m in (msgs.data or []):
        un = m.get("user_name")
        if un:
            chat_users.add(un)

    # キャスト除外
    acct = sb.table("accounts").select("cast_usernames").eq("id", account_id).single().execute()
    cast_names = set(acct.data.get("cast_usernames") or []) if acct.data else set()
    lead_names = chat_users - paying_names - cast_names

    total_payers = len(paying.data or [])
    total_all = total_payers + len(lead_names)

    return {
        "segments": {
            "whale": {"count": len(whale), "total_tokens": sum(u.get("total_tokens", 0) for u in whale)},
            "regular": {"count": len(regular), "total_tokens": sum(u.get("total_tokens", 0) for u in regular)},
            "light": {"count": len(light), "total_tokens": sum(u.get("total_tokens", 0) for u in light)},
            "free": {"count": len(free_seg), "total_tokens": sum(u.get("total_tokens", 0) for u in free_seg)},
            "lead": {"count": len(lead_names), "total_tokens": 0},
        },
        "total_users": total_all,
        "total_payers": total_payers,
        "conversion_rate": round(total_payers / total_all * 100, 1) if total_all > 0 else 0,
    }


@router.get("/funnel/leads")
async def funnel_leads(
    account_id: str,
    segment: str = Query(default=None, regex="^(whale|regular|light|free|lead)$"),
    days: int = Query(default=30, le=90),
    limit: int = Query(default=50, le=200),
    user=Depends(get_current_user)
):
    """リード一覧: セグメント別ユーザーリスト"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    paying = (sb.table("paying_users")
              .select("user_name, total_tokens, last_paid, first_paid, tx_count")
              .eq("account_id", account_id)
              .order("total_tokens", desc=True)
              .execute())

    paying_map = {}
    for u in (paying.data or []):
        t = u.get("total_tokens", 0) or 0
        seg = "whale" if t >= 1000 else "regular" if t >= 100 else "light" if t >= 10 else "free"
        paying_map[u["user_name"]] = {**u, "segment": seg}

    result = []
    if segment in (None, "whale", "regular", "light", "free"):
        for un, info in paying_map.items():
            if segment and info["segment"] != segment:
                continue
            result.append(info)

    if segment in (None, "lead"):
        since = (datetime.utcnow() - timedelta(days=days)).isoformat()
        msgs = (sb.table("spy_messages")
                .select("user_name")
                .eq("account_id", account_id)
                .eq("msg_type", "chat")
                .gte("message_time", since)
                .limit(2000)
                .execute())

        chat_users = set()
        for m in (msgs.data or []):
            un = m.get("user_name")
            if un and un not in paying_map:
                chat_users.add(un)

        acct = sb.table("accounts").select("cast_usernames").eq("id", account_id).single().execute()
        cast_names = set(acct.data.get("cast_usernames") or []) if acct.data else set()
        for un in chat_users - cast_names:
            result.append({"user_name": un, "total_tokens": 0, "segment": "lead"})

    seg_order = {"whale": 0, "regular": 1, "light": 2, "free": 3, "lead": 4}
    result.sort(key=lambda x: (seg_order.get(x["segment"], 5), -(x.get("total_tokens", 0) or 0)))

    return result[:limit]


@router.get("/dm-effectiveness")
async def dm_effectiveness(
    account_id: str,
    campaign: str = Query(default=None),
    cast_name: Optional[str] = Query(default=None),
    days_window: int = Query(default=7, le=30),
    user=Depends(get_current_user),
):
    """DM効果測定（サマリー + キャンペーン別CV率）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    # キャンペーン別データ（RPC）
    params = {"p_account_id": account_id, "p_window_days": days_window}
    if cast_name:
        params["p_cast_name"] = cast_name
    rpc_result = sb.rpc("dm_effectiveness", params).execute()

    by_campaign = rpc_result.data or []

    # 特定キャンペーンでフィルター
    if campaign:
        by_campaign = [r for r in by_campaign if r.get("campaign") == campaign]

    # 全体サマリー集計
    total_sent = sum(r.get("dm_sent_count", 0) for r in by_campaign)
    total_converted = sum(r.get("reconverted_count", 0) for r in by_campaign)
    total_revenue = sum(r.get("reconverted_tokens", 0) for r in by_campaign)
    conversion_rate = round(total_converted * 100.0 / total_sent, 1) if total_sent > 0 else 0
    avg_revenue = round(total_revenue / total_converted) if total_converted > 0 else 0

    return {
        "summary": {
            "total_sent": total_sent,
            "total_converted": total_converted,
            "conversion_rate": conversion_rate,
            "total_revenue_after_dm": total_revenue,
            "avg_revenue_per_converted": avg_revenue,
        },
        "by_campaign": [
            {
                "campaign": r.get("campaign", ""),
                "sent": r.get("dm_sent_count", 0),
                "converted": r.get("reconverted_count", 0),
                "rate": float(r.get("conversion_rate", 0)),
                "revenue": r.get("reconverted_tokens", 0),
            }
            for r in by_campaign
        ],
    }


@router.get("/dm-timeline")
async def dm_timeline(
    account_id: str,
    days: int = Query(default=30, le=90),
    user=Depends(get_current_user),
):
    """日別DM送信・成功・エラー・再課金数"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    # DM送信ログを取得
    dm_result = (
        sb.table("dm_send_log")
        .select("status, queued_at, sent_at, user_name")
        .eq("account_id", account_id)
        .gte("queued_at", since)
        .execute()
    )

    # 再課金データ
    coin_result = (
        sb.table("coin_transactions")
        .select("user_name, date")
        .eq("account_id", account_id)
        .gte("date", since)
        .execute()
    )

    # 再課金ユーザーセット（日付別）
    coin_by_date: dict[str, set] = {}
    for c in (coin_result.data or []):
        d = (c.get("date") or "")[:10]
        if d:
            coin_by_date.setdefault(d, set()).add(c["user_name"])

    # DM送信ユーザーセット（日付別、成功のみ）
    dm_users_by_date: dict[str, set] = {}

    # 日別集計
    day_map: dict[str, dict] = {}
    for dm in (dm_result.data or []):
        d = (dm.get("queued_at") or "")[:10]
        if not d:
            continue
        if d not in day_map:
            day_map[d] = {"date": d, "sent": 0, "success": 0, "error": 0, "converted": 0}
        day_map[d]["sent"] += 1
        status = dm.get("status", "")
        if status == "success":
            day_map[d]["success"] += 1
            dm_users_by_date.setdefault(d, set()).add(dm.get("user_name", ""))
        elif status == "error":
            day_map[d]["error"] += 1

    # 再課金マッチング: DM成功ユーザーが7日以内に課金したか
    for d, dm_users in dm_users_by_date.items():
        converted = 0
        for offset in range(8):  # 0～7日後
            try:
                check_date = (datetime.strptime(d, "%Y-%m-%d") + timedelta(days=offset)).strftime("%Y-%m-%d")
            except ValueError:
                continue
            coin_users = coin_by_date.get(check_date, set())
            converted += len(dm_users & coin_users)
        if d in day_map:
            day_map[d]["converted"] = converted

    # 日付順にソート
    result = sorted(day_map.values(), key=lambda x: x["date"])
    return {"days": result}


# ============================================================
# New Whale Detection + Thank-you DM
# ============================================================

class ThankDMRequest(BaseModel):
    account_id: str
    user_names: list[str]
    template_id: Optional[str] = None
    custom_message: Optional[str] = None


@router.get("/new-whales")
async def new_whales(
    account_id: str,
    since: str = Query(default=None),
    min_coins: int = Query(default=100, ge=1),
    user=Depends(get_current_user),
):
    """新規太客検出: since以降に初めて課金し、合計min_coins以上のユーザー"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    # デフォルト: 昨日0時(UTC)
    if not since:
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        since = yesterday.isoformat()

    # coin_transactionsから全ユーザーのmin(date)とsince以降の合計を取得
    # 全レコードを取得してPython側で集計（RPCなしで実現）
    all_tx = (
        sb.table("coin_transactions")
        .select("user_name, tokens, date")
        .eq("account_id", account_id)
        .order("date")
        .execute()
    )

    # ユーザーごとの最初の課金日と期間内合計を集計
    user_stats: dict[str, dict] = {}
    for tx in (all_tx.data or []):
        un = tx["user_name"]
        if un not in user_stats:
            user_stats[un] = {
                "first_paid": tx["date"],
                "total_tokens_since": 0,
            }
        # first_paid は最初のレコード（order by dateなので先頭）
        if tx["date"] >= since:
            user_stats[un]["total_tokens_since"] += tx["tokens"]

    # since以降に初課金（first_paid >= since）& min_coins以上をフィルタ
    new_users = []
    for un, st in user_stats.items():
        if st["first_paid"] >= since and st["total_tokens_since"] >= min_coins:
            new_users.append({
                "user_name": un,
                "total_tokens": st["total_tokens_since"],
                "first_paid": st["first_paid"],
            })

    # 太客順にソート
    new_users.sort(key=lambda x: x["total_tokens"], reverse=True)

    # dm_send_logで既にDM送信済みか確認
    if new_users:
        user_name_list = [u["user_name"] for u in new_users]
        dm_result = (
            sb.table("dm_send_log")
            .select("user_name")
            .eq("account_id", account_id)
            .in_("user_name", user_name_list)
            .execute()
        )
        dm_sent_set = {r["user_name"] for r in (dm_result.data or [])}
        for u in new_users:
            u["already_dm_sent"] = u["user_name"] in dm_sent_set
    else:
        for u in new_users:
            u["already_dm_sent"] = False

    return {"new_whales": new_users}


@router.post("/thank-dm")
async def thank_dm(
    body: ThankDMRequest,
    user=Depends(get_current_user),
):
    """新規太客へのお礼DM一括キュー登録"""
    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])

    if not body.user_names:
        raise HTTPException(status_code=400, detail="ユーザーを1名以上選択してください")

    # メッセージ取得
    message_template = None
    if body.template_id:
        tpl = (
            sb.table("dm_templates")
            .select("message")
            .eq("id", body.template_id)
            .single()
            .execute()
        )
        if tpl.data:
            message_template = tpl.data["message"]
    if not message_template:
        message_template = body.custom_message or ""

    if not message_template.strip():
        raise HTTPException(status_code=400, detail="メッセージが空です")

    # batch_id生成
    batch_id = f"thank_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}_{user['user_id'][:8]}"

    # dm_send_logにINSERT
    rows = []
    for un in body.user_names:
        # {username}を実際のユーザー名に置換
        msg = message_template.replace("{username}", un)
        rows.append({
            "account_id": body.account_id,
            "user_name": un,
            "message": msg,
            "status": "queued",
            "campaign": "auto_thank_you",
            "template_name": batch_id,
            "image_sent": False,
        })

    result = sb.table("dm_send_log").insert(rows).execute()

    # プロフィールのDM使用カウンター更新
    try:
        profile = (
            sb.table("profiles")
            .select("dm_used_this_month")
            .eq("id", user["user_id"])
            .single()
            .execute()
        )
        if profile.data:
            sb.table("profiles").update({
                "dm_used_this_month": profile.data["dm_used_this_month"] + len(rows)
            }).eq("id", user["user_id"]).execute()
    except Exception:
        pass  # カウンター更新失敗は無視

    return {
        "queued": len(result.data),
        "batch_id": batch_id,
    }
