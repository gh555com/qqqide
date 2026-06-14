// ============================================================================
// devtools-inject.ts — DevTools Console 悬浮按钮（复制 / 另存为）
// 架构：主进程内存 buffer → localhost HTTP 桥 → DevTools fetch() 拉取
// 只在 --dev 模式下使用。
// ============================================================================

import type { WebContents, BrowserWindow } from 'electron';
import { createServer, Server } from 'http';
import { clipboard, dialog } from 'electron';

let _server: Server | null = null;

/**
 * @param wc       主渲染进程 WebContents
 * @param getText  返回完整控制台文本的回调（主进程侧 buffer）
 * @param _mw      主窗口引用（save dialog 需要）
 */
export function injectDevToolsConsoleButtons(
  wc: WebContents,
  getText: () => string,
  _mw: BrowserWindow,
): void {
  // ── 启动 localhost 桥接服务器（每次 DevTools 打开重建） ──
  if (_server) { try { _server.close(); } catch { } }
  _server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = req.url || '/';

    // ── GET /text → 返回全量控制台文本 ──
    if (req.method === 'GET' && url === '/text') {
      const text = getText();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
      return;
    }

    // ── POST /copy → 复制全量文本到剪贴板 ──
    if (req.method === 'POST' && url === '/copy') {
      const text = getText();
      if (!text) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, lines: 0 }));
        return;
      }
      try {
        clipboard.writeText(text);
        const lines = text.split('\n').length;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, lines }));
      } catch (_) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, lines: 0 }));
      }
      return;
    }

    // ── POST /save → 另存为文件 ──
    if (req.method === 'POST' && url === '/save') {
      const text = getText();
      if (!text) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      try {
        if (_mw && !_mw.isDestroyed()) {
          dialog.showSaveDialog(_mw, {
            title: '保存控制台输出',
            defaultPath: 'console_' + new Date().toISOString().slice(0, 10) + '.log',
            filters: [{ name: '日志', extensions: ['log', 'txt'] }],
          }).then(result => {
            if (!result.canceled && result.filePath) {
              const fs = require('fs');
              fs.writeFileSync(result.filePath, text, 'utf8');
            }
          });
        }
      } catch (_) { }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  _server.listen(0, '127.0.0.1', () => {
    const addr = _server!.address();
    if (typeof addr === 'object' && addr) {
      _injectJs(wc, addr.port);
    }
  });
}

// ── 注入按钮 JS 到 DevTools WebContents ──
function _injectJs(wc: WebContents, port: number): void {
  const tryInject = () => {
    const dwc = (wc as any).devToolsWebContents as WebContents | undefined;
    if (!dwc) return;
    dwc.executeJavaScript(`(function(p){
if(window.__qqq_dt_btns_installed)return;
window.__qqq_dt_btns_installed=true;
var H='http://127.0.0.1:'+p;

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

document.getElementById('qqq-dt-copy').onclick=function(){
  fetch(H+'/copy',{method:'POST'}).then(function(r){return r.json()}).then(function(j){
    toast(j.ok?'\\u5DF2\\u590D\\u5236 '+j.lines+' \\u884C':'\\u590D\\u5236\\u5931\\u8D25');
  }).catch(function(){toast('\\u8FDE\\u63A5\\u5931\\u8D25')});
};
document.getElementById('qqq-dt-save').onclick=function(){
  fetch(H+'/save',{method:'POST'}).then(function(r){return r.json()}).then(function(j){
    toast(j.ok?'\\u5DF2\\u4FDD\\u5B58':'\\u4FDD\\u5B58\\u5931\\u8D25');
  }).catch(function(){toast('\\u8FDE\\u63A5\\u5931\\u8D25')});
};
})(${port});`).catch(() => { /* DevTools not ready */ });
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
