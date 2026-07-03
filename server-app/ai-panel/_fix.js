var fs = require('fs');
var c = fs.readFileSync('panel-registry.js', 'utf8');
c = c.replace(
    "// \u2500\u2500 \u767b\u8bb0\u4e00\u4e2a quest \u5f00\u59cb\u5efa\u697c \u2500\u2500\r\n// panelId: 0=\u5de6\u7ffc, 1=\u4e2d, 2=\u53f3\u7ffc\r\n\r\n// \u2500\u2500 \u767b\u8bb0\u4e00\u4e2a quest \u505c\u6b62\u5efa\u697c",
    "// \u2500\u2500 \u767b\u8bb0\u4e00\u4e2a quest \u5f00\u59cb\u5efa\u697c \u2500\u2500\r\n// panelId: 0=\u5de6\u7ffc, 1=\u4e2d, 2=\u53f3\u7ffc\r\nfunction _registerBuilding(questId, panelId) {\r\n    var reg = _ensureParentRegistry();\r\n    if (!reg) return;\r\n    reg[questId] = { stopState: 'sending', panelId: panelId, startedAt: Date.now() };\r\n}\r\n\r\n// \u2500\u2500 \u767b\u8bb0\u4e00\u4e2a quest \u505c\u6b62\u5efa\u697c\r\nfunction _unregisterBuilding(questId) {\r\n    var reg = _ensureParentRegistry();\r\n    if (!reg) return;\r\n    delete reg[questId];\r\n}"
);
fs.writeFileSync('panel-registry.js', c);
console.log('done');
