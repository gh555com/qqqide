// ============================================================================
// devtools-inject.ts — DevTools Console 悬浮按钮（复制 / 另存为）
//
// v14.1: 重试探针 + InspectorFrontendHost.save 劫持（终极兜底）
// 注入脚本 → 多路探测 ConsoleModel（每 500ms 重试, 最多 60 次=30s）
// 找到 → _qqqGetConsoleText() 直读 messages()
// 超时未找到 → 劫持 InspectorFrontendHost.save 捕获下次右键另存为内容
// 主进程 push loop 优先读注入函数，兜底 CDP buffer
// ============================================================================

import type { WebContents, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let _pushTimer: ReturnType<typeof setInterval> | null = null;
let _saveLock = false;
let _diagLogged = false;

const INJECT_JS = `
(function(){
if(window.__qqq_dt_btns_installed)return;
window.__qqq_dt_btns_installed=true;

// v14.1: 重试探针 + InspectorFrontendHost.save 劫持

// ── 诊断对象 ──
window.__QQQ_DIAG = { probes: 0, found: false, path: '', sdkKeys: [], uiKeys: [] };

// ── 重试探针（每 500ms, 最多 60 次 = 30s）──
var _cm=null,_cmPath='',_probes=0;
function _probeOnce(){
  _probes++; window.__QQQ_DIAG.probes=_probes;
  function _hasMsgs(o){try{var m=o.messages();return Array.isArray(m)&&m.length>0;}catch(e){return false;}}

  // Dump SDK keys on first probe
  if(_probes===1){
    try{window.__QQQ_DIAG.sdkKeys=Object.keys(self.SDK||{});}catch(e){}
    try{window.__QQQ_DIAG.uiKeys=Object.keys(self.UI||{});}catch(e){}
    try{window.__QQQ_DIAG.hasSave=typeof InspectorFrontendHost.save==='function';}catch(e){}
  }

  // Path A: self.SDK.consoleModel
  try{if(self.SDK&&self.SDK.consoleModel&&_hasMsgs(self.SDK.consoleModel)){_cm=self.SDK.consoleModel;_cmPath='SDK.consoleModel';}}catch(e){}
  // Path B: SDK first-level
  if(!_cm)try{for(var k in self.SDK){try{if(self.SDK[k]&&self.SDK[k].consoleModel&&_hasMsgs(self.SDK[k].consoleModel)){_cm=self.SDK[k].consoleModel;_cmPath='SDK.'+k+'.consoleModel';break;}}catch(e){}}}catch(e){}
  // Path C: deep walk
  if(!_cm)try{
    var _seen=new Set();
    function _walk(o,d,p){
      if(d>3||!o||typeof o!=='object'||_seen.has(o))return false;_seen.add(o);
      if(_hasMsgs(o)){_cm=o;_cmPath=p;return true;}
      for(var kk in o){try{if(o[kk]&&typeof o[kk]==='object'&&_walk(o[kk],d+1,p+'.'+kk))return true;}catch(e){}}
      return false;
    }
    if(self.SDK&&_walk(self.SDK,0,'SDK')){}
    else if(self.UI&&_walk(self.UI,0,'UI')){}
    else _walk(self,0,'self');
  }catch(e){}

  if(_cm){
    window.__QQQ_DIAG.found=true; window.__QQQ_DIAG.path=_cmPath;
    window.__QQQ_CM_FOUND=true; window.__QQQ_CM_PATH=_cmPath;
    console.log('[qqq-dt] ConsoleModel FOUND at probe#'+_probes+' path='+_cmPath+' msgs='+_cm.messages().length);
    // ★ Dump first 10 message structures (keys + source + sample fields)
    _dumpMsgStructs();
    // ★ Dump network messages specifically
    _dumpNetMsg();
    // ★ Dump Console panel structure
    _dumpPanelStruct();
    return;
  }
  window.__QQQ_CM_FOUND=false;
  if(_probes<60) setTimeout(_probeOnce, 500);
  else console.log('[qqq-dt] ConsoleModel NOT FOUND after 60 probes. sdkKeys='+JSON.stringify(window.__QQQ_DIAG.sdkKeys)+' hasSave='+window.__QQQ_DIAG.hasSave);
}

function _dumpMsgStructs(){
  try{
    var ms=_cm.messages();
    var structs=[];
    for(var i=0;i<Math.min(ms.length,10);i++){
      var m=ms[i],keys=[],vals={};
      try{for(var k in m){try{keys.push(k);var v=m[k];vals[k]=typeof v==='string'?v.slice(0,120):typeof v==='number'?v:typeof v==='boolean'?v:typeof v==='object'?(Array.isArray(v)?'Array['+v.length+']':'Object{'+Object.keys(v||{}).join(',')+'}'):typeof v;}catch(e){}}}catch(e){}
      structs.push({i:i,source:m.source,level:m.level,keys:keys.slice(0,25),vals:vals,rawText:(m.messageText||'').slice(0,150)});
    }
    window.__QQQ_MSG_STRUCTS=structs;
    console.log('[qqq-dt] msg structs: '+JSON.stringify(structs,null,0));
  }catch(e){window.__QQQ_MSG_STRUCTS=['err: '+(e.message||e)];}
}

function _dumpPanelStruct(){
  try{
    var info={};
    if(self.UI&&self.UI.inspectorView){
      var iv=self.UI.inspectorView;
      try{info._panels=Object.keys(iv._panels||{}).join(',');}catch(e){}
      try{info._panelOrder=(iv._panelOrder||[]).map(function(p){return p._panelName||p.name||'';}).join(',');}catch(e){}
    }
    // Try to find Console panel
    try{
      var cp=self.UI.panels&&self.UI.panels.console;
      if(cp){info.consolePanel=true;info.consolePanelKeys=Object.keys(cp).slice(0,20).join(',');}
    }catch(e){}
    // Try console view
    try{
      for(var pk in (self.UI.inspectorView._panels||{})){
        try{
          var p=self.UI.inspectorView._panels[pk];
          if(p&&p._view){
            var vk=Object.keys(p._view).slice(0,30).join(',');
            info['panel_'+pk+'_viewKeys']=vk;
          }
        }catch(e){}
      }
    }catch(e){}
    window.__QQQ_PANEL_INFO=info;
    console.log('[qqq-dt] panel info: '+JSON.stringify(info,null,0));
  }catch(e){window.__QQQ_PANEL_INFO=['err: '+(e.message||e)];}
}

function _dumpNetMsg(){
  try{
    var ms=_cm.messages(),nets=[];
    for(var i=0;i<ms.length;i++){
      var m=ms[i];
      if(m.source!=='network')continue;
      var p=[];
      try{var params=m.parameters||[];for(var j=0;j<params.length;j++)p.push({t:typeof params[j].value,v:(params[j].value||'').slice(0,80)});}catch(e){}
      nets.push({i:i,text:(m.messageText||'').slice(0,200),url:(m.url||'').slice(0,200),line:m.line,level:m.level,params:p,stackTrace:!!(m.stackTrace&&m.stackTrace.callFrames&&m.stackTrace.callFrames.length)});
      if(nets.length>=10)break;
    }
    window.__QQQ_NET_MSGS=nets;
    console.log('[qqq-dt] network msgs: '+JSON.stringify(nets,null,0));
  }catch(e){window.__QQQ_NET_MSGS=['err: '+(e.message||e)];}
}

_probeOnce();

// ── 终极兜底: 劫持 InspectorFrontendHost.save ──
// 在 ConsoleModel 不可用时，拦截 DevTools 右键另存为数据
(function _hijackSave(){
  try{
    if(typeof InspectorFrontendHost==='undefined'||!InspectorFrontendHost) return;
    if(!InspectorFrontendHost.save) return;
    var _origSave=InspectorFrontendHost.save;
    InspectorFrontendHost.save=function(url,content,forceSaveAs){
      // 捕获内容 (只取 string, 跳过 blob)
      if(typeof content==='string' && content.length>10){
        window.__QQQ_HIJACK_CONTENT=content;
        window.__QQQ_HIJACK_TS=Date.now();
      }
      // 继续调用原始函数（允许 DevTools 正常另存为）
      try{return _origSave.apply(this,arguments);}catch(e){}
    };
    window.__QQQ_DIAG.hijackInstalled=true;
  }catch(e){window.__QQQ_DIAG.hijackError=e&&e.message;}
})();

// ── 格式化单条 ConsoleMessage ──
function _fmtMsg(m){
  if(!m)return'';
  // 过滤 DevTools Console 默认不显示的（与右键另存为对齐）
  if(m.level==='verbose')return'';
  if(m.source==='violation'||m.source==='deprecation'||m.source==='recommendation'||m.source==='intervention')return'';
  var lines=[],txt=m.messageText||'';
  var cfs=(m.stackTrace&&m.stackTrace.callFrames)?m.stackTrace.callFrames:[];
  // Network 错误特殊处理：调用栈首帧=源文件位置，m.url=请求URL，m.parameters[0]=HTTP方法
  if(m.source==='network'){
    var nUrl=(m.url||'').replace(/\\\\/g,'/');
    var srcFile='',srcLine=0;
    if(cfs.length>0){var f0=cfs[0];srcFile=((f0.url||'').replace(/\\\\/g,'/').split('/').pop())||f0.url;srcLine=f0.lineNumber||0;}
    if(!srcFile){var uu=(m.url||'').replace(/\\\\/g,'/');srcFile=uu.split('/').pop()||uu;}
    var method='';
    try{var params=m.parameters||[];for(var pi=0;pi<params.length;pi++){var pv=params[pi];if(pv&&typeof pv.value==='string'&&/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(pv.value)){method=pv.value+' ';break;}}}catch(e){}
    // 尝试从 messageText 提取方法（CDP 后端可能把方法嵌在文本里）
    if(!method){var mm=txt.match(/^(GET|POST|PUT|DELETE|PATCH)\s/);if(mm)method=mm[1]+' ';}
    lines.push((srcFile&&srcLine?srcFile+':'+srcLine+' ':'')+method+nUrl+' '+txt);
    for(var ni=0;ni<cfs.length;ni++){
      var ncf=cfs[ni];
      lines.push('    '+(ncf.functionName||'(anonymous)')+' @ '+(((ncf.url||'').replace(/\\\\/g,'/').split('/').pop())||ncf.url)+':'+(ncf.lineNumber||0));
    }
    return lines.join('\\n');
  }
  if(cfs.length>0){
    var f0=cfs[0];
    var fu=((f0.url||'').replace(/\\\\/g,'/').split('/').pop())||f0.url;
    lines.push((fu?fu+':'+(f0.lineNumber||0)+' ':'')+txt);
    for(var i=1;i<cfs.length;i++){
      var cf=cfs[i];
      lines.push('    '+(cf.functionName||'(anonymous)')+' @ '+(((cf.url||'').replace(/\\\\/g,'/').split('/').pop())||cf.url)+':'+(cf.lineNumber||0));
    }
  }else{
    var url=(m.url||'').replace(/\\\\/g,'/'),file=url.split('/').pop()||url,ln=m.line||0;
    lines.push((file&&ln?file+':'+ln+' ':'')+txt);
  }
  return lines.join('\\n');
}

// ── 全量格式化 — 按钮和主进程都调这个 ──
window._qqqGetConsoleText=function(){
  // ① ConsoleModel (最佳: 同右键另存为)
  if(_cm){try{var ms=_cm.messages();if(ms&&ms.length){var total=ms.length,pass=0,skipV=0,skipS=0;var out=[];
    for(var i=0;i<ms.length;i++){var m=ms[i];
      var r=_fmtMsg(ms[i]);
      if(r){out.push(r);pass++;}else{if(m.level==='verbose')skipV++;else skipS++;}
    }
    window.__QQQ_CM_STATS={total:total,pass:pass,skipVerbose:skipV,skipSource:skipS,netCount:0};
    // 计数 network 消息
    try{for(var ni=0;ni<ms.length;ni++){if(ms[ni].source==='network')window.__QQQ_CM_STATS.netCount++;}}catch(e){}
    // ★ 如果过滤后太少（<3 条），dump 前 20 条原始 source+level 供调试
    if(pass<3&&total>0){
      var raw=[];
      for(var ri=0;ri<Math.min(ms.length,20);ri++){var rm=ms[ri];raw.push(ri+':'+rm.source+'/'+rm.level+' t='+(rm.messageText||'').slice(0,60));}
      window.__QQQ_CM_RAW=raw;
    }
    return out.join('\\n\\n');}}catch(e){return'// CM err: '+(e.message||e);}}
  // ② 劫持捕获 (用户触发过一次右键另存为)
  if(window.__QQQ_HIJACK_CONTENT) return window.__QQQ_HIJACK_CONTENT;
  // ③ 主进程 base64 推送 (CDP/console-message 降级)
  if(window.__QQQ_CONSOLE_READY&&window.__QQQ_CONSOLE_B64){
    try{var b=atob(window.__QQQ_CONSOLE_B64),u=new Uint8Array(b.length);for(var j=0;j<b.length;j++)u[j]=b.charCodeAt(j);return new TextDecoder('utf-8').decode(u);}catch(e){return window.__QQQ_CONSOLE_B64;}
  }
  return'';
};

// ── UI ──
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
var e=document.createElement('div');e.id='qqq-dt-toast';
document.body.appendChild(b);document.body.appendChild(e);
document.getElementById('qqq-dt-copy').onclick=function(){
  var t=window._qqqGetConsoleText().replace(/\\n+$/,'').replace(/^\\n+/,'');if(!t){_toast('\\u65E0\\u5185\\u5BB9');return;}
  var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');_toast('\\u5DF2\\u590D\\u5236 '+t.split('\\n').length+'\\u884C');}catch(ex){_toast('\\u5931\\u8D25');}
  document.body.removeChild(ta);
};
document.getElementById('qqq-dt-save').onclick=function(){
  window.__QQQ_CONSOLE_REQUEST_SAVE=true;_toast('\\u6B63\\u5728\\u4FDD\\u5B58...');
};
})();`;

// ── v14.1 _mergedText: 优先注入函数, 兜底 CDP ──
async function _mergedText(wc: WebContents, dwc: WebContents, getText: () => string): Promise<string> {
  // ★ 优先: DevTools 注入的 _qqqGetConsoleText
  try {
    if (!dwc.isDestroyed()) {
      const dtText: string = await dwc.executeJavaScript('window._qqqGetConsoleText&&window._qqqGetConsoleText()');
      if (dtText && typeof dtText === 'string') {
        const lines = dtText.split('\n').filter(Boolean);
        if (lines.length >= 3) return dtText;
      }
    }
  } catch {}
  // 兜底: CDP buffer
  const cdp = getText();
  if (cdp) {
    const cdpLines = cdp.split('\n').filter(Boolean);
    if (cdpLines.length >= 5) return cdp;
  }
  // 最后: renderer __qqq_console_lines
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
  console.log('[devtools-inject] injecting v14.1 buttons (retry probe + hijack save)...');
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
          const text = await _mergedText(wc, dwc, getText);
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

    // ② 诊断: 首轮打印 ConsoleModel + hijack 状态
    if (!_diagLogged) {
      _diagLogged = true;
      try {
        const diag = await dwc.executeJavaScript('window.__QQQ_DIAG&&JSON.stringify(window.__QQQ_DIAG)');
        if (diag) {
          const d = JSON.parse(diag);
          const logLine = '[devtools-inject] diag: probes=' + d.probes +
            ' found=' + d.found + ' path="' + (d.path||'') + '"' +
            ' sdkKeys=[' + (d.sdkKeys||[]).slice(0,15).join(',') + ']' +
            ' uiKeys=[' + (d.uiKeys||[]).slice(0,10).join(',') + ']' +
            ' hijack=' + (d.hijackInstalled?'installed':'FAIL') +
            (d.hasSave!==undefined?' hasSave='+d.hasSave:'') +
            (d.hijackError?' hijackErr='+d.hijackError:'');
          console.log(logLine);
          // 同时写入文件供 AI 读取
          try {
            const outPath = path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-diag.json');
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(d, null, 2), 'utf-8');
            console.log('[devtools-inject] diag written');
            // 同时读取 DevTools 消息结构体信息
            const msgStructs = await dwc.executeJavaScript('window.__QQQ_MSG_STRUCTS&&JSON.stringify(window.__QQQ_MSG_STRUCTS)');
            if (msgStructs) {
              fs.writeFileSync(path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-msg-structs.json'), msgStructs, 'utf-8');
            }
            const panelInfo = await dwc.executeJavaScript('window.__QQQ_PANEL_INFO&&JSON.stringify(window.__QQQ_PANEL_INFO)');
            if (panelInfo) {
              fs.writeFileSync(path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-panel-info.json'), panelInfo, 'utf-8');
            }
            const netMsgs = await dwc.executeJavaScript('window.__QQQ_NET_MSGS&&JSON.stringify(window.__QQQ_NET_MSGS)');
            if (netMsgs) {
              fs.writeFileSync(path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-net-msgs.json'), netMsgs, 'utf-8');
            }
            // ★ v14.3: ConsoleModel 过滤统计 + 原始消息摘要
            const cmStats = await dwc.executeJavaScript('window.__QQQ_CM_STATS&&JSON.stringify(window.__QQQ_CM_STATS)');
            if (cmStats) {
              fs.writeFileSync(path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-cm-stats.json'), cmStats, 'utf-8');
            }
            const cmRaw = await dwc.executeJavaScript('window.__QQQ_CM_RAW&&JSON.stringify(window.__QQQ_CM_RAW)');
            if (cmRaw) {
              fs.writeFileSync(path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-cm-raw.json'), cmRaw, 'utf-8');
            }
          } catch {}
        } else {
          console.log('[devtools-inject] diag: NULL (inject may have failed)');
        }
      } catch {}
    }

    // ③ push base64
    try {
      let text = await _mergedText(wc, dwc, getText);
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
