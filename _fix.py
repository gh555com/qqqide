# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

import codecs
f=codecs.open('server-app/ai-panel/panel-quest-ui.js','r','utf-8')
s=f.read()
f.close()
old='text = text.replace(/
' + chr(0x2554) + 'K
[\s\S]*?\n' + chr(0x255a) + '(?=
|$)/g, '
')'
new='text = text.replace(/\n' + chr(0x2554) + 'K\n[\s\S]*?\n' + chr(0x255a) + '(?=\
|$)/g, '\u000a');'
s=s.replace(old,new)
f=codecs.open('server-app/ai-panel/panel-quest-ui.js','w','utf-8')
f.write(s)
f.close()
print('DONE')
