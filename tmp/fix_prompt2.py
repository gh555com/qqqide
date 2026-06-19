# -*- coding: utf-8 -*-
import sys

with open(r'e:\s\wol\py\qqq-shell-v2\server-app\ai-panel\system-prompt.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Debug
lines = content.split('\n')
for i, line in enumerate(lines):
    if line.startswith('CAPABILITIES:'):
        print(f'Line {i+1}: len={len(line)} has_5ge={"5 ge/search" in line}')
        break

# Replace the fetch_webpage/search_web portion
old = 'fetch_webpage (use after search_web to extract full data from result URLs), get_diagnostics, search_web (returns title+URL+snippet only \u2014 must follow with fetch_webpage to get actual data, 5 ge/search)'
new = 'fetch_webpage (extracts plain text from HTML \u2014 use for docs/articles/news; NOT for APIs/structured data), get_diagnostics, search_web (returns title+URL+snippet \u2014 use ONLY to discover candidate URLs, NOT to consume data; \u22642 parallel calls then stop)'

if old in content:
    content = content.replace(old, new, 1)
    print('cap replaced')
else:
    print('cap NOT FOUND - trying substring match')
    # Try with regular dash
    old_dash = old.replace('\u2014', '-')
    if old_dash in content:
        content = content.replace(old_dash, new.replace('\u2014', '-'), 1)
        print('cap replaced (dash variant)')
    else:
        idx = content.find('5 ge/search')
        if idx >= 0:
            snippet = content[max(0,idx-100):idx+50]
            print(f'Found 5 ge/search at {idx}: {repr(snippet[:80])}')
        else:
            print('5 ge/search not found - file unchanged from previous?')

# Insert strategy block
strategy = '''
🔍 WEB SEARCH STRATEGY — universal two-phase decision tree (applies to ALL search/browse tasks):

Phase 1 · DISCOVER (≤2 parallel search_web calls):
  search_web returns title + URL + snippet — this is ONLY for finding candidate URLs, never for consuming data.
  After ≤2 search_web calls: STOP searching. Move to Phase 2.

Phase 2 · EXTRACT (choose tool based on WHAT you are trying to get):
  • STRUCTURED DATA — stock prices, rankings, weather, tables, lists, JSON, APIs, any query with "top 10 / 涨幅 / 排行 / price / 天气 / 排名":
    → run_command with curl hitting direct API endpoints
    → NEVER fetch_webpage for these — HTML scraping is wasteful, APIs are clean
    → Known API patterns: push2.eastmoney.com (A股), query1.finance.yahoo.com (global stocks), api.github.com, wttr.in (weather)
  • TEXT CONTENT — articles, documentation, blog posts, reference pages, news stories:
    → fetch_webpage — extracts plain text from HTML (8000 chars max)
  • UNKNOWN / mixed target:
    → Try fetch_webpage first. If result is garbled / empty / JS-shell → immediately PIVOT to run_command + curl.
    → Example: a stock page fetched with fetch_webpage returns garbled → curl the underlying JSON API instead

🔴 FAILURE RULES — do NOT loop:
  • fetch_webpage returns garbled/empty → next call MUST be run_command (do not retry fetch_webpage)
  • 2 consecutive failures on same URL → abandon it, try next search result or new short search
  • 3 search_web calls without actionable data → STOP, summarize what is missing, ask user
  • NEVER search_web with a minutely rephrased version of the same query → PIVOT to different approach'''

# Find insertion point - just before READ_FILE RULE
anchor = '🔴 READ_FILE RULE:'
idx = content.find(anchor)
if idx >= 0:
    # Insert before the \n that precedes READ_FILE RULE
    insert_pos = content.rfind('\n', 0, idx)
    content = content[:insert_pos] + strategy + content[insert_pos:]
    print('strategy inserted')
else:
    print('anchor not found')
    # Try without emoji
    anchor2 = 'READ_FILE RULE:'
    idx2 = content.find(anchor2)
    if idx2 >= 0:
        insert_pos = content.rfind('\n', 0, idx2)
        content = content[:insert_pos] + strategy + content[insert_pos:]
        print('strategy inserted (partial anchor)')

with open(r'e:\s\wol\py\qqq-shell-v2\server-app\ai-panel\system-prompt.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('done')
