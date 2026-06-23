#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os, json, sys

out = open(r'E:\s\wol\py\qqq-shell-v2\tmp\q5_result.txt', 'w', encoding='utf-8')

q5_root = r"E:\s\wol\py\qqq-shell-v2\qqq\quests"

for entry in os.scandir(q5_root):
    if b'q5.' in entry.name.encode('utf-8'):
        out.write(f'q5 dir name len={len(entry.name)} name_end={repr(entry.name[-50:])}\n')
        # List contents of q5 dir
        out.write('q5 dir contents:\n')
        for sub in os.scandir(entry.path):
            out.write(f'  {repr(sub.name)} is_dir={sub.is_dir()}\n')
            if sub.is_dir() and sub.name.startswith('f'):
                aj = os.path.join(sub.path, 'all.json')
                if os.path.isfile(aj):
                    with open(aj, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    q = data.get('question', '')
                    out.write(f'  question len={len(q)} tok~{len(q)//3}\n')
                    out.write(f'  first100={repr(q[:100])}\n')
                    if '[File:' in q:
                        idx = q.index('[File:')
                        out.write(f'  first [File: at {idx}, before={repr(q[:idx])}\n')
                    conv = data.get('conversation', [])
                    out.write(f'  conv msgs: {len(conv)}\n')
                    for i, m in enumerate(conv):
                        role = m.get('role', '?')
                        isp = m.get('_persistent', False)
                        c = m.get('content', '') or ''
                        clen = len(c)
                        toks = clen//3
                        out.write(f'    [{i}] role={role} persistent={isp} chars={clen} tok~{toks} first80={repr(c[:80])}\n')

out.close()
print('done')
