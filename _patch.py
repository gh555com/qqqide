import os

src = r'e:\s\wol\py\qqq-shell-v2\node_modules\monaco-editor\min\vs\base\worker\workerMain.js'
dst = r'e:\s\wol\py\qqq-shell-v2\cache\worker-wrapper\vs\base\worker\workerMain.js'
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(src, "r", encoding="utf-8") as f: content = f.read()
needle = '}).call(this);'
idx = content.rfind(needle)
content = content[:idx] + 'self.define=function(n,d,f){return Y(n,J(d),f)};' + content[idx:]
with open(dst, "w", encoding="utf-8", newline=\"\n\") as f: f.write(content)
print('OK size', len(content))
print('END:', repr(content[-250:]))
