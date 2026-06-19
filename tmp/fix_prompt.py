import sys

# Read system-prompt.js
with open(r'e:\s\wol\py\qqq-shell-v2\server-app\ai-panel\system-prompt.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Debug: find CAPABILITIES line
lines = content.split('\n')
for i, line in enumerate(lines):
    if line.startswith('CAPABILITIES:'):
        # Check for em dash U+2014
        has_emdash = '\u2014' in line
        has_en = '\u2013' in line
        print(f'Line {i+1}: em-dash={has_emdash} en-dash={has_en} len={len(line)}')
        # Print hex of first 100 chars to debug
        print(f'  first 10 chars hex: {line[:20].encode("utf-8").hex()}')
        break

# Find the exact text to replace using the unique "5 ge/search" anchor
old = 'fetch_webpage (use after search_web to extract full data from result URLs), get_diagnostics, search_web (returns title+URL+snippet only \u2014 must follow with fetch_webpage to get actual data, 5 ge/search)'
new = 'fetch_webpage (extracts plain text from HTML \u2014 use for docs/articles/news; NOT for APIs/structured data), get_diagnostics, search_web (returns title+URL+snippet \u2014 use ONLY to discover candidate URLs, NOT to consume data; \u22642 parallel calls then stop)'

if old in content:
    content = content.replace(old, new, 1)
    print('cap part replaced')
else:
    print('cap part NOT FOUND')
    print('searching for substring...')
    if '5 ge/search' in content:
        print('5 ge/search found')
    else:
        print('5 ge/search NOT FOUND - file was not modified by previous edit?')
    # Try without emdash
    old2 = old.replace('\u2014', '-')
    if old2 in content:
        print('found with regular dash instead of emdash')
        content = content.replace(old2, new.replace('\u2014', '-'), 1)
        print('replaced with dash variant')
    else:
        # Try finding the text around "5 ge/search"
        idx = content.find('5 ge/search')
        if idx >= 0:
            before = content[max(0,idx-200):idx+50]
            print(f'context around 5 ge/search: {repr(before)}')

# Insert strategy block before READ_FILE RULE
strategy = '''

\u{1f50d} WEB SEARCH STRATEGY \u2014 universal two-phase decision tree (applies to ALL search/browse tasks):

Phase 1 \u00b7 DISCOVER (\u22642 parallel search_web calls):
  search_web returns title + URL + snippet \u2014 this is ONLY for finding candidate URLs, never for consuming data.
  After \u22642 search_web calls: STOP searching. Move to Phase 2.

Phase 2 \u00b7 EXTRACT (choose tool based on WHAT you are trying to get):
  \u2022 STRUCTURED DATA \u2014 stock prices, rankings, weather, tables, lists, JSON, APIs, any query with "top 10 / \u6da8\u5e45 / \u6392\u884c / price / \u5929\u6c14 / \u6392\u540d":
    \u2192 run_command with curl hitting direct API endpoints
    \u2192 NEVER fetch_webpage for these \u2014 HTML scraping is wasteful, APIs are clean
    \u2192 Known API patterns: push2.eastmoney.com (A\u80a1), query1.finance.yahoo.com (global stocks), api.github.com, wttr.in (weather)
  \u2022 TEXT CONTENT \u2014 articles, documentation, blog posts, reference pages, news stories:
    \u2192 fetch_webpage \u2014 extracts plain text from HTML (8000 chars max)
  \u2022 UNKNOWN / mixed target:
    \u2192 Try fetch_webpage first. If result is garbled / empty / JS-shell \u2192 immediately PIVOT to run_command + curl.
    \u2192 Example: a stock page fetched with fetch_webpage returns garbled \u2192 curl the underlying JSON API instead

\u{1f534} FAILURE RULES \u2014 do NOT loop:
  \u2022 fetch_webpage returns garbled/empty \u2192 next call MUST be run_command (do not retry fetch_webpage)
  \u2022 2 consecutive failures on same URL \u2192 abandon it, try next search result or new short search
  \u2022 3 search_web calls without actionable data \u2192 STOP, summarize what is missing, ask user
  \u2022 NEVER search_web with a minutely rephrased version of the same query \u2192 PIVOT to different approach'''

anchor = '\n\u{1f534} READ_FILE RULE:'
idx = content.find(anchor)
if idx >= 0:
    content = content[:idx] + strategy + content[idx:]
    print('strategy inserted')
else:
    print(f'READ_FILE anchor not found, searching for partial...')
    if 'READ_FILE RULE:' in content:
        idx = content.find('READ_FILE RULE:')
        content = content[:idx-2] + strategy + '\n' + content[idx-2:]
        print('strategy inserted with partial match')

with open(r'e:\s\wol\py\qqq-shell-v2\server-app\ai-panel\system-prompt.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('done')
