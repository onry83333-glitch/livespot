#!/usr/bin/env python3
"""Add mapChatLog imports and apply mappers to select('*') queries in bracket-path files."""

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

# ============================================================
# 1. casts/[castName]/page.tsx — add import + mapper on session logs
# ============================================================
fix_file(
    f'{BASE}/casts/[castName]/page.tsx',
    [
        # Add import - find an existing import line to add after
        (
            "import type { SpyMessage } from '@/types';",
            "import type { SpyMessage } from '@/types';\nimport { mapChatLog } from '@/lib/table-mappers';",
            "Add mapChatLog import"
        ),
        # Session expand: apply mapChatLog
        (
            """    setSessionLogs((data || []) as SpyMessage[]);""",
            """    setSessionLogs((data || []).map(mapChatLog) as SpyMessage[]);""",
            "Apply mapChatLog to session logs"
        ),
    ],
    'casts/[castName]/page.tsx'
)

# ============================================================
# 2. spy/[castName]/page.tsx — add import + mapper on recent messages
# ============================================================
fix_file(
    f'{BASE}/spy/[castName]/page.tsx',
    [
        # Add import - find an existing import line
        (
            "import type { SpyMessage } from '@/types';",
            "import type { SpyMessage } from '@/types';\nimport { mapChatLog } from '@/lib/table-mappers';",
            "Add mapChatLog import"
        ),
        # Recent messages: apply mapChatLog
        (
            """        if (data) setRecentMessages(data.reverse() as SpyMessage[]);""",
            """        if (data) setRecentMessages(data.map(mapChatLog).reverse() as SpyMessage[]);""",
            "Apply mapChatLog to recent messages"
        ),
    ],
    'spy/[castName]/page.tsx'
)

# ============================================================
# 3. spy/users/[username]/page.tsx — no need for import, inline mapping done
# ============================================================
# Already handled inline in the previous script

# ============================================================
# 4. casts/[castName]/sessions/page.tsx — no import needed
# The session fallback query doesn't return SpyMessage, it returns custom fields
# that are manually destructured. No need for mapChatLog.
# ============================================================

print("=== DONE ===")
