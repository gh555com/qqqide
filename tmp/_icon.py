from PIL import Image
img = Image.open(r'E:\s\wol\py\q3\assets\q2.png')
img = img.resize((256, 256), Image.LANCZOS)
img.save(r'E:\s\wol\py\qqq-shell-v2\shell\icon.ico', format='ICO')
print('OK')
