import subprocess
r = subprocess.run(['git','show','HEAD:server-app/ai-panel/panel-floor.js'], capture_output=True, text=True)
lines = r.stdout.split('\n')
for i in range(274, min(285, len(lines))):
    print(f'{i+1}: {lines[i]}')
