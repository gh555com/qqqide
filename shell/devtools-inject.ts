// ============================================================================
// devtools-inject.ts — DevTools Console 悬浮按钮（复制 / 另存为）
//
// v11 简化: 数据源 = console-message (浏览器原生全量) + renderer __qqq_console_lines (JS深度序列化)
// 注入: 外部 devtools-opened 事件保证 dwc 已就绪
// 推送: 每2s → 合并双源 → base64 → DevTools
// ============================================================================

import type { WebContents, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let _pushTimer: ReturnType<typeof setInterval> | null = null;
let _saveLock = false;

const INJECT_JS = `
(function(){
if(window.__qqq_dt_btns_installed)return;
window.__qqq_dt_btns_installed=true;

function _b64ToUtf8(b64){try{var b=atob(b64),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new TextDecoder('utf-8').decode(u);}catch(e){return b64;}}

function _getText(){
  if(window.__QQQ_CONSOLE_READY && window.__QQQ_CONSOLE_B64) return _b64ToUtf8(window.__QQQ_CONSOLE_B64);
  return '';
}

function _toast(m){
  var el=document.getElementById('qqq-dt-toast');if(!el)return;
  el.textContent=m;el.style.opacity='1';
  clearTimeout(_toast._tid);_toast._tid=setTimeout(function(){el.style.opacity='0'},1800);
}

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

document.getElementById('qqq-dt-copy').onclick=function(){
  var t=_getText().replace(/\\n+$/,'').replace(/^\\n+/,'');if(!t){_toast('\\u65E0\\u5185\\u5BB9');return;}
  var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');_toast('\\u5DF2\\u590D\\u5236 '+t.split('\\n').length+'\\u884C');}catch(ex){_toast('\\u5931\\u8D25');}
  document.body.removeChild(ta);
};

document.getElementById('qqq-dt-save').onclick=function(){
  window.__QQQ_CONSOLE_REQUEST_SAVE=true;_toast('\\u6B63\\u5728\\u4FDD\\u5B58...');
};
})();`;

// ── 合并双源: 主源 = _consoleBuffer (CDP Log.entryAdded), 备源 = __qqq_console_lines (JS深度序列化) ──
async function _mergedText(wc: WebContents, getText: () => string): Promise<string> {
  // 主源: CDP Log.entryAdded (带全量栈帧 + 浏览器原生消息) → 匹配右键另存为
  const cdp = getText();
  if (cdp) {
    const cdpLines = cdp.split('\n').filter(Boolean);
    // CDP 有 5+ 行真实数据 → 直接返回（已包含一切）
    if (cdpLines.length >= 5) return cdp;
  }
  // 备源: console-message + renderer __qqq_console_lines (CDP 尚未就绪时的降级)
  const parts: string[] = [];
  try {
    const r = await wc.executeJavaScript(
      '((window.top||window).__qqq_console_lines||[]).join("\\n")'
    );
    if (r) parts.push(r);
  } catch {}
  if (cdp) parts.push(cdp);
  return parts.join('\n');
}

export function injectDevToolsConsoleButtons(
  dwc: WebContents,
  wc: WebContents,
  getText: () => string,
  mw: BrowserWindow,
): void {
  if (dwc.isDestroyed()) return;
  console.log('[devtools-inject] injecting v11 buttons...');
  dwc.executeJavaScript(INJECT_JS)
    .then(() => { _startPushLoop(wc, dwc, getText, mw); })
    .catch((err: any) => { console.log('[devtools-inject] inject failed:', err?.message || err); });
}

function _startPushLoop(
  wc: WebContents,
  dwc: WebContents,
  getText: () => string,
  mw: BrowserWindow,
): void {
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
          const text = await _mergedText(wc, getText);
          if (!text) {
            await dwc.executeJavaScript("document.getElementById('qqq-dt-toast').textContent='\\u65E0\\u5185\\u5BB9';document.getElementById('qqq-dt-toast').style.opacity='1';setTimeout(function(){document.getElementById('qqq-dt-toast').style.opacity='0'},1800)").catch(() => {});
            _saveLock = false;
            return;
          }
          let pr = '';
          try { pr = await wc.executeJavaScript('(window._workspaceRoot||"")'); } catch {}
          const now = new Date();
          const p = (n: number) => n < 10 ? '0' + n : '' + n;
          const ts = now.getFullYear()+'-'+p(now.getMonth()+1)+'-'+p(now.getDate())+'_'+p(now.getHours())+'-'+p(now.getMinutes())+'-'+p(now.getSeconds());
          const defPath = pr ? path.join(pr, 'logs', 'console_'+ts+'.log') : 'console_'+ts+'.log';
          const result = await dialog.showSaveDialog(mw, {
            title: '保存控制台日志',
            defaultPath: defPath,
            filters: [{ name: '日志文件', extensions: ['log'] }],
          });
          if (!result.canceled && result.filePath) {
            fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
            fs.writeFileSync(result.filePath, text, 'utf-8');
            await dwc.executeJavaScript("document.getElementById('qqq-dt-toast').textContent='\\u5DF2\\u4FDD\\u5B58';document.getElementById('qqq-dt-toast').style.opacity='1';setTimeout(function(){document.getElementById('qqq-dt-toast').style.opacity='0'},1800)").catch(() => {});
          }
        } catch {
          await dwc.executeJavaScript("document.getElementById('qqq-dt-toast').textContent='\\u5931\\u8D25';document.getElementById('qqq-dt-toast').style.opacity='1';setTimeout(function(){document.getElementById('qqq-dt-toast').style.opacity='0'},1800)").catch(() => {});
        }
        _saveLock = false;
      }
    } catch {}

    // ② push base64 (合并双源)
    try {
      let text = await _mergedText(wc, getText);
      if (!text) text = '';
      if (text.length > 2 * 1024 * 1024) {
        const origLen = text.length;
        text = text.slice(-2 * 1024 * 1024);
        text = '...(truncated ' + ((origLen - 2*1024*1024) / 1024).toFixed(0) + ' KB from start)\\n' + text;
      }
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      if (b64.length < 50 * 1024 * 1024) {
        dwc.executeJavaScript('window.__QQQ_CONSOLE_B64="'+b64+'";window.__QQQ_CONSOLE_READY=true').catch(() => {});
      }
    } catch {}
  }, 2000);
  if (_pushTimer && typeof _pushTimer === 'object' && 'unref' in _pushTimer) (_pushTimer as any).unref();
}
