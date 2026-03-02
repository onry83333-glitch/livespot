#!/usr/bin/env python3
"""Fix type errors in bracket-path files after table migration."""

def fix_file(filepath, replacements, label):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    changes = 0
    for old, new, desc in replacements:
        if old in content:
            content = content.replace(old, new)
            changes += 1
            print(f"  OK: [{label}] {desc}")
        else:
            print(f"  MISS: [{label}] {desc}")
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  Total changes: {changes}\n")

BASE = r'C:/dev/livespot/frontend/src/app'

# spy/[castName]/page.tsx line 165 — r.user_name doesn't exist, only r.username
fix_file(
    f'{BASE}/spy/[castName]/page.tsx',
    [
        (
            """          data.forEach(r => {
            const uname = r.username ?? r.user_name;
            if (uname) tipMap.set(uname, (tipMap.get(uname) || 0) + (r.tokens || 0));
          });""",
            """          data.forEach(r => {
            if (r.username) tipMap.set(r.username, (tipMap.get(r.username) || 0) + (r.tokens || 0));
          });""",
            "Fix user_name property error in top tippers"
        ),
        # Also fix session aggregate: m.username ?? m.user_name
        (
            """        const uname = m.username ?? m.user_name;
        if (uname) agg.unique_users.add(uname);""",
            """        if (m.username) agg.unique_users.add(m.username);""",
            "Fix user_name property error in session aggregate"
        ),
    ],
    'spy/[castName]/page.tsx'
)

print("=== DONE ===")
