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
            if not ts.startswith('2026'):
                continue
            try:
                dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            except:
                continue
            if 'ABORT' in line:
                m = re.search(r'floor=(\d+)\s+house=(\d+)', line)
                if m:
                    entries.append((dt, int(m.group(1)), int(m.group(2)), 'ABORT'))
            elif 'api total_tokens=' in line:
                m = re.search(r'\(floor\s+(\d+),\s+house\s+(\d+)\)', line)
                if not m:
                    continue
                mt = re.search(r'completion=(\d+)', line)
                tok = int(mt.group(1)) if mt else 0
                entries.append((dt, int(m.group(1)), int(m.group(2)), 'API'))

print(f'Total: {len(entries)} entries')

floor_entries = defaultdict(list)
for e in entries:
    floor_entries[e[1]].append(e)

all_gaps = []
for floor, fe in floor_entries.items():
    api_list = [(e[0], e[2], e[3]) for e in fe]
    for i in range(1, len(api_list)):
        prev = api_list[i-1]
        curr = api_list[i]
        if prev[2] != 'API' or curr[2] != 'API':
            continue
        gap = (curr[0] - prev[0]).total_seconds()
        # Only sequential houses (Hn -> Hn+1, not Hn -> H1 floor restart)
        if curr[1] != prev[1] + 1 and not (prev[1] == 0 and curr[1] == 1):
            continue
        curr_aborted = any(e[3] == 'ABORT' and e[2] == curr[1] for e in fe)
        aborts_between = sum(1 for e in fe if prev[0] < e[0] < curr[0] and e[3] == 'ABORT')
        all_gaps.append((gap, prev[0], curr[0], floor, prev[1], curr[1], curr_aborted, aborts_between))

all_gaps.sort(key=lambda x: x[0], reverse=True)

print(f'Same-floor API->API gaps: {len(all_gaps)}')
print()

for rank, g in enumerate(all_gaps[:30], 1):
    gap, pdt, cdt, floor, ph, ch, caborted, aborts_bw = g
    day = pdt.strftime('%m-%d')
    m = int(gap // 60)
    s = int(gap % 60)
    clean = 'CLEAN' if not caborted and aborts_bw == 0 else 'DIRTY'
    print(f'{rank:>3} {m}m{s:02d}s {day} F{floor} H{ph}->H{ch} [{clean}] ab={aborts_bw}')

print()
print('=== Per-day max CLEAN gap ===')
clean = [g for g in all_gaps if not g[6] and g[7] == 0]
day_max = {}
for g in clean:
    day = g[1].strftime('%m-%d')
    if day not in day_max or g[0] > day_max[day][0]:
        day_max[day] = g
for day in sorted(day_max):
    g = day_max[day]
    m = int(g[0] // 60)
    s = int(g[0] % 60)
    print(f'  {day}: max={m}m{s:02d}s F{g[3]} H{g[4]}->H{g[5]}')
