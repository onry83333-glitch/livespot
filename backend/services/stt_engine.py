"""Speech-to-Text engine using faster-whisper (OpenAI Whisper optimized for CPU)

Morning Hook CRM audio_server.py の transcribe_chunk() と同パターン。
スレッドセーフなモデルキャッシュ + VADフィルタによる無音スキップ。
"""
import math
import threading
from typing import Optional

_model = None
_model_lock = threading.Lock()

# Configuration (Morning Hook CRM 実証済み設定)
MODEL_SIZE = "base"       # 74MB — 速度/精度のバランス
DEVICE = "cpu"            # 開発環境はCPU
COMPUTE_TYPE = "int8"     # 最速のCPU推論
LANGUAGE = "ja"           # 日本語
VAD_FILTER = True         # 無音チャンクを自動スキップ


def _get_model():
    """Whisperモデルのlazy loading（スレッドセーフ）"""
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        from faster_whisper import WhisperModel
        print(f"[STT] Loading faster-whisper model: {MODEL_SIZE} ({DEVICE}, {COMPUTE_TYPE})")
        _model = WhisperModel(
            MODEL_SIZE,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
        )
        print("[STT] Model loaded successfully")
        return _model


def is_model_loaded() -> bool:
    """モデルがメモリにロード済みかどうか"""
    return _model is not None


def transcribe_chunk(audio_path: str) -> Optional[dict]:
    """音声チャンクファイルを文字起こし

    Args:
        audio_path: WebMファイルのパス

    Returns:
        dict: { text, confidence, language } or None (無音/エラー時)
    """
    model = _get_model()

    try:
        segments, info = model.transcribe(
            audio_path,
            language=LANGUAGE,
            vad_filter=VAD_FILTER,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
            ),
            beam_size=5,
            best_of=5,
        )

        full_text = ""
        total_log_prob = 0.0
        seg_count = 0

        for segment in segments:
            text = segment.text.strip()
            if text:
                full_text += text
                # faster-whisper v1.2+: avg_logprob (no underscore)
                log_prob = getattr(segment, 'avg_logprob', None)
                if log_prob is None:
                    log_prob = getattr(segment, 'avg_log_prob', -1.0)
                total_log_prob += log_prob
                seg_count += 1

        if not full_text:
            return None

        # log_prob → 0-1 confidence (近似)
        avg_log_prob = total_log_prob / seg_count if seg_count > 0 else -1.0
        confidence = round(math.exp(avg_log_prob), 3) if avg_log_prob > -10 else 0.0

        return {
            "text": full_text,
            "confidence": confidence,
            "language": info.language,
        }

    except Exception as e:
        print(f"[STT] Transcription error: {e}")
        return None
