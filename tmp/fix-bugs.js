var fs = require('fs');

// === Bug 1: Fix index.html — remove agent state clearing in createNewQuest ===
var p1 = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/index.html';
var lines1 = fs.readFileSync(p1, 'utf8').split(/\r?\n/);

// Find the block: "  questActiveId = '';" followed by agent.xxx clearing, up to "_activeAgent = null;"
for (var i = 0; i < lines1.length; i++) {
    if (lines1[i].trim() === "questActiveId = '';" &&
        i + 1 < lines1.length && lines1[i + 1].trim() === 'agent.conversation = [];') {
        console.log('Bug1: found at line', i);
        // Delete lines i+1 through the last agent state line (agent._serverDrift = 0;)
        // These are lines i+1 to i+9 (10 lines of agent clearing)
        // We keep: questActiveId = ''; then go to _queue = [];
        // Find where agent clearing ends
        var endIdx = i + 1;
        while (endIdx < lines1.length && lines1[endIdx].trim().indexOf('agent.') === 0) {
            endIdx++;
        }
        console.log('  Removing', endIdx - (i + 1), 'agent state lines (from line', i + 1, 'to', endIdx - 1, ')');
        lines1.splice(i + 1, endIdx - (i + 1));
        break;
    }
}
fs.writeFileSync(p1, lines1.join('\r\n'), 'utf8');
console.log('Bug1: done');

// === Bug 2: Fix quest-store.js — preserve _owner in save ===
var p2 = 'e:/s/wol/py/qqq-shell-v2/server-app/ai-panel/quest-store.js';
var lines2 = fs.readFileSync(p2, 'utf8').split(/\r?\n/);

// Find: "    data.savedAt = Date.now();" then the COUNTER_FLOOR_FIELD preservation block
for (var j = 0; j < lines2.length; j++) {
    if (lines2[j].trim() === 'data.savedAt = Date.now();') {
        // Check next line for the comment
        if (lines2[j + 1] && lines2[j + 1].indexOf('保留 __nextFloorId') >= 0) {
            console.log('Bug2: found at line', j);
            // Replace the old block (lines j to j+6) with new block that also preserves _owner
            var newBlock = [
                '    data.savedAt = Date.now();',
                '    // 保留 __nextFloorId 计数器 + _owner（分别由 getNextFloorId / claimOwner 写入，不可被 save 覆盖）',
                '    var existing = await _get(QUEST_NS + "." + id);',
                '    if (existing) {',
                '      if (typeof data[COUNTER_FLOOR_FIELD] !== "number" && typeof existing[COUNTER_FLOOR_FIELD] === "number") {',
                '        data[COUNTER_FLOOR_FIELD] = existing[COUNTER_FLOOR_FIELD];',
                '      }',
                '      if (existing._owner && !data._owner) {',
                '        data._owner = existing._owner;',
                '      }',
                '    }'
            ];
            // old block lines: j to j+6
            lines2.splice(j, 7, newBlock[0], newBlock[1], newBlock[2], newBlock[3], newBlock[4], newBlock[5], newBlock[6], newBlock[7], newBlock[8], newBlock[9]);
            break;
        }
    }
}
fs.writeFileSync(p2, lines2.join('\r\n'), 'utf8');
console.log('Bug2: done');
