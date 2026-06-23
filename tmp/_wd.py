entries = [
    ('06-19', '13:22:47', 17, 6, 203833),
    ('06-20', '09:01:00', 1, 29, 187384),
    ('06-20', '12:00:02', 1, 30, 189186),
    ('06-20', '17:36:54', 1, 11, 721308),
    ('06-21', '05:50:07', 1, 10, 487096),
    ('06-21', '11:11:37', 11, 8, 519377),
    ('06-21', '11:32:39', 11, 14, 712970),
    ('06-21', '12:22:08', 11, 40, 191740),
    ('06-21', '13:09:24', 36, 7, 214766),
    ('06-21', '13:11:55', 18, 11, 218940),
    ('06-22', '02:11:12', 2, 53, 755083),
    ('06-22', '03:19:34', 3, 14, 836772),
    ('06-22', '03:38:10', 3, 6, 746268),
    ('06-22', '04:56:19', 4, 1, 757075),
    ('06-22', '05:26:56', 2, 20, 465224),
    ('06-22', '08:41:25', 4, 12, 830030),
    ('06-22', '09:39:23', 1, 1, 695880),
    ('06-22', '10:50:17', 1, 4, 427513),
    ('06-22', '11:08:39', 6, 4, 948534),
    ('06-22', '13:47:07', 7, 5, 598244),
    ('06-22', '14:42:06', 9, 1, 211839),
    ('06-22', '14:44:58', 1, 34, 858584),
    ('06-22', '15:09:48', 2, 4, 469924),
    ('06-22', '15:30:30', 1, 4, 470817),
]

total = len(entries)
quick = sum(1 for e in entries if e[4] < 230000)
slow = total - quick
by_day = {}
for e in entries:
    d = e[0]; by_day[d] = by_day.get(d, 0) + 1

print(f'Total: {total}')
print(f'  Quick dead (elapsed<230s, barely any data): {quick}')
print(f'  Slow dead  (elapsed>=230s, AI was generating then died): {slow}')
print()
print('By day:')
for d in sorted(by_day):
    print(f'  {d}: {by_day[d]}')
print()
print('ALL 24 on main line (direct.gh555.com:8444) — ZERO on fallback')
print()
print('=== Quick dead (data < 50s) ===')
for e in entries:
    if e[4] < 230000:
        dt = e[4] - 180000
        print(f'  {e[0]} {e[1]}  F{e[2]} H{e[3]}  elapsed={e[4]}ms  data={dt}ms({dt/1000:.0f}s)')
print()
print('=== Slow dead (AI flowing N minutes then died) ===')
for e in entries:
    if e[4] >= 230000:
        dt = e[4] - 180000
        print(f'  {e[0]} {e[1]}  F{e[2]} H{e[3]}  elapsed={e[4]}ms({e[4]/1000:.0f}s)  flowing={dt}ms({dt/60000:.1f}min)')
