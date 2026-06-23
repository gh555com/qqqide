import zipfile, os
srcdir = r'E:\\s\\wol\\py\\qqq-shell-v2\\dist-pack\\win-unpacked'
out = r'E:\\s\\wol\\py\\qqq-shell-v2\\dist-pack\\qqqide-win-x64.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as z:
    for root, dirs, files in os.walk(srcdir):
        for f in files:
            fp = os.path.join(root, f)
            arc = os.path.relpath(fp, srcdir)
            z.write(fp, arc)
print('[pack] python zip done:', out)
