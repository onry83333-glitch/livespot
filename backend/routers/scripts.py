"""Scripts router - Broadcast script management"""
from fastapi import APIRouter, Depends, HTTPException
from config import get_supabase_admin
from routers.auth import get_current_user
from models.schemas import ScriptCreate

router = APIRouter()


def _verify_account(sb, account_id: str, user_id: str):
    result = sb.table("accounts").select("id").eq("id", account_id).eq("user_id", user_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Account not found")


@router.get("/")
async def list_scripts(account_id: str, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    _verify_account(sb, account_id, user["user_id"])
    result = (sb.table("broadcast_scripts")
              .select("*")
              .eq("account_id", account_id)
              .order("created_at", desc=True)
              .execute())
    return result.data


@router.post("/")
async def create_script(body: ScriptCreate, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])
    result = sb.table("broadcast_scripts").insert({
        "account_id": body.account_id,
        "cast_name": body.cast_name,
        "title": body.title,
        "duration_minutes": body.duration_minutes,
        "steps": body.steps,
        "vip_rules": body.vip_rules,
        "notes": body.notes,
        "is_default": body.is_default,
    }).execute()
    return result.data[0]


@router.put("/{script_id}")
async def update_script(script_id: str, body: ScriptCreate, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    _verify_account(sb, body.account_id, user["user_id"])
    result = sb.table("broadcast_scripts").update({
        "title": body.title,
        "cast_name": body.cast_name,
        "duration_minutes": body.duration_minutes,
        "steps": body.steps,
        "vip_rules": body.vip_rules,
        "notes": body.notes,
        "is_default": body.is_default,
    }).eq("id", script_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Script not found")
    return result.data[0]


@router.delete("/{script_id}")
async def delete_script(script_id: str, user=Depends(get_current_user)):
    sb = get_supabase_admin()
    # 所有権チェック: スクリプトのaccount_idがユーザーのものか確認
    script = sb.table("broadcast_scripts").select("account_id").eq("id", script_id).single().execute()
    if not script.data:
        raise HTTPException(status_code=404, detail="Script not found")
    _verify_account(sb, script.data["account_id"], user["user_id"])
    sb.table("broadcast_scripts").delete().eq("id", script_id).execute()
    return {"deleted": True}
