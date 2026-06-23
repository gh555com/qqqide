import os, re
from datetime import datetime, timezone

log_dir = r'e:\s\wol\py\qqq-shell-v2\new_log'
logs = sorted([f for f in os.listdir(log_dir) if f.startswith('agent-') and f.endswith('.log')])

entries = []
for fname in logs:
    fpath = os.path.join(log_dir, fname)
    with open(fpath, encoding='utf-8', errors='replace') as f:
        for line in f:
            ts = line[:24].strip()
            if not ts.startswith('2026'):
                continue
            try:
                dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            except:
                continue

            tag = ''
            floor_house = ''
            tokens_info = ''

            if '📊 api' in line:
                tag = 'API_OK'
                # Extract floor/house
                m = re.search(r'\(floor\s+(\d+),\s+house\s+(\d+)\)', line)
                if m:
                    floor_house = f'F{m.group(1)}H{m.group(2)}'
                # Extract tokens
                mt = re.search(r'completion=(\d+)', line)
                if mt:
                    tokens_info = f'tok={mt.group(1)}'
            elif 'ABORT' in line:
                tag = 'ABORT'
                m = re.search(r'floor=(\d+)\s+house=(\d+)', line)
                if m:
                    floor_house = f'F{m.group(1)}H{m.group(2)}'
            elif '✗' in line or 'error' in line.lower():
                tag = 'ERROR'

            entries.append((dt, tag, floor_house, tokens_info, line.strip()[:200]))

print(f'Total: {len(entries)} entries')
print()

# Strategy: find consecutive API_OK entries for the same floor,
# calculate the gap between them. The gap = time from previous API_OK to this API_OK
# This represents how long this floor+house took.

# But more precisely, for a floor's houses: the time the AI spent on house N
# is the gap between the API_OK for house N-1 and API_OK for house N.
# Exception: house 1 of a floor - the gap from previous floor's last house.

# Let's just focus on consecutive 📊 entries and see the max gap where
# there's NO ABORT/ERROR between them.

gaps = []
for i in range(1, len(entries)):
    prev_dt, prev_tag, prev_fh, prev_tok, prev_line = entries[i-1]
    curr_dt, curr_tag, curr_fh, curr_tok, curr_line = entries[i]

    gap_sec = (curr_dt - prev_dt).total_seconds()

    # We want API_OK → API_OK with nothing bad in between
    if prev_tag == 'API_OK' and curr_tag == 'API_OK':
        # Check if there's an ABORT/ERROR entry between them (but we're sequential, so just check curr)
        # Actually, since we're checking consecutive entries, there's nothing between them.
        # But what if there are non-timestamped entries? Our entries list is ALL entries.
        gaps.append((gap_sec, prev_dt, curr_dt, prev_fh, curr_fh, prev_tok, curr_tok, prev_line[:150]))

gaps.sort(key=lambda x: x[0], reverse=True)

print(f'Total API_OK→API_OK consecutive pairs: {len(gaps)}')
print()
print('=' * 110)
print(f'{"Rank":>4}  {"Gap":>10}  {"Prev Time (UTC)":>22}  {"Curr Time (UTC)":>22}  {"Prev FH":>10}  {"Curr FH":>10}  {"Prev Tok":>8}  {"Curr Tok":>8}')
print('=' * 110)

for rank, g in enumerate(gaps[:60], 1):
    gap_sec, prev_dt, curr_dt, prev_fh, curr_fh, prev_tok, curr_tok, prev_line = g
    m = int(gap_sec // 60)
    s = int(gap_sec % 60)
    gap_str = f'{m}m{s:02d}s'
    print(f'{rank:>4}  {gap_str:>10}  {str(prev_dt):>22}  {str(curr_dt):>22}  {prev_fh:>10}  {curr_fh:>10}  {prev_tok:>8}  {curr_tok:>8}')

print()
print('=' * 110)
print('TOP 20 details (with surrounding context to check for ABORT/ERROR):')
print('=' * 110)

for rank, g in enumerate(gaps[:20], 1):
    gap_sec, prev_dt, curr_dt, prev_fh, curr_fh, prev_tok, curr_tok, prev_line = g
    m = int(gap_sec // 60)
    s = int(gap_sec % 60)
    gap_str = f'{m}m{s:02d}s'

    # Check if there were any ABORT/ERROR entries between prev_dt and curr_dt
    between = [e for e in entries if prev_dt < e[0] < curr_dt and e[1] in ('ABORT', 'ERROR')]

    marker = 'CLEAN' if not between else f'HAS {len(between)} ABORT/ERROR'
    print(f'\n#{rank}  {gap_str}  {prev_fh}→{curr_fh}  [{marker}]')
    print(f'  Prev: {str(prev_dt)}  {prev_tok}  {prev_line[:120]}')
    print(f'  Curr: {str(curr_dt)}  {curr_tok}')
    if between:
        for be in between[:5]:
            print(f'    ⚠ {be[0]} {be[1]} {be[2]} {be[4][:120]}')
