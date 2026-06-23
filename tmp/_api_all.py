import os, re
from datetime import datetime
from collections import defaultdict

log_dir = r'e:\s\wol\py\qqq-shell-v2\new_log'
logs = sorted([f for f in os.listdir(log_dir) if f.startswith('agent-') and f.endswith('.log')])

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
                    entries.append((dt, int(m.group(1)), int(m.group(2)), 'ABORT', line.strip()[:200]))
            elif 'api total_tokens=' in line:
                m = re.search(r'\(floor\s+(\d+),\s+house\s+(\d+)\)', line)
                if not m: continue
                mt = re.search(r'completion=(\d+)', line)
                tok = int(mt.group(1)) if mt else 0
                entries.append((dt, int(m.group(1)), int(m.group(2)), 'API', line.strip()[:200]))

floor_entries = defaultdict(list)
for e in entries:
    floor_entries[e[1]].append(e)

all_gaps = []
for floor, fe in floor_entries.items():
    api_list = [(e[0], e[2], e[4], e[3]) for e in fe]  # dt, house, tag, tok
    for i in range(1, len(api_list)):
        prev = api_list[i-1]
        curr = api_list[i]
        if prev[2] != 'API' or curr[2] != 'API':
            continue
        gap = (curr[0] - prev[0]).total_seconds()
        curr_aborted = any(e[4]=='ABORT' and e[2]==curr[1] for e in fe)
        aborts_between = sum(1 for e in fe if prev[0] < e[0] < curr[0] and e[4]=='ABORT')
        all_gaps.append((gap, prev[0], curr[0], floor, prev[1], curr[1], prev[3], curr[3], curr_aborted, aborts_between))

all_gaps.sort(key=lambda x: x[0], reverse=True)

print(f'Total same-floor API->API gaps: {len(all_gaps)}')
print()
hdr = f'{"Rank":>4} {"Gap":>9} {"Day":>6} {"Floor":>6} {"Houses":>10} {"PrevTok":>8} {"CurrTok":>8} {"H_Abort?":>9} {"ABORTs_between":>14}'
print(hdr)
print('='*110)

for rank, g in enumerate(all_gaps[:50], 1):
    gap, pdt, cdt, floor, ph, ch, ptok, ctok, caborted, aborts_bw = g
    day = pdt.strftime('%m-%d')
    m = int(gap//60); s = int(gap%60)
    gs = f'{m}m{s:02d}s'
    print(f'{rank:>4} {gs:>9} {day:>6} F{floor:>5} H{ph:>3}->H{ch:<3} {ptok:>8} {ctok:>8} {"Y" if caborted else "N":>9} {aborts_bw:>14}')

# Now: show the truly clean ones by day distribution
print()
print('='*110)
print('TRULY CLEAN (H_Abort=N AND ABORTs_between=0) by DAY:')
print('='*110)
clean = [g for g in all_gaps if not g[8] and g[9] == 0]
from collections import Counter
day_counts = Counter()
for g in clean:
    day_counts[g[1].strftime('%m-%d')] += 1
for day in sorted(day_counts):
    top_in_day = max([g for g in clean if g[1].strftime('%m-%d') == day], key=lambda x: x[0])
    m = int(top_in_day[0]//60); s = int(top_in_day[0]%60)
    print(f'  {day}: {day_counts[day]} clean gaps, max={m}m{s:02d}s F{top_in_day[3]} H{top_in_day[4]}->H{top_in_day[5]}')
