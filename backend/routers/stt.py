"""STT router - Speech-to-Text transcription endpoint

Chrome拡張から受信した音声チャンク（base64 WebM/Opus）を
faster-whisperで文字起こしし、spy_messagesに保存する。
"""
import base64
import tempfile
import os
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from config import get_supabase_admin
from routers.auth import get_current_user

router = APIRouter()


class TranscribeRequest(BaseModel):
    account_id: str
    cast_name: str
    audio_base64: str           # base64 encoded WebM/Opus
    timestamp: str              # ISO 8601 capture timestamp
    chunk_duration: float = 5.0 # seconds


class TranscribeResponse(BaseModel):
    text: str
    confidence: float
    language: str
    duration: float
    inserted_id: Optional[int] = None


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(body: TranscribeRequest, user=Depends(get_current_user)):
    """音声チャンク受信 → faster-whisper文字起こし → spy_messages INSERT"""
    from services.stt_engine import transcribe_chunk

    # 1. base64デコード
    try:
        audio_bytes = base64.b64decode(body.audio_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 audio data")

    # 2. サイズガード: 500KB上限（5秒@64kbps = ~40KB）
    if len(audio_bytes) > 500_000:
        raise HTTPException(status_code=413, detail="Audio chunk too large (max 500KB)")

    # 3. 一時ファイルに書き出し（faster-whisperはファイルパスが必要）
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name

        # 4. faster-whisperで文字起こし
        result = transcribe_chunk(tmp_path)

        if not result or not result["text"].strip():
            # 無音 → DB挿入スキップ
            return TranscribeResponse(
                text="",
                confidence=0.0,
                language="ja",
                duration=body.chunk_duration,
                inserted_id=None,
            )

        # 5. spy_messages に msg_type='speech' で INSERT
        sb = get_supabase_admin()
        row = {
            "account_id": body.account_id,
            "cast_name": body.cast_name,
            "message_time": body.timestamp,
            "msg_type": "speech",
            "user_name": body.cast_name,  # speaker = cast
            "message": result["text"],
            "tokens": 0,
            "is_vip": False,
            "metadata": {
                "source": "stt",
                "confidence": result["confidence"],
                "language": result["language"],
                "duration": body.chunk_duration,
                "model": "whisper-base",
            },
        }

        insert_result = sb.table("spy_messages").insert(row).execute()
        inserted_id = insert_result.data[0]["id"] if insert_result.data else None

        return TranscribeResponse(
            text=result["text"],
            confidence=result["confidence"],
            language=result["language"],
            duration=body.chunk_duration,
            inserted_id=inserted_id,
        )

    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


@router.get("/status")
async def stt_status(user=Depends(get_current_user)):
    """STTエンジンの状態確認"""
    from services.stt_engine import is_model_loaded
    return {
        "ready": is_model_loaded(),
        "model": "whisper-base",
        "language": "ja",
    }
