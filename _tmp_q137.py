import os, json

quests_dir = r'e:\s\wol\py\qqq-shell-v2\qqq\quests'
for d in os.listdir(quests_dir):
    if d.startswith('q137'):
        qdir = os.path.join(quests_dir, d)
        break

floors = sorted([f for f in os.listdir(qdir) if f.startswith('f')], key=lambda x: int(x[1:].split('.')[0]) if x[1:].split('.')[0].isdigit() else 0)
print('Available floors:')
for fl in floors:
    fpath = os.path.join(qdir, fl, 'all.json')
    if os.path.exists(fpath):
        sz = os.path.getsize(fpath)
        print(f'  {fl} -> all.json ({sz} bytes)')

# Read f10
for fl in ['f10', 'f11', 'f14']:
    for fdir in floors:
        if fdir.startswith(fl):
            fpath = os.path.join(qdir, fdir, 'all.json')
            if os.path.exists(fpath):
                with open(fpath, 'r', encoding='utf-8') as fp:
                    data = json.load(fp)
                print(f'\n=== {fl} ===')
                print(f'  question: {(data.get("question","") or "")[:100]}')
                print(f'  _streaming: {data.get("_streaming")}')
                print(f'  house_count: {data.get("house_count")}')
                print(f'  floorFatal: {data.get("floorFatal")}')
                print(f'  exitReason: {data.get("exitReason", "")}')
                conv = data.get('conversation', [])
                print(f'  conv msgs: {len(conv)}')
                for i, m in enumerate(conv):
                    c = m.get('content', '') or ''
                    tc = m.get('tool_calls')
                    print(f'    msg[{i}]: role={m.get("role")}, content_len={len(c)}, tool_calls={len(tc) if tc else 0}, _error={m.get("_error")}')
                    if m.get('_error'):
                        print(f'      ERROR: {c[:200]}')
                houses = data.get('houses', [])
                print(f'  houses: {len(houses)}')
                for i, h in enumerate(houses):
                    print(f'    house[{i}]: type={h.get("type")}, toolCount={h.get("toolCount")}, content_len={len(h.get("content","") or "")}')
                # Check ai_html
                ai_html = data.get('ai_html', '')
                if '⚠' in ai_html or '中断' in ai_html or '继续' in ai_html or '重新发送' in ai_html:
                    print(f'  ai_html has error/recovery markers')
