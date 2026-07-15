with open('shell-build/deploy.js', 'r', encoding='utf-8') as f:
    c = f.read()

# Remove effectiveHost + isUSDeploy, replace all effectiveHost() with CN_HOST
import re

# 1. Replace function definitions with CN_HOST constant
old1_start = "function effectiveHost() {"
old1_end = "function sshOpts() {"
idx_s = c.index(old1_start)
idx_e = c.index(old1_end)
replacement = "// 2026-07-14: US 已停服，CN 单节点。deploy 直达 CN。\nconst CN_HOST = 'q@47.105.67.51';\n\n"
c = c[:idx_s] + replacement + c[idx_e:]

# 2. Replace all remaining effectiveHost() with CN_HOST
c = c.replace("effectiveHost()", "CN_HOST")

# 3. Simplify extract
old3 = 'const extractAndKeep = isUSDeploy()\n  ? `"cd ${REMOTE_} && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz"`\n  : `"cd ${REMOTE_} && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz && rm _qqqide.tar.gz"`;'
new3 = 'const extractAndKeep = `"cd ${REMOTE_} && cp _qqqide.tar.gz server-app.tar.gz && tar -xzf _qqqide.tar.gz && rm _qqqide.tar.gz"`;'
c = c.replace(old3, new3)

# 4. Remove US sync block (step 7)
old4_start = "// 7) ★ US deploy: background CN→US sync via WireGuard"
old4_end = "console.log('[deploy] done. server-app/ uploaded to', CN_HOST + ':' + REMOTE);"
idx4_s = c.index(old4_start)
idx4_e = c.index(old4_end)
c = c[:idx4_s] + "// 7) US sync removed — US decommissioned (2026-07-14); deploy ends at CN.\n\n" + c[idx4_e:]

with open('shell-build/deploy.js', 'w', encoding='utf-8') as f:
    f.write(c)

print("OK")
