"""Test get_session_list and get_session_summary RPCs"""
import requests
import json
import os
import sys

# Load from backend/.env
env_path = os.path.join(os.path.dirname(__file__), '..', 'backend', '.env')
env = {}
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k] = v

SUPABASE_URL = env.get('SUPABASE_URL', '')
SERVICE_KEY = env.get('SUPABASE_SERVICE_KEY', '')

headers = {
    'apikey': SERVICE_KEY,
    'Authorization': f'Bearer {SERVICE_KEY}',
    'Content-Type': 'application/json',
    'X-Client-Info': 'supabase-py/test',
}

# 1. Get account_id
r = requests.get(f'{SUPABASE_URL}/rest/v1/accounts?select=id,account_name&limit=1', headers=headers)
if not r.ok:
    print(f'ERROR getting accounts: {r.status_code} {r.text[:200]}')
    sys.exit(1)

acct = r.json()[0]
account_id = acct['id']
print(f'account_id: {account_id} ({acct["account_name"]})')

# 2. Test get_session_list
print('\n=== get_session_list(Risa_06, limit=5) ===')
r2 = requests.post(f'{SUPABASE_URL}/rest/v1/rpc/get_session_list', headers=headers, json={
    'p_account_id': account_id,
    'p_cast_name': 'Risa_06',
    'p_limit': 5,
    'p_offset': 0,
})
print(f'status: {r2.status_code}')
if r2.ok:
    data = r2.json()
    if isinstance(data, list):
        print(f'sessions returned: {len(data)}')
        for s in data:
            sid = str(s.get("session_id", ""))[:8]
            print(f'  {sid}... | started={s["started_at"]} | msgs={s["msg_count"]} users={s["unique_users"]} tk={s["total_tokens"]} tips={s["tip_count"]} active={s["is_active"]} total_count={s["total_count"]}')
    else:
        print(f'unexpected response: {json.dumps(data, indent=2)[:500]}')
else:
    print(f'ERROR: {r2.text[:500]}')

# 3. Test get_session_summary (use first session from list)
if r2.ok and isinstance(r2.json(), list) and len(r2.json()) > 0:
    first_sid = r2.json()[0]['session_id']
    print(f'\n=== get_session_summary({first_sid[:8]}...) ===')
    r3 = requests.post(f'{SUPABASE_URL}/rest/v1/rpc/get_session_summary', headers=headers, json={
        'p_account_id': account_id,
        'p_session_id': first_sid,
    })
    print(f'status: {r3.status_code}')
    if r3.ok:
        data3 = r3.json()
        if isinstance(data3, list) and len(data3) > 0:
            s = data3[0]
            print(f'  cast_name: {s.get("cast_name")}')
            print(f'  session_title: {s.get("session_title")}')
            print(f'  started_at: {s.get("started_at")}')
            print(f'  ended_at: {s.get("ended_at")}')
            print(f'  duration: {s.get("duration_minutes")} min')
            print(f'  msgs: {s.get("msg_count")} users: {s.get("unique_users")}')
            print(f'  total_tokens: {s.get("total_tokens")} tips: {s.get("tip_count")}')
            print(f'  tokens_by_type: {json.dumps(s.get("tokens_by_type", {}), ensure_ascii=False)}')
            top = s.get("top_users", [])
            if isinstance(top, str):
                top = json.loads(top)
            print(f'  top_users: {json.dumps(top, ensure_ascii=False)[:300]}')
            print(f'  prev_session_id: {str(s.get("prev_session_id", ""))[:8]}...')
            print(f'  prev_total_tokens: {s.get("prev_total_tokens")}')
            print(f'  change_pct: {s.get("change_pct")}')
        else:
            print(f'  empty or unexpected: {json.dumps(data3, indent=2)[:300]}')
    else:
        print(f'ERROR: {r3.text[:500]}')

print('\n✅ Test complete')
