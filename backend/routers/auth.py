"""Auth router - JWT verification, profile, account management"""
import jwt
from jwt import PyJWKClient
from fastapi import APIRouter, Depends, HTTPException, Request
from functools import lru_cache
from config import get_settings, get_supabase_admin
from models.schemas import AccountCreate, AccountResponse, AccountSettingsUpdate, UserProfile

router = APIRouter()


# ============================================================
# JWKS Client (Supabase ES256 公開鍵をキャッシュ)
# ============================================================
_jwks_client = None

def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        settings = get_settings()
        jwks_url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
        _jwks_client = PyJWKClient(jwks_url, headers={"apikey": settings.supabase_service_key})
    return _jwks_client


# ============================================================
# JWT Dependency
# ============================================================
async def get_current_user(request: Request) -> dict:
    """Extract and verify Supabase JWT (ES256 via JWKS)"""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization header")

    token = auth_header.split(" ", 1)[1]
    settings = get_settings()

    try:
        # JWTヘッダからアルゴリズムを判定
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "HS256")

        if alg == "ES256":
            # 新しいSupabase: ES256 (ECDSA) → JWKSから公開鍵を取得
            jwks_client = _get_jwks_client()
            signing_key = jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256"],
                audience="authenticated",
                leeway=30,  # 時計ずれ許容（秒）
            )
        else:
            # レガシーSupabase: HS256 (HMAC) → JWT Secretで検証
            payload = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
                leeway=30,
            )

        return {"user_id": payload["sub"], "jwt": token}
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


# ============================================================
# Profile
# ============================================================
@router.get("/me", response_model=UserProfile)
async def get_profile(user=Depends(get_current_user)):
    sb = get_supabase_admin()
    result = sb.table("profiles").select("*").eq("id", user["user_id"]).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Profile not found")
    return result.data


# ============================================================
# Account Management
# ============================================================
@router.get("/accounts", response_model=list[AccountResponse])
async def list_accounts(user=Depends(get_current_user)):
    sb = get_supabase_admin()
    result = sb.table("accounts").select("*").eq("user_id", user["user_id"]).order("created_at").execute()
    return result.data


@router.post("/accounts", response_model=AccountResponse)
async def create_account(body: AccountCreate, user=Depends(get_current_user)):
    sb = get_supabase_admin()

    # Check plan limits
    profile = sb.table("profiles").select("max_casts").eq("id", user["user_id"]).single().execute()
    existing = sb.table("accounts").select("id", count="exact").eq("user_id", user["user_id"]).execute()

    if existing.count >= profile.data["max_casts"]:
        raise HTTPException(status_code=403, detail=f"Plan limit: max {profile.data['max_casts']} casts")

    data = {
        "user_id": user["user_id"],
        "account_name": body.account_name,
    }
    if body.stripchat_cookie:
        # TODO: encrypt cookie before storing
        data["stripchat_cookie_encrypted"] = body.stripchat_cookie

    result = sb.table("accounts").insert(data).execute()
    return result.data[0]


@router.get("/accounts/{account_id}/settings")
async def get_account_settings(account_id: str, user=Depends(get_current_user)):
    """アカウントのキャスト除外・コイン換算設定を取得"""
    sb = get_supabase_admin()

    account = (sb.table("accounts")
               .select("id, account_name, cast_usernames, coin_rate")
               .eq("id", account_id)
               .eq("user_id", user["user_id"])
               .single().execute())
    if not account.data:
        raise HTTPException(status_code=404, detail="Account not found")

    return account.data


@router.put("/accounts/{account_id}/settings")
async def update_account_settings(
    account_id: str,
    body: AccountSettingsUpdate,
    user=Depends(get_current_user)
):
    """アカウントのキャスト除外・コイン換算設定を更新"""
    sb = get_supabase_admin()

    # Verify ownership
    account = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user["user_id"]).single().execute()
    if not account.data:
        raise HTTPException(status_code=404, detail="Account not found")

    update_data = {}
    if body.cast_usernames is not None:
        update_data["cast_usernames"] = body.cast_usernames
    if body.coin_rate is not None:
        if body.coin_rate <= 0:
            raise HTTPException(status_code=400, detail="coin_rateは正の数である必要があります")
        update_data["coin_rate"] = body.coin_rate

    if not update_data:
        raise HTTPException(status_code=400, detail="更新データがありません")

    result = sb.table("accounts").update(update_data).eq("id", account_id).execute()
    return result.data[0]


@router.delete("/accounts/{account_id}")
async def delete_account(account_id: str, user=Depends(get_current_user)):
    sb = get_supabase_admin()

    # Verify ownership
    account = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user["user_id"]).single().execute()
    if not account.data:
        raise HTTPException(status_code=404, detail="Account not found")

    sb.table("accounts").delete().eq("id", account_id).execute()
    return {"deleted": True}
