#!/usr/bin/env python3
"""Fix property access in casts/[castName]/sessions/page.tsx after table migration."""

filepath = r'C:/dev/livespot/frontend/src/app/casts/[castName]/sessions/page.tsx'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

def do_replace(old, new, label):
    global content, changes
    if old in content:
        content = content.replace(old, new)
        changes += 1
        print(f"  OK: {label}")
    else:
        print(f"  MISS: {label}")

# The rawData loop accesses r.message_time and r.user_name which now are r.timestamp and r.username
do_replace(
    """      sessionMap.get(r.session_id)!.messages.push({ time: r.message_time, user_name: r.user_name, tokens: r.tokens || 0 });""",
    """      sessionMap.get(r.session_id)!.messages.push({ time: r.timestamp, user_name: r.username, tokens: r.tokens || 0 });""",
    "rawData property access"
)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nTotal changes: {changes}")
