// ============================================================================
// devtools-inject.ts — DevTools Console 悬浮按钮（复制 / 另存为）
// 数据源: renderer window.top.__qqq_console_lines (深度序列化 + 调用栈)
// 推送: 每2s → wc.executeJavaScript 读 renderer → base64 → DevTools
// 另存为: 设 flag → push loop 检测 → Electron dialog.showSaveDialog
// ============================================================================

import type { WebContents, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let _pushTimer: ReturnType<typeof setInterval> | null = null;
let _saveLock = false;

export function injectDevToolsConsoleButtons(
  wc: WebContents,
  getText: () => string,
  mw: BrowserWindow,
): void {
  _injectJs(wc, getText, mw);
}

function _injectJs(wc: WebContents, getText: () => string, mw: BrowserWindow): void {
  const tryInject = () => {
    const dwc = (wc as any).devToolsWebContents as WebContents | undefined;
    if (!dwc) return;
    dwc.executeJavaScript(`(function(){
if(window.__qqq_dt_btns_installed)return;
window.__qqq_dt_btns_installed=true;
function _b64ToUtf8(b64){try{var b=atob(b64),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new TextDecoder('utf-8').decode(u);}catch(e){return b64;}}
function _getText(){
  if(window.__QQQ_CONSOLE_READY&&window.__QQQ_CONSOLE_B64)return _b64ToUtf8(window.__QQQ_CONSOLE_B64);
  return'';
}
function _toast(m){
  var el=document.getElementById('qqq-dt-toast');if(!el)return;
  el.textContent=m;el.style.opacity='1';
  clearTimeout(_toast._tid);_toast._tid=setTimeout(function(){el.style.opacity='0'},1800);
}
// CSS
var s=document.createElement('style');
s.textContent=[
  '#qqq-dt-btns{position:fixed;bottom:8px;right:8px;display:flex;gap:4px;z-index:999999;opacity:0.25;transition:opacity 0.15s}',
  '#qqq-dt-btns:hover{opacity:1}',
  '#qqq-dt-btns button{padding:3px 9px;border:1px solid #666;border-radius:3px;background:#1e1e1e;color:#ccc;font-size:11px;cursor:pointer;font-family:system-ui,sans-serif}',
  '#qqq-dt-btns button:hover{background:#333;border-color:#aaa;color:#fff}',
  '#qqq-dt-toast{position:fixed;bottom:36px;right:8px;padding:3px 8px;border-radius:3px;background:rgba(0,0,0,0.85);color:#fff;font-size:10px;z-index:999999;pointer-events:none;opacity:0;transition:opacity 0.2s;font-family:system-ui,sans-serif}'
].join('\\n');
document.head.appendChild(s);
var b=document.createElement('div');b.id='qqq-dt-btns';
b.innerHTML='<button id="qqq-dt-copy">\\u{1F4CB}\\u590D\\u5236</button><button id="qqq-dt-save">\\u{1F4BE}\\u53E6\\u5B58\\u4E3A</button>';
var e=document.createElement('div');e.id='qqq-dt-toast';document.body.appendChild(b);document.body.appendChild(e);
// 复制按钮
document.getElementById('qqq-dt-copy').onclick=function(){
  var t=_getText().replace(/\n+$/,'').replace(/^\n+/,'');if(!t){_toast('\\u65E0\\u5185\\u5BB9');return;}
  var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');_toast('\\u5DF2\\u590D\\u5236 '+t.split('\\n').length+'\\u884C');}catch(ex){_toast('\\u5931\\u8D25');}
  document.body.removeChild(ta);
};
// 另存为按钮 → 设flag，主进程接管
document.getElementById('qqq-dt-save').onclick=function(){
  window.__QQQ_CONSOLE_REQUEST_SAVE=true;_toast('\\u6B63\\u5728\\u4FDD\\u5B58...');
};
})();`).then(() => { _startPushLoop(wc, dwc, getText, mw); })
      .catch(() => {});
  };
  if ((wc as any).devToolsWebContents) { tryInject(); return; }
  let n = 0;
  const t = setInterval(() => { n++; if ((wc as any).devToolsWebContents) { clearInterval(t); tryInject(); } else if (n >= 30) clearInterval(t); }, 500);
}

function _startPushLoop(wc: WebContents, dwc: WebContents, getText: () => string, mw: BrowserWindow): void {
  if (_pushTimer) clearInterval(_pushTimer);
  _pushTimer = setInterval(async () => {
    if (dwc.isDestroyed() || wc.isDestroyed()) {
      if (_pushTimer) { clearInterval(_pushTimer); _pushTimer = null; }
      return;
    }

    // ① 另存为
    try {
      const ws = await dwc.executeJavaScript('!!window.__QQQ_CONSOLE_REQUEST_SAVE');
      if (ws && !_saveLock) {
        _saveLock = true;
        dwc.executeJavaScript('window.__QQQ_CONSOLE_REQUEST_SAVE=false').catch(() => {});
        try {
          let text = getText().replace(/\n+$/,'').replace(/^\n+/,'');
          if (!text) {
            await dwc.executeJavaScript(
              "var el=document.getElementById('qqq-dt-toast');if(el){el.textContent='\\u65E0\\u5185\\u5BB9';el.style.opacity='1';setTimeout(function(){el.style.opacity='0'},1800)}"
            ).catch(() => {});
            _saveLock = false;
            return;
          }
          // 读项目根目录
          let pr = '';
          try { pr = await wc.executeJavaScript('(window._workspaceRoot||"")'); } catch {}
          const now = new Date();
          const pf = (n: number) => (n < 10 ? '0' : '') + n;
          const ts = `${now.getFullYear()}-${pf(now.getMonth()+1)}-${pf(now.getDate())}_${pf(now.getHours())}-${pf(now.getMinutes())}-${pf(now.getSeconds())}`;
          const defPath = pr ? path.join(pr, 'logs', `console_${ts}.log`) : `console_${ts}.log`;
          const result = await dialog.showSaveDialog(mw, {
            title: '保存控制台日志',
            defaultPath: defPath,
            filters: [{ name: '日志文件', extensions: ['log'] }]
          });
          if (!result.canceled && result.filePath) {
            fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
            fs.writeFileSync(result.filePath, text, 'utf-8');
            await dwc.executeJavaScript(
              "var el=document.getElementById('qqq-dt-toast');if(el){el.textContent='\\u5DF2\\u4FDD\\u5B58';el.style.opacity='1';setTimeout(function(){el.style.opacity='0'},1800)}"
            ).catch(() => {});
          }
        } catch {
          await dwc.executeJavaScript(
            "var el=document.getElementById('qqq-dt-toast');if(el){el.textContent='\\u5931\\u8D25';el.style.opacity='1';setTimeout(function(){el.style.opacity='0'},1800)}"
          ).catch(() => {});
        }
        _saveLock = false;
      }
    } catch {}

    // ② 推送 base64 到 DevTools
    try {
      let text = getText();
      if (!text) text = '';
      if (text.length > 2 * 1024 * 1024) {
        const origLen = text.length;
        text = text.slice(-2 * 1024 * 1024);
        text = '...(truncated ' + ((origLen - 2*1024*1024) / 1024).toFixed(0) + ' KB from start)\n' + text;
      }
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      if (b64.length < 50 * 1024 * 1024) {
        dwc.executeJavaScript('window.__QQQ_CONSOLE_B64="'+b64+'";window.__QQQ_CONSOLE_READY=true').catch(() => {});
      }
    } catch {}
  }, 2000);
  if (_pushTimer && typeof _pushTimer === 'object' && 'unref' in _pushTimer) (_pushTimer as any).unref();
}
