"""Competitive Analysis router - Cross-cast comparison, tip clustering, viewer trends,
user overlap, hourly heatmap, success patterns, cast ranking, and LLM analysis.
"""
import traceback
from typing import Literal, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from config import get_supabase_admin
from routers.auth import get_current_user

router = APIRouter()


def _verify_account(sb, account_id: str, user_id: str):
    """アカウント所有権を確認。見つからない場合は HTTPException(404) を送出。"""
    try:
        result = (
            sb.table("accounts")
            .select("id")
            .eq("id", account_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Account not found")
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] _verify_account error: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=404, detail="Account not found")


def _split_cast_names(cast_names: Optional[str]) -> list[str]:
    """カンマ区切り文字列をリストに変換。空文字・Noneは空リスト。"""
    if not cast_names:
        return []
    return [name.strip() for name in cast_names.split(",") if name.strip()]


# ============================================================
# Competitor Overview
# ============================================================
@router.get("/overview")
async def competitor_overview(
    account_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user=Depends(get_current_user),
):
    """全キャスト概要 → OverviewSummary 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    try:
        result = sb.rpc("get_competitor_overview", {
            "p_account_id": account_id,
            "p_days": days,
        }).execute()

        rows = result.data or []
        # フロントエンドが期待する OverviewSummary 形式に集約
        return {
            "total_casts": len(rows),
            "total_sessions": sum(r.get("total_sessions", 0) for r in rows),
            "total_tokens": sum(r.get("total_tokens", 0) for r in rows),
            "avg_viewers": round(
                sum(r.get("avg_peak_viewers", 0) for r in rows) / max(len(rows), 1), 1
            ),
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /overview error: {e}")
        traceback.print_exc()
        return {
            "total_casts": 0,
            "total_sessions": 0,
            "total_tokens": 0,
            "avg_viewers": 0,
        }


# ============================================================
# Cast Ranking
# ============================================================
@router.get("/ranking")
async def cast_ranking(
    account_id: str,
    metric: Literal["tokens", "viewers", "engagement", "tippers", "duration"] = Query(
        default="tokens", description="ランキング指標"
    ),
    days: int = Query(default=7, ge=1, le=365),
    user=Depends(get_current_user),
):
    """キャストランキング → RankingItem[] 形式で返却（全指標含む + 前期比較）"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    try:
        # get_cast_ranking RPC で前期比較付きランキングを取得
        rank_result = sb.rpc("get_cast_ranking", {
            "p_account_id": account_id,
            "p_metric": metric,
            "p_days": days,
        }).execute()

        # overview RPC で全指標（sessions, viewers, hours等）を取得
        overview_result = sb.rpc("get_competitor_overview", {
            "p_account_id": account_id,
            "p_days": days,
        }).execute()

        # overview データをキャスト名で引けるようにする
        overview_map: dict[str, dict] = {}
        for r in (overview_result.data or []):
            cn = r.get("cast_name", "")
            if cn:
                overview_map[cn] = r

        rank_rows = rank_result.data or []
        ranking = []
        for r in rank_rows:
            cn = r.get("cast_name", "")
            ov = overview_map.get(cn, {})
            cur_val = float(r.get("metric_value", 0))
            prev_val = float(r.get("prev_period_value", 0))

            ranking.append({
                "cast_name": cn,
                "is_own": r.get("is_own_cast", False),
                "sessions": ov.get("total_sessions", 0),
                "tokens": ov.get("total_tokens", 0),
                "viewers": round(float(ov.get("avg_peak_viewers", 0))),
                "engagement": ov.get("unique_tippers", 0),
                "broadcast_hours": float(ov.get("total_hours", 0)),
                # 前期比較（get_cast_ranking が提供）
                "prev_tokens": round(prev_val) if metric == "tokens" else 0,
                "prev_viewers": round(prev_val) if metric == "viewers" else 0,
                "prev_engagement": round(prev_val) if metric in ("engagement", "tippers") else 0,
                "prev_broadcast_hours": round(prev_val, 1) if metric == "duration" else 0,
            })

        # get_cast_ranking は既にソート済みだが、overview 統合後に再ソートしない
        return ranking
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /ranking error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# Session Comparison
# ============================================================
@router.get("/sessions")
async def session_comparison(
    account_id: str,
    cast_names: Optional[str] = Query(default=None, description="カンマ区切りキャスト名"),
    days: int = Query(default=30, ge=1, le=365),
    user=Depends(get_current_user),
):
    """セッション比較 → SessionCompare[] 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    names_list = _split_cast_names(cast_names)

    try:
        result = sb.rpc("get_session_comparison", {
            "p_account_id": account_id,
            "p_cast_names": names_list,
            "p_days": days,
        }).execute()

        rows = result.data or []
        return [{
            "date": str(r.get("session_date", "")),
            "cast_name": r.get("cast_name", ""),
            "duration_min": float(r.get("duration_minutes", 0)),
            "tokens": r.get("total_tokens", 0),
            "peak_viewers": r.get("peak_viewers", 0) or 0,
            "tk_per_min": float(r.get("tokens_per_minute", 0)),
            "msg_per_min": float(r.get("messages_per_minute", 0)),
        } for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /sessions error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# Tip Clustering
# ============================================================
@router.get("/tip-clusters")
async def tip_clustering(
    account_id: str,
    cast_name: str = Query(..., description="対象キャスト名"),
    days: int = Query(default=30, ge=1, le=365),
    user=Depends(get_current_user),
):
    """チップ集中分析 → TipCluster[] 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    try:
        result = sb.rpc("get_tip_clustering", {
            "p_account_id": account_id,
            "p_cast_name": cast_name,
            "p_days": days,
        }).execute()

        rows = result.data or []
        return [{
            "cluster_start": r.get("cluster_start", ""),
            "total_tokens": r.get("total_tokens", 0),
            "participant_count": r.get("unique_tippers", 0),
            "trigger_context": r.get("trigger_context") or "",
            "duration_seconds": r.get("cluster_duration_seconds", 0),
        } for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /tip-clusters error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# Viewer Trends
# ============================================================
@router.get("/viewer-trends")
async def viewer_trends(
    account_id: str,
    cast_names: Optional[str] = Query(default=None, description="カンマ区切りキャスト名"),
    session_id: Optional[str] = Query(default=None, description="特定セッションID"),
    days: int = Query(default=7, ge=1, le=365, description="取得日数"),
    user=Depends(get_current_user),
):
    """視聴者推移 → ViewerTrendPoint[] 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    names_list = _split_cast_names(cast_names)

    try:
        result = sb.rpc("get_viewer_trend", {
            "p_account_id": account_id,
            "p_cast_names": names_list,
            "p_session_id": session_id,
        }).execute()
        # Note: days param accepted for API consistency; RPC uses 24h default when no session_id

        rows = result.data or []
        return [{
            "timestamp": r.get("recorded_at", ""),
            "cast_name": r.get("cast_name", ""),
            "viewers": r.get("total_viewers", 0) or 0,
        } for r in rows]
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /viewer-trends error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# User Overlap
# ============================================================
@router.get("/user-overlap")
async def user_overlap(
    account_id: str,
    days: int = Query(default=30, ge=1, le=365),
    cast_names: Optional[str] = Query(default=None, description="カンマ区切りキャスト名（フィルタ用）"),
    user=Depends(get_current_user),
):
    """ユーザー重複分析 → UserOverlap[] 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    names_filter = set(_split_cast_names(cast_names)) if cast_names else None

    try:
        result = sb.rpc("get_user_overlap", {
            "p_account_id": account_id,
            "p_days": days,
        }).execute()

        rows = result.data or []
        items = [{
            "user_name": r.get("user_name", ""),
            "visited_casts": r.get("casts_visited") or [],
            "total_tokens": r.get("total_tokens_all", 0),
            "main_cast": r.get("primary_cast", ""),
            "loyalty_pct": round(float(r.get("loyalty_score", 0)) * 100, 1),
            "capturable": r.get("is_potential_steal", False),
        } for r in rows]

        # cast_names が指定されている場合、選択キャストのいずれかに訪問しているユーザーのみ返す
        if names_filter:
            items = [
                item for item in items
                if any(c in names_filter for c in item["visited_casts"])
            ]

        return items
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /user-overlap error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# Hourly Heatmap
# ============================================================
@router.get("/heatmap")
async def hourly_heatmap(
    account_id: str,
    cast_names: Optional[str] = Query(default=None, description="カンマ区切りキャスト名"),
    days: int = Query(default=30, ge=1, le=365),
    user=Depends(get_current_user),
):
    """時間帯ヒートマップ → HeatmapCell[] 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    names_list = _split_cast_names(cast_names)

    try:
        result = sb.rpc("get_hourly_heatmap", {
            "p_account_id": account_id,
            "p_cast_names": names_list,
            "p_days": days,
        }).execute()

        rows = result.data or []
        # キャスト横断で曜日×時間帯ごとに集約
        grid: dict[tuple[int, int], dict] = {}
        for r in rows:
            key = (r.get("day_of_week", 0), r.get("hour_jst", 0))
            if key not in grid:
                grid[key] = {"tokens": 0.0, "sessions": 0}
            grid[key]["tokens"] += float(r.get("avg_tokens_per_hour", 0))
            grid[key]["sessions"] += int(r.get("session_count", 0))

        return [{
            "day_of_week": k[0],
            "hour": k[1],
            "tokens": round(v["tokens"], 1),
            "sessions": v["sessions"],
        } for k, v in sorted(grid.items())]
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /heatmap error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# Success Patterns
# ============================================================
@router.get("/success-patterns")
async def success_patterns(
    account_id: str,
    min_tokens: int = Query(default=10000, ge=0, description="成功判定の最小トークン数"),
    cast_names: Optional[str] = Query(default=None, description="カンマ区切りキャスト名（フィルタ用）"),
    user=Depends(get_current_user),
):
    """成功パターン抽出 → SuccessSession[] 形式で返却"""
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])

    names_filter = set(_split_cast_names(cast_names)) if cast_names else None

    try:
        result = sb.rpc("get_success_patterns", {
            "p_account_id": account_id,
            "p_min_tokens": min_tokens,
        }).execute()

        rows = result.data or []
        items = [{
            "cast_name": r.get("cast_name", ""),
            "date": str(r.get("session_date", "")),
            "tokens": r.get("total_tokens", 0),
            "first_tip_seconds": (r.get("first_tip_minute", 0) or 0) * 60,
            "tip_concentration": float(r.get("tip_concentration_ratio", 0)),
            "chat_density": float(r.get("chat_density", 0)),
            "peak_viewers": r.get("peak_viewers", 0) or 0,
        } for r in rows]

        # cast_names が指定されている場合、該当キャストのみ返す
        if names_filter:
            items = [item for item in items if item["cast_name"] in names_filter]

        return items
    except HTTPException:
        raise
    except Exception as e:
        print(f"[competitive] /success-patterns error: {e}")
        traceback.print_exc()
        return []


# ============================================================
# AI Analysis (LLM)
# ============================================================
class AnalyzeRequest(BaseModel):
    account_id: str
    cast_name: str
    analysis_type: Literal["overview", "deep", "compare"] = "overview"


@router.post("/analyze")
async def analyze_cast(body: AnalyzeRequest, user=Depends(get_current_user)):
    """LLMによるキャスト分析レポート生成"""
    from config import get_settings

    # ANTHROPIC_API_KEY チェック
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=400,
            detail="AI分析にはANTHROPIC_API_KEYの設定が必要です",
        )

    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])

    # 分析用データ収集
    try:
        overview_result = sb.rpc("get_competitor_overview", {
            "p_account_id": body.account_id,
            "p_days": 30,
        }).execute()

        cast_data = None
        for r in (overview_result.data or []):
            if r.get("cast_name") == body.cast_name:
                cast_data = r
                break

        if not cast_data:
            raise HTTPException(
                status_code=404,
                detail=f"キャスト '{body.cast_name}' のデータが見つかりません",
            )

        # SPYログの件数チェック（最低50件必要）
        count_result = (
            sb.table("spy_messages")
            .select("id", count="exact")
            .eq("account_id", body.account_id)
            .eq("cast_name", body.cast_name)
            .execute()
        )
        msg_count = count_result.count if count_result.count is not None else 0
        if msg_count < 50:
            raise HTTPException(
                status_code=400,
                detail=f"分析に必要なデータが不足しています（最低50件のSPYログが必要、現在{msg_count}件）",
            )

        # トップチッパー取得
        tip_result = (
            sb.table("spy_messages")
            .select("user_name, tokens")
            .eq("account_id", body.account_id)
            .eq("cast_name", body.cast_name)
            .in_("msg_type", ["tip", "gift"])
            .gt("tokens", 0)
            .order("tokens", desc=True)
            .limit(200)
            .execute()
        )

        tipper_map: dict[str, int] = {}
        for r in (tip_result.data or []):
            name = r.get("user_name", "")
            if name:
                tipper_map[name] = tipper_map.get(name, 0) + (r.get("tokens", 0) or 0)
        top_tippers = sorted(tipper_map.items(), key=lambda x: x[1], reverse=True)[:10]

        # ヒートマップ（ピーク時間帯）
        heatmap_result = sb.rpc("get_hourly_heatmap", {
            "p_account_id": body.account_id,
            "p_cast_names": [body.cast_name],
            "p_days": 30,
        }).execute()

        peak_hours = sorted(
            (heatmap_result.data or []),
            key=lambda x: float(x.get("avg_tokens_per_hour", 0)),
            reverse=True,
        )[:5]

        analysis_data = {
            "cast_name": body.cast_name,
            "total_hours": float(cast_data.get("total_hours", 0)),
            "total_tips": cast_data.get("total_tokens", 0),
            "unique_tippers": cast_data.get("unique_tippers", 0),
            "total_sessions": cast_data.get("total_sessions", 0),
            "avg_peak_viewers": float(cast_data.get("avg_peak_viewers", 0)),
            "top_tippers": [{"name": n, "tokens": t} for n, t in top_tippers],
            "peak_times": [
                {"day": h.get("day_of_week", 0), "hour": h.get("hour_jst", 0),
                 "tokens": float(h.get("avg_tokens_per_hour", 0))}
                for h in peak_hours
            ],
        }

        from services.llm_engine import generate_competitive_analysis
        report = await generate_competitive_analysis(analysis_data, body.analysis_type)
        return report

    except HTTPException:
        raise
    except Exception as e:
        # Anthropic API の具体的エラーメッセージを返す
        print(f"[competitive] /analyze error: {e}")
        traceback.print_exc()
        error_msg = str(e)
        if "AuthenticationError" in error_msg or "api_key" in error_msg.lower():
            raise HTTPException(
                status_code=401,
                detail="ANTHROPIC_API_KEYが無効です。設定を確認してください。",
            )
        raise HTTPException(status_code=500, detail=f"AI分析の実行に失敗: {error_msg}")
