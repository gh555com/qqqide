// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

var fs = require('fs');
var p = 'e:/s/wol/py/qqq-shell-v2/server-app/index.html';
var s = fs.readFileSync(p, 'utf8');

s = s.replace(
    '    <div class="qqq-menu-row qqq-menu-row-2">\r\n' +
    '      <div class="qqq-toolbar" id="qqq-toolbar">\r\n' +
    '        <span class="qqq-toolbar-brand">qqq</span>\r\n' +
    '        <span class="qqq-goods-bar" id="qqq-goods-bar"></span>\r\n' +
    '        <span class="qqq-spacer"></span>\r\n' +
    '        <button class="qqq-update-btn" id="qqq-update-btn" data-i18n-title="shell.update.check" title="检查更新" style="display:none">&#x21BB;</button>\r\n' +
    '        <span class="qqq-bulb" id="qqq-bulbs">\r\n' +
    '          <span class="qqq-bulb-dot" id="qqq-bulb-1" title="外嵌面板 1"></span>\r\n' +
    '          <span class="qqq-bulb-dot" id="qqq-bulb-2" title="外嵌面板 2"></span>\r\n' +
    '        </span>\r\n' +
    '      </div>\r\n' +
    '    </div>',

    '    <div class="qqq-menu-row qqq-menu-row-2">\r\n' +
    '      <div class="qqq-toolbar" id="qqq-toolbar" style="flex:1">\r\n' +
    '        <span class="qqq-toolbar-brand">qqq</span>\r\n' +
    '        <span class="qqq-goods-bar" id="qqq-goods-bar"></span>\r\n' +
    '        <span class="qqq-spacer"></span>\r\n' +
    '        <button class="qqq-update-btn" id="qqq-update-btn" data-i18n-title="shell.update.check" title="检查更新" style="display:none">&#x21BB;</button>\r\n' +
    '      </div>\r\n' +
    '      <span class="qqq-bulb" id="qqq-bulbs">\r\n' +
    '        <span class="qqq-bulb-dot" id="qqq-bulb-1" title="外嵌面板 1"></span>\r\n' +
    '        <span class="qqq-bulb-dot" id="qqq-bulb-2" title="外嵌面板 2"></span>\r\n' +
    '      </span>\r\n' +
    '    </div>'
);

fs.writeFileSync(p, s);
console.log('index.html DONE');
