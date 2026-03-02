#!/usr/bin/env python3
"""Add mapChatLog imports to bracket-path files."""

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

fix_file(
    f'{BASE}/casts/[castName]/page.tsx',
    [
        (
            "import type { RegisteredCast, SpyMessage, UserSegment } from '@/types';",
            "import type { RegisteredCast, SpyMessage, UserSegment } from '@/types';\nimport { mapChatLog } from '@/lib/table-mappers';",
            "Add mapChatLog import"
        ),
    ],
    'casts/[castName]/page.tsx'
)

fix_file(
    f'{BASE}/spy/[castName]/page.tsx',
    [
        (
            "import type { SpyCast, SpyMessage } from '@/types';",
            "import type { SpyCast, SpyMessage } from '@/types';\nimport { mapChatLog } from '@/lib/table-mappers';",
            "Add mapChatLog import"
        ),
    ],
    'spy/[castName]/page.tsx'
)

print("=== DONE ===")
