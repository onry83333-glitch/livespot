"""Sync router - Coin API同期, CSVアップロード, デモデータ, Cookie同期, ステータス"""
import csv
import io
import json
import logging
import random
import string
import httpx
from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel
from typing import Optional
from config import get_supabase_admin
from routers.auth import get_current_user

logger = logging.getLogger(__name__)

# Cookie JSONファイルの保存先
COOKIE_FILE = Path(__file__).resolve().parent.parent / "collector" / "cookies.json"

router = APIRouter()


# ============================================================
# Schemas
# ============================================================
class CoinSyncRequest(BaseModel):
    account_id: str
    cookie_encrypted: str  # Stripchatのセッションcookie
    cast_name: Optional[str] = None  # キャスト名（データ分離用）


class CoinSyncResponse(BaseModel):
    synced_transactions: int
    synced_users: int
    last_transaction_date: Optional[str] = None


class SyncStatusResponse(BaseModel):
    account_id: str
    total_users: int
    total_transactions: int
    last_sync: Optional[str] = None
    total_coins: int = 0


class DemoSyncResponse(BaseModel):
    inserted_users: int
    inserted_transactions: int


# ============================================================
# Helpers
# ============================================================
def _verify_account_ownership(sb, account_id: str, user_id: str):
    result = (
        sb.table("accounts")
        .select("id")
        .eq("id", account_id)
        .eq("user_id", user_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Account not found")


STRIPCHAT_COINS_API = "https://stripchat.com/api/front/v2/earnings/coins-history"

TX_TYPES = ["private", "ticket", "tip", "spy", "group", "striptease"]


# ============================================================
# 1. POST /coins - Stripchat Earnings API 経由の名簿同期
# ============================================================
@router.post("/coins", response_model=CoinSyncResponse)
async def sync_coins(body: CoinSyncRequest, user=Depends(get_current_user)):
    """Stripchat Coin API経由で課金履歴を同期"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, body.account_id, user["user_id"])

    # Stripchat APIを呼び出し
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # ページネーション: 最大10ページ取得
            all_transactions = []
            page = 1
            while page <= 10:
                resp = await client.get(
                    STRIPCHAT_COINS_API,
                    params={"page": page, "limit": 100},
                    headers={
                        "Cookie": body.cookie_encrypted,
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    },
                )
                if resp.status_code == 401:
                    raise HTTPException(
                        status_code=401,
                        detail="Stripchatのセッションが期限切れです。再ログインしてcookieを更新してください。",
                    )
                if resp.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Stripchat API error: {resp.status_code}",
                    )

                data = resp.json()
                items = data.get("transactions") or data.get("items") or data.get("data") or []
                if not items:
                    break

                all_transactions.extend(items)
                # 次ページがなければ終了
                if len(items) < 100:
                    break
                page += 1

    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Stripchat APIがタイムアウトしました")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stripchat API接続エラー: {str(e)}")

    if not all_transactions:
        return CoinSyncResponse(synced_transactions=0, synced_users=0)

    # coin_transactions に UPSERT
    tx_rows = []
    for tx in all_transactions:
        user_name = tx.get("userName") or tx.get("user_name") or tx.get("username") or ""
        tokens = int(tx.get("tokens") or tx.get("amount") or 0)
        tx_type = tx.get("type") or tx.get("source") or "unknown"
        tx_date = tx.get("date") or tx.get("createdAt") or tx.get("created_at") or datetime.now(timezone.utc).isoformat()
        source_detail = tx.get("description") or tx.get("sourceDetail") or ""

        if not user_name:
            continue
        if tokens <= 0:
            continue

        tx_rows.append(
            {
                "account_id": body.account_id,
                "cast_name": getattr(body, "cast_name", None),
                "user_name": user_name,
                "tokens": tokens,
                "type": tx_type,
                "date": tx_date,
                "source_detail": source_detail,
            }
        )

    synced_tx = 0
    if tx_rows:
        result = (
            sb.table("coin_transactions")
            .upsert(tx_rows, on_conflict="account_id,user_name,cast_name,tokens,date")
            .execute()
        )
        synced_tx = len(result.data)

    # paid_users を coin_transactions から集計して UPSERT
    user_agg = {}
    for row in tx_rows:
        un = row["user_name"]
        if un not in user_agg:
            user_agg[un] = {"total_coins": 0, "last_payment_date": None}
        user_agg[un]["total_coins"] += row["tokens"]
        d = row["date"]
        if user_agg[un]["last_payment_date"] is None or d > user_agg[un]["last_payment_date"]:
            user_agg[un]["last_payment_date"] = d

    user_rows = []
    cast_name = getattr(body, "cast_name", None)
    for un, agg in user_agg.items():
        row = {
            "account_id": body.account_id,
            "user_name": un,
            "total_coins": agg["total_coins"],
            "last_payment_date": agg["last_payment_date"],
        }
        if cast_name:
            row["cast_name"] = cast_name
        user_rows.append(row)

    synced_users = 0
    if user_rows:
        result = (
            sb.table("paid_users")
            .upsert(user_rows, on_conflict="account_id,user_name")
            .execute()
        )
        synced_users = len(result.data)

    # MATERIALIZED VIEW 更新
    try:
        sb.rpc("refresh_paying_users").execute()
    except Exception:
        pass  # VIEW が存在しない場合はスキップ

    last_date = None
    if tx_rows:
        dates = [r["date"] for r in tx_rows if r["date"]]
        if dates:
            last_date = max(dates) if isinstance(dates[0], str) else max(dates).isoformat()

    return CoinSyncResponse(
        synced_transactions=synced_tx,
        synced_users=synced_users,
        last_transaction_date=last_date,
    )


# ============================================================
# 2. POST /demo - デモデータ投入
# ============================================================
@router.post("/demo", response_model=DemoSyncResponse)
async def sync_demo(account_id: str, user=Depends(get_current_user)):
    """開発テスト用デモデータ投入"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    now = datetime.now(timezone.utc)

    # --- paid_users: 10件 ---
    user_names = [
        f"viewer_{''.join(random.choices(string.ascii_lowercase + string.digits, k=6))}"
        for _ in range(10)
    ]

    paid_user_rows = []
    for i, un in enumerate(user_names):
        total_coins = random.randint(50, 50000)
        days_ago = random.randint(0, 30)
        paid_user_rows.append(
            {
                "account_id": account_id,
                "user_name": un,
                "total_coins": total_coins,
                "last_payment_date": (now - timedelta(days=days_ago)).isoformat(),
                "user_level": random.choice([0, 1, 2, 3, 5, 10]),
                "profile_url": f"https://stripchat.com/user/{un}",
            }
        )

    result_users = (
        sb.table("paid_users")
        .upsert(paid_user_rows, on_conflict="account_id,user_name")
        .execute()
    )

    # --- coin_transactions: 30件 ---
    tx_rows = []
    for _ in range(30):
        un = random.choice(user_names)
        tokens = random.choice([5, 10, 25, 50, 100, 200, 500, 1000, 2500])
        tx_type = random.choice(TX_TYPES)
        days_ago = random.randint(0, 30)
        hours_ago = random.randint(0, 23)
        tx_date = now - timedelta(days=days_ago, hours=hours_ago)

        tx_rows.append(
            {
                "account_id": account_id,
                "user_name": un,
                "tokens": tokens,
                "type": tx_type,
                "date": tx_date.isoformat(),
                "source_detail": f"demo_{tx_type}",
            }
        )

    result_tx = sb.table("coin_transactions").insert(tx_rows).execute()

    # MATERIALIZED VIEW 更新
    try:
        sb.rpc("refresh_paying_users").execute()
    except Exception:
        pass

    return DemoSyncResponse(
        inserted_users=len(result_users.data),
        inserted_transactions=len(result_tx.data),
    )


# ============================================================
# 3. GET /status/{account_id} - 同期状態取得
# ============================================================
@router.get("/status/{account_id}", response_model=SyncStatusResponse)
async def get_sync_status_by_id(account_id: str, user=Depends(get_current_user)):
    """アカウントの同期状態を取得"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    # paid_users 件数
    users = (
        sb.table("paid_users")
        .select("id", count="exact")
        .eq("account_id", account_id)
        .execute()
    )

    # coin_transactions 件数
    tx = (
        sb.table("coin_transactions")
        .select("id", count="exact")
        .eq("account_id", account_id)
        .execute()
    )

    # 合計コイン
    coins_result = (
        sb.table("coin_transactions")
        .select("tokens")
        .eq("account_id", account_id)
        .execute()
    )
    total_coins = sum(r["tokens"] for r in (coins_result.data or []))

    # 最新トランザクション日
    latest_tx = (
        sb.table("coin_transactions")
        .select("date")
        .eq("account_id", account_id)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )

    return SyncStatusResponse(
        account_id=account_id,
        total_users=users.count or 0,
        total_transactions=tx.count or 0,
        last_sync=latest_tx.data[0]["date"] if latest_tx.data else None,
        total_coins=total_coins,
    )


# ============================================================
# 4. GET /status (レガシー互換)
# ============================================================
@router.get("/status")
async def get_sync_status(account_id: str, user=Depends(get_current_user)):
    """レガシー互換: query paramでaccount_id指定"""
    return await get_sync_status_by_id(account_id, user)


# ============================================================
# 5. POST /csv - CSV名簿アップロード
# ============================================================
@router.post("/csv")
async def upload_csv(
    account_id: str = Form(...),
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    """CSVファイルからpaid_usersをアップロード"""
    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    content = await file.read()
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))

    rows = []
    for row in reader:
        un = (row.get("user_name") or "").strip()
        if not un:
            continue
        rows.append(
            {
                "account_id": account_id,
                "user_name": un,
                "total_coins": int(row.get("total_coins", 0) or 0),
                "last_payment_date": row.get("last_payment_date") or None,
                "user_id_stripchat": row.get("user_id", ""),
                "profile_url": row.get("profile_url", ""),
            }
        )

    if not rows:
        raise HTTPException(status_code=400, detail="CSVに有効な行がありません")

    result = (
        sb.table("paid_users")
        .upsert(rows, on_conflict="account_id,user_name")
        .execute()
    )

    return {"upserted": len(result.data)}


# ============================================================
# 6. POST /coin-transactions - Chrome拡張からの直接投入
# ============================================================
@router.post("/coin-transactions")
async def upload_coin_transactions(
    account_id: str = Form(...),
    transactions: str = Form(...),
    user=Depends(get_current_user),
):
    """Chrome拡張からの課金トランザクション投入（JSON文字列）"""
    import json

    sb = get_supabase_admin()
    _verify_account_ownership(sb, account_id, user["user_id"])

    tx_list = json.loads(transactions)
    rows = [
        {
            "account_id": account_id,
            "user_name": tx["user_name"],
            "cast_name": tx.get("cast_name", ""),
            "tokens": tx["tokens"],
            "type": tx["type"],
            "date": tx["date"],
            "source_detail": tx.get("source_detail", ""),
        }
        for tx in tx_list
        if int(tx.get("tokens", 0)) > 0
    ]

    if rows:
        sb.table("coin_transactions").upsert(
            rows,
            on_conflict="account_id,user_name,cast_name,tokens,date",
            ignore_duplicates=True,
        ).execute()

    # MATERIALIZED VIEW 更新
    try:
        sb.rpc("refresh_paying_users").execute()
    except Exception:
        pass

    return {"inserted": len(rows)}


# ============================================================
# Cookie同期 — Chrome拡張 → cookies.json
# ============================================================
class CookieSyncRequest(BaseModel):
    account_id: str
    cookies: dict[str, str]  # {"cookie_name": "cookie_value", ...}


@router.post("/cookies")
async def sync_cookies(body: CookieSyncRequest, user=Depends(get_current_user)):
    """
    Chrome拡張から Stripchat Cookie を受信し cookies.json に保存。
    Chrome DB ロック問題を完全回避する方式B。
    """
    sb = get_supabase_admin()
    _verify_account_ownership(sb, body.account_id, user["user_id"])

    if not body.cookies:
        raise HTTPException(status_code=400, detail="cookies が空です")

    # cookies.json に書き出し
    payload = {
        "account_id": body.account_id,
        "cookies": body.cookies,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source": "chrome_extension",
    }

    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    COOKIE_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Cookie同期完了: {len(body.cookies)}件 → {COOKIE_FILE}")

    return {
        "ok": True,
        "saved_to": str(COOKIE_FILE),
        "cookie_count": len(body.cookies),
        "exported_at": payload["exported_at"],
    }
