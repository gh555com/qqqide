import paramiko
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect('47.105.67.51', username='q', key_filename='C:/Users/q/.ssh/id_ed25519', timeout=10, banner_timeout=10, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = c.exec_command('grep server_name /etc/nginx/sites-available/gh555; echo ===; curl -sk -H "Host: direct-cn.gh555.com" https://127.0.0.1/api/v3/ai/chat -X POST -d "{}"', timeout=8)
print(stdout.read().decode())
c.close()
