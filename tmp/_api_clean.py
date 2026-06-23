import os, re
from datetime import datetime

log_dir = r'e:\s\wol\py\qqq-shell-v2\new_log'
logs = sorted([f for f in os.listdir(log_dir) if f.startswith('agent-') and f.endswith('.log')])

# Collect all entries: (dt, floor, house, tokens, 'API'|'ABORT')
entries = []
for fname in logs:
    fpath = os.path.join(log_dir, fname)
    with open(fpath, encoding='utf-8', errors='replace') as f:
        for line in f:
            ts = line[:24].strip()
            if not ts.startswith('2026'): continue
            try: dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            except: continue

            if 'ABORT' in line:
                m = re.search(r'floor=(\d+)\s+house=(\d+)', line)
                if m:
                    entries.append((dt, int(m.group(1)), int(m.group(2)), 0, 'ABORT'))
            elif '📊 api' in line:
                m = re.search(r'\(floor\s+(\d+),\s+house\s+(\d+)\)', line)
                if not m: continue
                floor = int(m.group(1))
                house = int(m.group(2))
                mt = re.search(r'completion=(\d+)', line)
                tok = int(mt.group(1)) if mt else 0
                entries.append((dt, floor, house, tok, 'API'))

print(f'Total: {len(entries)} entries ({sum(1 for e in entries if e[4]=="API")} API, {sum(1 for e in entries if e[4]=="ABORT")} ABORT)')

# Find gaps between consecutive API_OK entries WITHIN the same floor
# AND check that no ABORT for the same floor+house occurred between them

# Build an abort index: set of (floor, house) that were aborted
aborted = set()
for e in entries:
    if e[4] == 'ABORT':
        aborted.add((e[1], e[2]))

# Now find same-floor consecutive API→API gaps
same_floor_gaps = []
for i in range(1, len(entries)):
    prev = entries[i-1]
    curr = entries[i]

    if prev[4] != 'API' or curr[4] != 'API':
        continue
    if prev[1] != curr[1]:  # different floor
        continue

    gap_sec = (curr[0] - prev[0]).total_seconds()

    # Check if ANY entry between these two was an ABORT for this floor
    has_abort_between = False
    for j in range(i-1, i+1):
        if entries[j][4] == 'ABORT' and entries[j][1] == prev[1]:
            has_abort_between = True
            break

    # Also check the abort set
    curr_house_aborted = (curr[1], curr[2]) in aborted

    same_floor_gaps.append({
        'gap_sec': gap_sec,
        'prev_dt': prev[0],
        'curr_dt': curr[0],
        'floor': prev[1],
        'prev_h': prev[2],
        'curr_h': curr[2],
        'prev_tok': prev[3],
        'curr_tok': curr[3],
        'clean': not has_abort_between and not curr_house_aborted
    })

same_floor_gaps.sort(key=lambda x: x['gap_sec'], reverse=True)

print(f'Same-floor consecutive API→API pairs: {len(same_floor_gaps)}')
print(f'Clean (no abort): {sum(1 for g in same_floor_gaps if g["clean"])}')
print()

print(f'{"Rank":>4}  {"Gap":>10}  {"Floor":>6}  {"Houses":>12}  {"Prev Tok":>8}  {"Curr Tok":>8}  {"Clean?":>7}  {"Prev Time (UTC)":>22}')
print('=' * 115)

for rank, g in enumerate(same_floor_gaps[:50], 1):
    m = int(g['gap_sec'] // 60)
    s = int(g['gap_sec'] % 60)
    gap_str = f'{m}m{s:02d}s'
    clean = '✓' if g['clean'] else '✗'
    print(f'{rank:>4}  {gap_str:>10}  F{g["floor"]:>5}  H{g["prev_h"]:>3}→H{g["curr_h"]:<3}  {g["prev_tok"]:>8}  {g["curr_tok"]:>8}  {clean:>7}  {str(g["prev_dt"]):>22}')

# TOP clean ones only
print()
print('=' * 115)
print('TOP 20 CLEAN (no abort) same-floor consecutive API calls:')
print('=' * 115)
clean_sorted = sorted([g for g in same_floor_gaps if g['clean']], key=lambda x: x['gap_sec'], reverse=True)
for rank, g in enumerate(clean_sorted[:20], 1):
    m = int(g['gap_sec'] // 60)
    s = int(g['gap_sec'] % 60)
    gap_str = f'{m}m{s:02d}s'
    print(f'{rank:>4}  {gap_str:>10}  F{g["floor"]:>5}  H{g["prev_h"]:>3}→H{g["curr_h"]:<3}  tok={g["prev_tok"]}→{g["curr_tok"]}  {str(g["prev_dt"])}')
