// ============================================================================
// devtools-inject.ts — DevTools Console 悬浮按钮（复制 / 另存为）
// 架构：直接注入到 DevTools WebContents，读取 DevTools 自身 DOM 获取完整控制台内容
//       包含已展开对象的全部细节（三角形展开的内容），不再依赖主进程 buffer。
// 只在 --dev 模式下使用。
// ============================================================================

import type { WebContents, BrowserWindow } from 'electron';

/**
 * @param wc       主渲染进程 WebContents
 * @param _getText 未使用（保留签名兼容）
 * @param _mw      未使用（保留签名兼容）
 */
export function injectDevToolsConsoleButtons(
  wc: WebContents,
  _getText: () => string,
  _mw: BrowserWindow,
): void {
  _injectJs(wc);
}

// ── 注入按钮 JS 到 DevTools WebContents ──
function _injectJs(wc: WebContents): void {
  const tryInject = () => {
    const dwc = (wc as any).devToolsWebContents as WebContents | undefined;
    if (!dwc) return;
    dwc.executeJavaScript(`(function(){
if(window.__qqq_dt_btns_installed)return;
window.__qqq_dt_btns_installed=true;

// ── 从 DevTools Console DOM 提取完整控制台文本 ──
// 使用 .console-view 的 innerText（保留视觉格式，含展开对象细节）
function _getFullConsoleText() {
  // 主选择器：DevTools 的 console view 容器
  var view = document.querySelector('.console-view');
  if (view) {
    var t = view.innerText;
    if (t && t.length > 0) return t;
  }
  // 回退：遍历所有 console-message-text 元素（含展开的对象树）
  var msgs = document.querySelectorAll('[class*="console-message"]');
  if (msgs.length === 0) return '';
  var lines = [];
  for (var i = 0; i < msgs.length; i++) {
    var txt = msgs[i].innerText;
    if (txt) lines.push(txt);
  }
  return lines.join('\\n');
}

// ── 生成带时间戳的文件名 ──
function _makeLogFileName() {
  var d = new Date();
  var pad = function(n) { return n < 10 ? '0' + n : String(n); };
  return 'console_' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds()) + '.log';
}

// ── 样式 ──
var s=document.createElement('style');
s.textContent=[
  '#qqq-dt-btns{position:fixed;bottom:8px;right:8px;display:flex;gap:4px;z-index:999999;opacity:0.25;transition:opacity 0.15s}',
  '#qqq-dt-btns:hover{opacity:1}',
  '#qqq-dt-btns button{padding:3px 9px;border:1px solid #666;border-radius:3px;background:#1e1e1e;color:#ccc;font-size:11px;cursor:pointer;font-family:system-ui,sans-serif}',
  '#qqq-dt-btns button:hover{background:#333;border-color:#aaa;color:#fff}',
  '#qqq-dt-toast{position:fixed;bottom:36px;right:8px;padding:3px 8px;border-radius:3px;background:rgba(0,0,0,0.85);color:#fff;font-size:10px;z-index:999999;pointer-events:none;opacity:0;transition:opacity 0.2s;font-family:system-ui,sans-serif}'
].join('\\n');
document.head.appendChild(s);

var b=document.createElement('div');
b.id='qqq-dt-btns';
b.innerHTML='<button id="qqq-dt-copy">\\u{1F4CB} \\u590D\\u5236</button><button id="qqq-dt-save">\\u{1F4BE} \\u53E6\\u5B58\\u4E3A</button>';

var t=document.createElement('div');
t.id='qqq-dt-toast';

var _tid=0;
function toast(m){
  t.textContent=m;t.style.opacity='1';
  if(_tid)clearTimeout(_tid);
  _tid=setTimeout(function(){t.style.opacity='0'},1800);
}

document.body.appendChild(b);
document.body.appendChild(t);

// ── 复制按钮：读取 DevTools 控制台完整 DOM → 写入剪贴板 ──
document.getElementById('qqq-dt-copy').onclick=function(){
  var text = _getFullConsoleText();
  if (!text) { toast('\\u65E0\\u5185\\u5BB9'); return; }
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    var lines = text.split('\\n').length;
    toast('\\u5DF2\\u590D\\u5236 ' + lines + ' \\u884C');
  } catch(e) {
    toast('\\u590D\\u5236\\u5931\\u8D25');
  }
  document.body.removeChild(ta);
};

// ── 另存为按钮：读取完整 DOM → Blob 下载 ──
document.getElementById('qqq-dt-save').onclick=function(){
  var text = _getFullConsoleText();
  if (!text) { toast('\\u65E0\\u5185\\u5BB9'); return; }
  try {
    var blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = _makeLogFileName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 500);
    toast('\\u5DF2\\u4FDD\\u5B58');
  } catch(e) {
    toast('\\u4FDD\\u5B58\\u5931\\u8D25');
  }
};
})();`).catch(() => { /* DevTools not ready */ });
  };

  if ((wc as any).devToolsWebContents) {
    tryInject();
    return;
  }
  let attempts = 0;
  const pollTimer = setInterval(() => {
    attempts++;
    if ((wc as any).devToolsWebContents) {
      clearInterval(pollTimer);
      tryInject();
    } else if (attempts >= 30) {
      clearInterval(pollTimer);
    }
  }, 500);
}
