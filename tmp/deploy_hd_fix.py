"""Quick deploy: tar → scp CN → go build → scp US → restart"""
import sys, subprocess, time
sys.path.insert(0, r'E:\s\wol\py\gaea\cf')
from ky import PROJECT_DIR, GIT_BASH, REMOTE_DIR, CN_HOST, US_HOST, SSH_USER, SYNC_ITEMS, EXCLUDE_ITEMS, REMOTE_GO

def to_bp(p):
    p = str(p).replace('\\', '/')
    if len(p) > 1 and p[1] == ':':
        p = '/' + p[0].lower() + p[2:]
    return p

def bash(cmd, desc, timeout=300):
    print('>>>', desc)
    r = subprocess.run(['E:\\s\\d\\git\\bin\\bash.exe', '-c', cmd], capture_output=True, text=True, timeout=timeout, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        print('FAIL:', (r.stderr or r.stdout)[:300])
        return False
    print('OK')
    return True

def ssh(host, cmd, desc, timeout=180):
    return bash(f"ssh -o StrictHostKeyChecking=no {SSH_USER}@{host} '{cmd}'", desc, timeout)

def ssh_us(cmd, desc, timeout=300):
    return bash(f"ssh -o StrictHostKeyChecking=no {SSH_USER}@{CN_HOST} 'ssh -o StrictHostKeyChecking=no {SSH_USER}@{US_HOST} \"{cmd}\"'",
                f'[CN->US] {desc}', timeout)

# 1. Tar
exclude = ' '.join(f'--exclude={e}' for e in EXCLUDE_ITEMS)
items = ' '.join(SYNC_ITEMS)
bash(f'cd {to_bp(PROJECT_DIR)} && tar czf /tmp/gaea-deploy.tar.gz {exclude} {items}', 'Tar')

# 2. SCP to CN
bash(f'scp -o StrictHostKeyChecking=no /tmp/gaea-deploy.tar.gz {SSH_USER}@{CN_HOST}:/tmp/', 'SCP')

# 3. Build on CN
ssh(CN_HOST, f'mkdir -p {REMOTE_DIR} && tar xzf /tmp/gaea-deploy.tar.gz -C {REMOTE_DIR} && cd {REMOTE_DIR} && {REMOTE_GO} build -o server ./cmd/api/',
    'Go build', timeout=300)

# 4. Stop US, scp binary, start US
ssh_us('systemctl stop dgs', 'Stop US', timeout=45)
time.sleep(3)
ssh(CN_HOST, f'scp -o StrictHostKeyChecking=no {REMOTE_DIR}/server {SSH_USER}@{US_HOST}:{REMOTE_DIR}/server',
    'scp binary', timeout=120)
ssh_us('systemctl start dgs', 'Start US', timeout=45)

# 5. Restart CN
ssh(CN_HOST, 'systemctl restart dgs', 'Restart CN', timeout=45)

print('=== DONE ===')
