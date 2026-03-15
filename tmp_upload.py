import json, urllib.request, urllib.error, sys

SUPABASE_URL = "https://ujgbhkllfeacbgpdbjto.supabase.co"
SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZ2Joa2xsZmVhY2JncGRianRvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk2NDk3NywiZXhwIjoyMDg2NTQwOTc3fQ.IxlG4X6zHi9h4pgh6vFpQKaJGKwQzLBL-2C4af90MZQ"

def upload(text_file, source_file, period_start):
    with open(text_file, "r", encoding="utf-8") as f:
        text = f.read()

    data = {
        "cast_id": 2,
        "account_id": "940e7248-1d73-4259-a538-56fdaea9d740",
        "report_type": "post_session",
        "knowledge_type": "marketer_persona_source",
        "period_start": period_start,
        "metrics_json": {
            "source_file": source_file,
            "author": "安藤",
            "category": "monthly",
            "char_count": len(text)
        },
        "insights_json": {
            "content": text,
            "source_file": source_file,
            "author": "安藤",
            "category": "monthly"
        }
    }

    url = f"{SUPABASE_URL}/rest/v1/cast_knowledge"
    headers = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"{source_file}: Status {resp.status}, chars={len(text)}")
    except urllib.error.HTTPError as e:
        print(f"{source_file}: Error {e.code} {e.read().decode()}")

if __name__ == "__main__":
    upload(sys.argv[1], sys.argv[2], sys.argv[3])
