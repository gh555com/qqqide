// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-mac.ts — 系统默认播放器机器 · macOS 实现（LaunchServices · 2026-10-03 实测定型）
//   语义与 Windows 版（fa-ps.ts）逐项对齐，实现完全异源：
//     ① 扩展名 → UTI：mdls（系统元数据机；含动态 UTI——mkv/rmvb 等第三方格式亦然）
//     ② 读取 = NSWorkspace.URLForApplicationToOpenURL（逐扩展采样文件 → 真实默认 app 路径）
//     ③ 接管 = LSSetDefaultRoleHandlerForContentType(uti, kLSRolesAll(-1), bundleId)
//   ★ 单向可反复（2026-10-03 定案）：无解除逻辑、无状态角标——其他播放器可随时覆盖我们，
//     打勾/取消均无意义；可反复点击重夺默认。
//   落地载体 = osascript（macOS 自带，零编译零安装）执行 JXA（ObjC bridge）；应用注册 = LSRegisterURL。
//   双击链另一端 = main.ts 的 open-file 机器（Finder 双击 → 本 bundle → 播放器宿主）。
//   ★ 实测铁律（2026-10-03 VM 全绿）：角色掩码必须 kLSRolesAll（-1）——传 1（kLSRolesNone？）
//     会写 LSHandlerRoleNone（看似成功实则空转，实测坑）；回读唯一可信 = NSWorkspace
//     （LSCopyDefaultRoleHandlerForContentType 返回值在 JXA 里不可解包——Ref，实测三法全败）。
//   ★ 结果形状与 Windows 版一致（{total, taken, fails}）——UI 零分叉。
// ============================================================================
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BUNDLE_ID = 'com.gh555.qqqide';

/** 当前进程所在 .app bundle（dev/非 bundle 布局 → ''：不做注册，设置将如实失败）。 */
export function macOwnBundlePath(): string {
    const p = String(process.execPath || '').replace(/\\/g, '/');
    const i = p.indexOf('.app/');
    if (i >= 0) { return p.slice(0, i + 4); }
    return '';
}

function _ext(e: string): string { return String(e || '').replace(/^\./, '').toLowerCase(); }

/** 采样文件（每扩展一个空文件——mdls 解析 UTI + NSWorkspace 读默认 app 的锚点；一次创建长期复用） */
function _ensureSamples(exts: string[]): string[] {
    const dir = path.join(os.tmpdir(), 'qqqide-fa');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 让后续步骤如实失败 */ }
    const out: string[] = [];
    for (const e0 of exts) {
        const f = path.join(dir, 'sample.' + _ext(e0));
        try { if (!fs.existsSync(f)) { fs.writeFileSync(f, ''); } } catch { /* ignore */ }
        out.push(f);
    }
    return out;
}

/** mdls 原始调用（多文件输出 = NUL 分隔、顺序与入参一致——实测） */
function _mdlsRaw(files: string[]): Promise<string[]> {
    return new Promise((resolve) => {
        execFile('/usr/bin/mdls', ['-name', 'kMDItemContentType', '-raw'].concat(files), { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
            const raw = String(stdout || '');
            resolve(raw.split('\u0000').map((s) => s.trim()).filter((s) => s.length > 0));
        });
    });
}

/** 逐扩展解析 UTI（批量失败 → 逐文件兜底；'(null)' → 空 = no-uti） */
async function _resolveUtis(files: string[]): Promise<string[]> {
    let vals = await _mdlsRaw(files);
    if (vals.length !== files.length) {
        vals = [];
        for (const f of files) {
            const one = await _mdlsRaw([f]);
            vals.push(one[0] || '');
        }
    }
    return vals.map((v) => (v === '(null)' ? '' : v));
}

function _items(exts: string[], files: string[], utis: string[]): any[] {
    return exts.map((e0, i) => {
        return {
            e: _ext(e0),
            u: utis[i] || '',
            p: files[i],
        };
    });
}

/** 生成 JXA 脚本（纯 ASCII 骨架；路径/清单经 JSON 安全嵌入）。输出行 = 'QFA1' + JSON。 */
function _jxa(items: any[], appPath: string): string {
    return [
        "'use strict';",
        "ObjC.import('CoreServices');",
        "ObjC.import('Foundation');",
        "ObjC.import('AppKit');",
        'var APP = ' + JSON.stringify(appPath) + ';',
        'var M = ' + JSON.stringify(BUNDLE_ID) + ';',
        'var ITEMS = ' + JSON.stringify(items) + ';',
        'var ws = $.NSWorkspace.sharedWorkspace;',
        "function _js(x){ try { return x ? ObjC.unwrap(x) : ''; } catch(e){ return ''; } }",
        "function _cur(p){ try { var u = ws.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(p)); return u ? _js(u.path) : ''; } catch(e){ return ''; } }",
        "function _norm(s){ return String(s || '').replace(/\\/+$/,'').toLowerCase(); }",
        'var ours = _norm(APP);',
        "if (APP) { try { $.LSRegisterURL($.NSURL.fileURLWithPath(APP), true); } catch(e){ } }",
        'var total = ITEMS.length, taken = 0, fails = [];',
        'var i;',
        'for (i = 0; i < total; i++) {',
        "    if (!ITEMS[i].u) { fails.push(ITEMS[i].e + ': no-uti'); continue; }",
        '    var st = -1; try { st = $.LSSetDefaultRoleHandlerForContentType($(ITEMS[i].u), -1, $(M)); } catch(e){ st = -2; }',
        "    if (st !== 0) { fails.push(ITEMS[i].e + ': set=' + st); }",
        '  }',
        "  try { $.NSThread.sleepForTimeInterval(0.35); } catch(e){ }",
        '  for (i = 0; i < total; i++) {',
        '    var c1 = _cur(ITEMS[i].p);',
        '    if (c1 && _norm(c1) === ours) { taken++; }',
        "    else if (ITEMS[i].u) {",
        '      var has = false;',
        "      for (var k = 0; k < fails.length; k++) { if (fails[k].indexOf(ITEMS[i].e + ':') === 0) { has = true; break; } }",
        "      if (!has) { fails.push(ITEMS[i].e + ': not-sticky'); }",
        '    }',
        '  }',
        'var out = JSON.stringify({ ok: true, total: total, taken: taken, fails: fails });',
        "try { $.NSFileHandle.fileHandleWithStandardOutput.writeData($('QFA1' + out + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); } catch(e){ }",
        'void 0;',
    ].join('\n');
}

/** 执行 JXA（osascript）；stdout 中定位 QFA1 行取 JSON。 */
function _runJxa(script: string): Promise<any> {
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) { reject(err); return; }
            const txt = String(stdout || '');
            const i = txt.indexOf('QFA1');
            if (i >= 0) {
                const line = txt.slice(i + 4).split('\n')[0].trim();
                try { const o = JSON.parse(line); if (o && o.ok) { resolve(o); return; } } catch { /* 落底 */ }
            }
            reject(new Error('bad-output:' + txt.slice(0, 200)));
        });
    });
}

export interface FaMacResult { ok: boolean; code?: string; total?: number; taken?: number; fails?: string[]; err?: string; }

async function _run(exts: string[]): Promise<any> {
    const files = _ensureSamples(exts);
    const utis = await _resolveUtis(files);
    return _runJxa(_jxa(_items(exts, files, utis), macOwnBundlePath()));
}

export async function faMacApply(exts: string[]): Promise<FaMacResult> {
    if (process.platform !== 'darwin') { return { ok: false, code: 'unsupported' }; }
    try {
        const r = await _run(exts);
        return { ok: (r.taken || 0) > 0, total: r.total || 0, taken: r.taken || 0, fails: r.fails || [] };
    } catch (e: any) {
        return { ok: false, code: 'apply-failed', err: String((e && e.message) || e).slice(0, 300) };
    }
}

/** A+ 候选注册（编辑器域）：仅把本 bundle 重新登记到 LaunchServices——「打开方式」候选面
 *  来自打包期 Info.plist 的 CFBundleDocumentTypes 声明（LSHandlerRank=Alternate）；
 *  运行期只需刷新注册（绿色包搬家/换目录后重新登记）。不碰系统默认。 */
export async function faMacRegister(): Promise<FaMacResult> {
    if (process.platform !== 'darwin') { return { ok: false, code: 'unsupported' }; }
    const bundle = macOwnBundlePath();
    if (!bundle) { return { ok: false, code: 'no-bundle' }; }
    const script = [
        "'use strict';",
        "ObjC.import('CoreServices');",
        "ObjC.import('Foundation');",
        'var APP = ' + JSON.stringify(bundle) + ';',
        "try { $.LSRegisterURL($.NSURL.fileURLWithPath(APP), true); } catch(e){ }",
        "var out = JSON.stringify({ ok: true, total: 0, taken: 0, fails: [] });",
        "try { $.NSFileHandle.fileHandleWithStandardOutput.writeData($('QFA1' + out + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)); } catch(e){ }",
        'void 0;',
    ].join('\n');
    try {
        await _runJxa(script);
        return { ok: true, total: 0, taken: 0, fails: [] };
    } catch (e: any) {
        return { ok: false, code: 'apply-failed', err: String((e && e.message) || e).slice(0, 300) };
    }
}


