// ============================================================================
// devtools-inject.ts — DevTools Console 悬浮按钮（复制 / 另存为）
//
// v14.5: 递归栈帧展开 + HTTP方法精确提取 + 参数拼接 + ConsoleModel 无条件信任
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

window.__QQQ_DIAG = { probes: 0, found: false, path: '', sdkKeys: [], uiKeys: [] };

// ── 重试探针 ──
var _cm=null,_cmPath='',_probes=0;
function _probeOnce(){
  _probes++; window.__QQQ_DIAG.probes=_probes;
  function _hasMsgs(o){try{var m=o.messages();return Array.isArray(m)&&m.length>0;}catch(e){return false;}}
  if(_probes===1){
    try{window.__QQQ_DIAG.sdkKeys=Object.keys(self.SDK||{});}catch(e){}
    try{window.__QQQ_DIAG.uiKeys=Object.keys(self.UI||{});}catch(e){}
    try{window.__QQQ_DIAG.hasSave=typeof InspectorFrontendHost.save==='function';}catch(e){}
  }
  try{if(self.SDK&&self.SDK.consoleModel&&_hasMsgs(self.SDK.consoleModel)){_cm=self.SDK.consoleModel;_cmPath='SDK.consoleModel';}}catch(e){}
  if(!_cm)try{for(var k in self.SDK){try{if(self.SDK[k]&&self.SDK[k].consoleModel&&_hasMsgs(self.SDK[k].consoleModel)){_cm=self.SDK[k].consoleModel;_cmPath='SDK.'+k+'.consoleModel';break;}}catch(e){}}}catch(e){}
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
    _dumpMsgStructs(); _dumpNetMsg(); _dumpPanelStruct();
    return;
  }
  window.__QQQ_CM_FOUND=false;
  if(_probes<60) setTimeout(_probeOnce, 500);
}

function _dumpMsgStructs(){
  try{
    var ms=_cm.messages(); var structs=[];
    for(var i=0;i<Math.min(ms.length,10);i++){
      var m=ms[i],keys=[],vals={};
      try{for(var k in m){try{keys.push(k);var v=m[k];vals[k]=typeof v==='string'?v.slice(0,120):typeof v==='number'?v:typeof v==='boolean'?v:typeof v==='object'?(Array.isArray(v)?'Array['+v.length+']':'Object{'+Object.keys(v||{}).join(',')+'}'):typeof v;}catch(e){}}}catch(e){}
      structs.push({i:i,source:m.source,level:m.level,keys:keys.slice(0,25),vals:vals,rawText:(m.messageText||'').slice(0,150)});
    }
    window.__QQQ_MSG_STRUCTS=structs;
  }catch(e){window.__QQQ_MSG_STRUCTS=['err: '+(e.message||e)];}
}

function _dumpPanelStruct(){
  try{
    var info={};
    if(self.UI&&self.UI.inspectorView){try{info._panels=Object.keys(self.UI.inspectorView._panels||{}).join(',');}catch(e){}}
    try{var cp=self.UI.panels&&self.UI.panels.console;if(cp){info.consolePanel=true;}}catch(e){}
    window.__QQQ_PANEL_INFO=info;
  }catch(e){window.__QQQ_PANEL_INFO=['err: '+(e.message||e)];}
}

function _dumpNetMsg(){
  try{
    var ms=_cm.messages(),nets=[];
    for(var i=0;i<ms.length;i++){
      var m=ms[i]; if(m.source!=='network')continue;
      var p=[];
      try{var params=m.parameters||[];for(var j=0;j<params.length;j++)p.push({t:typeof params[j].value,v:(params[j].value||'').slice(0,80)});}catch(e){}
      nets.push({i:i,text:(m.messageText||'').slice(0,200),url:(m.url||'').slice(0,200),line:m.line,params:p,hasCfs:!!(m.stackTrace&&m.stackTrace.callFrames&&m.stackTrace.callFrames.length)});
      if(nets.length>=10)break;
    }
    window.__QQQ_NET_MSGS=nets;
  }catch(e){window.__QQQ_NET_MSGS=['err: '+(e.message||e)];}
}

_probeOnce();

// ── Hijack save ──
(function(){
  try{
    if(!InspectorFrontendHost||!InspectorFrontendHost.save) return;
    var _os=InspectorFrontendHost.save;
    InspectorFrontendHost.save=function(url,content,forceSaveAs){
      if(typeof content==='string'&&content.length>10){window.__QQQ_HIJACK_CONTENT=content;window.__QQQ_HIJACK_TS=Date.now();}
      try{return _os.apply(this,arguments);}catch(e){}
    };
    window.__QQQ_DIAG.hijackInstalled=true;
  }catch(e){window.__QQQ_DIAG.hijackError=e&&e.message;}
})();

// ── _fmtMsg — 核心格式化 ──
function _fmtMsg(m){
  if(!m)return'';
  if(m.level==='verbose')return'';
  if(m.source==='violation'||m.source==='deprecation'||m.source==='recommendation'||m.source==='intervention')return'';
  var txt=m.messageText||'';
  // 拼接所有参数
  try{var pm=m.parameters||[];for(var pi=1;pi<pm.length;pi++){var pv=pm[pi];var pvs=typeof pv.value==='string'?pv.value:typeof pv==='string'?pv:'';if(pvs)txt+=' '+pvs;}}catch(e){}
  // 递归展开栈帧（parent 链含异步帧）
  function _flat(st){var a=[];if(!st)return a;a=(st.callFrames||[]).slice();if(st.parent){var pa=_flat(st.parent);for(var x=0;x<pa.length;x++)a.push(pa[x]);}return a;}
  var cfs=_flat(m.stackTrace);
  var lines=[];

  if(m.source==='network'){
    var nUrl=(m.url||'').replace(/\\\\/g,'/');
    // ★ HTTP 方法: 三路探测
    var method='';
    // A: cfs[0].functionName（XHR 场景，首帧即 'GET'/'POST'）
    if(!method&&cfs.length>0){var fn0=(cfs[0].functionName||'').toUpperCase();if(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(fn0))method=fn0+' ';}
    // B: m.parameters — fetch(url, {method:'POST'}) 场景
    if(!method){try{var _pm=m.parameters||[];for(var _pi=0;_pi<_pm.length;_pi++){var _v=_pm[_pi],_vs=typeof _v.value==='string'?_v.value:typeof _v==='string'?_v:'';
      if(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(_vs)){method=_vs.toUpperCase()+' ';break;}
      // 参数对象中包含 "method":"POST"
      try{if(_vs.indexOf('method')!==-1){var _mm=_vs.match(/"method"\\s*:\\s*"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)"/i);if(_mm){method=_mm[1].toUpperCase()+' ';break;}}}catch(e){}
    }}catch(e){}}
    // C: messageText 开头
    if(!method){var _mt=txt.match(/^(GET|POST|PUT|DELETE|PATCH)\\s/);if(_mt)method=_mt[1]+' ';}
    // D: 兜底推断（/api/ 路径多为 POST）
    if(!method)method=/\/api\//i.test(nUrl)?'POST ':'GET ';

    // 源文件帧: 跳过帧名为 HTTP 方法的帧
    var srcFile='',srcLine=0;
    for(var _fi=0;_fi<cfs.length;_fi++){
      var _ffn=(cfs[_fi].functionName||'').toUpperCase();
      var _furl=((cfs[_fi].url||'').replace(/\\\\/g,'/').split('/').pop())||cfs[_fi].url||'';
      if(!/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(_ffn)&&_furl&&!_furl.startsWith('VM')){srcFile=_furl;srcLine=cfs[_fi].lineNumber||0;break;}
    }
    if(!srcFile&&cfs.length>0){var _fz=cfs[cfs.length-1];srcFile=((_fz.url||'').replace(/\\\\/g,'/').split('/').pop())||_fz.url||'';srcLine=_fz.lineNumber||0;}

    // 清洗文本: 不同错误类型不同格式
    var cleanTxt=txt;
    if(/^Failed to load resource:\\s*/i.test(txt)){cleanTxt=txt.replace(/^Failed to load resource:\\s*/i,'');}
    else{var _sc=txt.match(/status of\\s+(\\d+)/i);if(_sc)cleanTxt=_sc[1];}

    lines.push((srcFile&&srcLine?srcFile+':'+srcLine+'          ':'')+method+nUrl+' '+cleanTxt);
    for(var ni=0;ni<cfs.length;ni++){
      var nc=cfs[ni];
      lines.push('    '+(nc.functionName||'(anonymous)')+' @ '+(((nc.url||'').replace(/\\\\/g,'/').split('/').pop())||nc.url)+':'+(nc.lineNumber||0));
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
    var uu=(m.url||'').replace(/\\\\/g,'/'),file=uu.split('/').pop()||uu,ln=m.line||0;
    lines.push((file&&ln?file+':'+ln+' ':'')+txt);
  }
  return lines.join('\\n');
}

// ── 全量导出 ──
window._qqqGetConsoleText=function(){
  if(_cm){try{var ms=_cm.messages();if(ms&&ms.length){
    var out=[],pass=0,skipV=0,skipS=0;
    for(var i=0;i<ms.length;i++){
      var r=_fmtMsg(ms[i]);
      if(r){out.push(r);pass++;}else{if(ms[i].level==='verbose')skipV++;else skipS++;}
    }
    window.__QQQ_CM_STATS={total:ms.length,pass:pass,skipVerbose:skipV,skipSource:skipS};
    if(pass<3&&ms.length>0){var raw=[];for(var ri=0;ri<Math.min(ms.length,20);ri++){var rm=ms[ri];raw.push(ri+':'+rm.source+'/'+rm.level+' t='+(rm.messageText||'').slice(0,60));}window.__QQQ_CM_RAW=raw;}
    return out.join('\\n\\n');
  }}catch(e){return'// CM err: '+(e.message||e);}}
  if(window.__QQQ_HIJACK_CONTENT) return window.__QQQ_HIJACK_CONTENT;
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

// ── _mergedText ──
async function _mergedText(wc: WebContents, dwc: WebContents, getText: () => string): Promise<string> {
  try {
    if (!dwc.isDestroyed()) {
      const cmFound = await dwc.executeJavaScript('!!window.__QQQ_CM_FOUND');
      const dtText: string = await dwc.executeJavaScript('window._qqqGetConsoleText&&window._qqqGetConsoleText()');
      if (dtText && typeof dtText === 'string' && (cmFound || dtText.split('\n').filter(Boolean).length >= 3)) {
        return dtText;
      }
    }
  } catch {}
  const cdp = getText();
  if (cdp) {
    const cdpLines = cdp.split('\n').filter(Boolean);
    if (cdpLines.length >= 5) return cdp;
  }
  const parts: string[] = [];
  try {
    const r = await wc.executeJavaScript('((window.top||window).__qqq_console_lines||[]).join("\\n")');
    if (r) parts.push(r);
  } catch {}
  if (cdp) parts.push(cdp);
  return parts.join('\n');
}

export function injectDevToolsConsoleButtons(dwc: WebContents, wc: WebContents, getText: () => string, mw: BrowserWindow): void {
  if (dwc.isDestroyed()) return;
  console.log('[devtools-inject] injecting v14.5 buttons...');
  dwc.executeJavaScript(INJECT_JS)
    .then(() => { _startPushLoop(wc, dwc, getText, mw); })
    .catch((err: any) => { console.log('[devtools-inject] inject failed:', err?.message || err); });
}

function _startPushLoop(wc: WebContents, dwc: WebContents, getText: () => string, mw: BrowserWindow): void {
  if (_pushTimer) clearInterval(_pushTimer);
  _pushTimer = setInterval(async () => {
    if (dwc.isDestroyed() || wc.isDestroyed()) { if (_pushTimer) { clearInterval(_pushTimer); _pushTimer = null; } return; }

    try {
      const ws = await dwc.executeJavaScript('!!window.__QQQ_CONSOLE_REQUEST_SAVE');
      if (ws && !_saveLock) {
        _saveLock = true;
        dwc.executeJavaScript('window.__QQQ_CONSOLE_REQUEST_SAVE=false').catch(() => {});
        try {
          const text = await _mergedText(wc, dwc, getText);
          if (!text) { _saveLock = false; return; }
          let pr = ''; try { pr = await wc.executeJavaScript('(window._workspaceRoot||"")'); } catch {}
          const now = new Date();
          const p = (n: number) => n < 10 ? '0' + n : '' + n;
          const ts = now.getFullYear()+'-'+p(now.getMonth()+1)+'-'+p(now.getDate())+'_'+p(now.getHours())+'-'+p(now.getMinutes())+'-'+p(now.getSeconds());
          const defPath = pr ? path.join(pr, 'logs', 'console_'+ts+'.log') : 'console_'+ts+'.log';
          const result = await dialog.showSaveDialog(mw, { title: '保存控制台日志', defaultPath: defPath, filters: [{ name: '日志文件', extensions: ['log'] }] });
          if (!result.canceled && result.filePath) { fs.mkdirSync(path.dirname(result.filePath), { recursive: true }); fs.writeFileSync(result.filePath, text, 'utf-8'); }
        } catch {}
        _saveLock = false;
      }
    } catch {}

    if (!_diagLogged) {
      _diagLogged = true;
      try {
        const diag = await dwc.executeJavaScript('window.__QQQ_DIAG&&JSON.stringify(window.__QQQ_DIAG)');
        if (diag) {
          const d = JSON.parse(diag);
          try {
            const outPath = path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-diag.json');
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(d, null, 2), 'utf-8');
            const keys = ['MSG_STRUCTS','PANEL_INFO','NET_MSGS','CM_STATS','CM_RAW'];
            for (const k of keys) {
              try {
                const v = await dwc.executeJavaScript('window.__QQQ_'+k+'&&JSON.stringify(window.__QQQ_'+k+')');
                if (v) fs.writeFileSync(path.join('E:/s/wol/py/qqq-shell-v2/qqq/logs', 'devtools-'+k.toLowerCase().replace(/_/g,'-')+'.json'), v, 'utf-8');
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }

    try {
      let text = await _mergedText(wc, dwc, getText);
      if (!text) text = '';
      if (text.length > 2 * 1024 * 1024) { text = '...(truncated from start)\\n' + text.slice(-2 * 1024 * 1024); }
      const b64 = Buffer.from(text, 'utf-8').toString('base64');
      if (b64.length < 50 * 1024 * 1024) { dwc.executeJavaScript('window.__QQQ_CONSOLE_B64="'+b64+'";window.__QQQ_CONSOLE_READY=true').catch(() => {}); }
    } catch {}
  }, 2000);
  if (_pushTimer && typeof _pushTimer === 'object' && 'unref' in _pushTimer) (_pushTimer as any).unref();
}
