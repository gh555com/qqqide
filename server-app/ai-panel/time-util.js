'use strict';
// ═══ 唯一真理时间机器 — 一切时间格式化走这里 ═══
// _fmtTime(d?) → "YYYY-MM-DD HH:MM:SS"（操作系统本地时间）
// 参数: Date 对象，或任何 new Date() 能解析的值。省略 = 当前时间。
function _fmtTime(d) {
    if (!d) d = new Date();
    else if (!(d instanceof Date)) d = new Date(d);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset();
    var tz = 'UTC' + (off >= 0 ? '+' : '-') + p(Math.floor(Math.abs(off) / 60));
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' ' + tz;
}
