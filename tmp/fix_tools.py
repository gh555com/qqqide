import sys

with open('E:/s/wol/py/qqq-shell-v2/server-app/ai-panel/tools.js', 'rb') as f:
    data = f.read()

content = data.decode('utf-8')
# Normalize CRLF to LF for matching
content_normalized = content.replace('\r\n', '\n')

old = '''                if (_alreadyCovered) {
                        _rec.b++;
                        if (_rec.b >= 3) {
                            _rec.thawed = true;  // ★ 永久解冻：AI 已证明上下文丢失，后续不再阻拦
                        } else {
                            return '[ALREADY READ] 文件 ' + args.path + ' L' + _reqStart + '-' + _reqEnd + ' 已读过（第 ' + _rec.b + ' 次阻拦）。若上下文丢失请换更大行范围重读，或继续分析已有内容。';
                        }
                    }
                }
            } else {
                // 再次全文读 → 阻拦但有阶梯
                    _rec.b++;
                    if (_rec.b >= 3) {
                        _rec.thawed = true;  // ★ 永久解冻
                    } else {
                        return '[ALREADY READ] 文件 ' + args.path + ' 已全文读过（第 ' + _rec.b + ' 次阻拦）。若上下文丢失，请用 start_line/end_line 读你缺失的具体段落。';
                    }
                }
            }'''

new = '''                if (_alreadyCovered) {
                    if (!_rec.thawed) {
                        _rec.b++;
                        if (_rec.b >= 3) {
                            _rec.thawed = true;  // ★ 永久解冻：AI 已证明上下文丢失，后续不再阻拦
                        } else {
                            return '[ALREADY READ] 文件 ' + args.path + ' L' + _reqStart + '-' + _reqEnd + ' 已读过（第 ' + _rec.b + ' 次阻拦）。若上下文丢失请换更大行范围重读，或继续分析已有内容。';
                        }
                    }
                }
            } else {
                // 再次全文读 → 阻拦但有阶梯
                if (!_rec.thawed) {
                    _rec.b++;
                    if (_rec.b >= 3) {
                        _rec.thawed = true;  // ★ 永久解冻
                    } else {
                        return '[ALREADY READ] 文件 ' + args.path + ' 已全文读过（第 ' + _rec.b + ' 次阻拦）。若上下文丢失，请用 start_line/end_line 读你缺失的具体段落。';
                    }
                }
            }'''

if old in content_normalized:
    content_normalized = content_normalized.replace(old, new, 1)
    # Convert back to CRLF for writing
    content_final = content_normalized.replace('\n', '\r\n')
    with open('E:/s/wol/py/qqq-shell-v2/server-app/ai-panel/tools.js', 'w', encoding='utf-8', newline='') as f:
        f.write(content_final)
    print('DONE')
else:
    print('NOT FOUND')
    # Debug: show area around _alreadyCovered
    area = content_normalized.find('if (_alreadyCovered)')
    if area > 0:
        snippet = content_normalized[area:area+500]
        for i, line in enumerate(snippet.split('\n')):
            print(f'{i}: {repr(line[:120])}')
