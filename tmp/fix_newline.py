# -*- coding: utf-8 -*-
with open(r'e:\s\wol\py\qqq-shell-v2\server-app\ai-panel\system-prompt.js', 'r', encoding='utf-8') as f:
    content = f.read()

old = 'PIVOT to different approach\u{1f534} READ_FILE RULE:'
# Use actual character
old_real = 'PIVOT to different approach🔴 READ_FILE RULE:'
new_real = 'PIVOT to different approach\n\n🔴 READ_FILE RULE:'

if old_real in content:
    content = content.replace(old_real, new_real, 1)
    print('fixed')
else:
    print('not found')
    idx = content.find('PIVOT to different approach')
    if idx >= 0:
        print(f'found: {repr(content[idx:idx+50])}')

with open(r'e:\s\wol\py\qqq-shell-v2\server-app\ai-panel\system-prompt.js', 'w', encoding='utf-8') as f:
    f.write(content)
