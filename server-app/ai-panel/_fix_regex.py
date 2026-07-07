with open('panel-floor.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix corrupted regex (search_replace converted \n to literal newlines again)
# Find the corruption pattern
marker = "var cleanQuestion = (floorData.question || '').replace(/\\[File: [^\\]]+\\]\\s*"
idx = content.find(marker)
if idx >= 0:
    correct_line = "        var cleanQuestion = (floorData.question || '').replace(/\\[File: [^\\]]+\\]\\s*\\n```[\\s\\S]*?```/g, '').replace(/\\n{3,}/g, '\\n\\n').trim();\n"
    end_marker = "        lines.push('\\u25a0 Q: ' + cleanQuestion);"
    end_idx = content.find(end_marker, idx)
    if end_idx >= 0:
        before = content[:idx]
        after = content[end_idx:]
        content = before + correct_line + after
        print(f"Fixed regex at position {idx}")
    else:
        print("ERROR: end marker not found")
else:
    print("ERROR: corruption marker not found")

with open('panel-floor.js', 'w', encoding='utf-8') as f:
    f.write(content)
print("Done")
