import os, sys
src = r"e:\s\wol\py\qqq-shell-v2\node_modules\monaco-editor\min\vs\base\worker\workerMain.js"
dst = r"e:\s\wol\py\qqq-shell-v2\cache\worker-wrapper\vs\base\worker\workerMain.js"
os.makedirs(os.path.dirname(dst), exist_ok=True)
with open(src, "r", encoding="utf-8") as f:
    content = f.read()
# Inject self.define=Y; before .call(this);
# Find the LAST }).call(this); which closes the outer IIFE
# Pattern: })).call(this);  or  }).call(this);
# The file ends with: ...createMonacoBaseAPI)())})}).call(this);
needle = "}).call(this);"
count = content.count(needle)
print(f"Found {count} occurrences of {needle}")
# Replace only the LAST occurrence
idx = content.rfind(needle)
if idx >= 0:
    content = content[:idx] + "self.define=Y;" + content[idx:]
    print(f"Injected at position {idx}")
else:
    print("NOT FOUND, looking for alternatives")
    for n in ["call(this)", "}).call(", ".call(this"]:
        print(f"  {n}: found at {content.find(n)}, rfind at {content.rfind(n)}")
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    f.write(content)
print(f"Written to {dst}")
print(f"Size: {len(content)} bytes")
# Verify
with open(dst, "r", encoding="utf-8") as f:
    v = f.read()
print(f"Verify: ends with: {repr(v[-100:])}")
