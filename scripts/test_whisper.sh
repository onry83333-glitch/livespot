#!/bin/bash
# ============================================================
# Whisper API テスト（ローカル Next.js 経由）
#
# 使い方:
#   ./scripts/test_whisper.sh test_audio.mp3
#   ./scripts/test_whisper.sh recording.m4a session-uuid-here
#
# 前提:
#   - frontend が localhost:3000 で起動中
#   - .env.local に OPENAI_API_KEY が設定済み
# ============================================================

if [ -z "$1" ]; then
  echo "Usage: ./scripts/test_whisper.sh <audio_file> [session_id]"
  echo ""
  echo "Supported formats: mp3, m4a, wav, webm, mp4"
  echo "Max size: 25MB"
  exit 1
fi

AUDIO_FILE="$1"
SESSION_ID="${2:-test-session-$(date +%s)}"
CAST_NAME="${CAST_NAME:-Risa_06}"
ACCOUNT_ID="${ACCOUNT_ID:-940e7248-1d73-4259-a538-56fdaea9d740}"
BASE_URL="${BASE_URL:-http://localhost:3000}"

if [ ! -f "$AUDIO_FILE" ]; then
  echo "Error: File not found: $AUDIO_FILE"
  exit 1
fi

FILE_SIZE=$(stat -f%z "$AUDIO_FILE" 2>/dev/null || stat --printf="%s" "$AUDIO_FILE" 2>/dev/null)
FILE_SIZE_MB=$(echo "scale=1; $FILE_SIZE / 1048576" | bc)

echo "=== Whisper API Test ==="
echo "File:       $AUDIO_FILE ($FILE_SIZE_MB MB)"
echo "Session:    $SESSION_ID"
echo "Cast:       $CAST_NAME"
echo "Account:    $ACCOUNT_ID"
echo "URL:        $BASE_URL/api/transcribe"
echo "========================"
echo ""

curl -X POST "$BASE_URL/api/transcribe" \
  -F "audio=@$AUDIO_FILE" \
  -F "session_id=$SESSION_ID" \
  -F "cast_name=$CAST_NAME" \
  -F "account_id=$ACCOUNT_ID" \
  --progress-bar \
  | jq .

echo ""
echo "Done."
