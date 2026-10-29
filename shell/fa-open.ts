// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-open.ts — 外部「打开文件」链 · IDE 侧投递机（--qqqide-open / mac open-file 文本分流）
//   入口（main.ts）：冷启 argv（双击文本/代码 = --qqqide-open）· second-instance 转发 ·
//   mac open-file 文本分流。语义：按扩展分流——媒体 → 播放器宿主（requests/ 队列）；
//   文本/代码 → 编辑器窗（window.qqqTabs.openFile 投递，打开链另一端）。
//   就绪门控：主窗/渲染层未就绪（冷启早期 qqqTabs 未定义）→ 队列 + 1.2s 重试（预算 ~60s），
//   全部投出即清队；超预算如实 warn（禁静默丢文件）。重试期间重复投递无害（openFile 已有
//   标签 → 激活，幂等）。选窗/置前 = player-host 同源（唯一实现，禁第二套）。
// ============================================================================
import { BrowserWindow } from 'electron';
import { classifyExternalFiles } from './fa-editor';
import { queuePlayerRequest, filesToItems, focusMainWindow, pickMainWindow, focusedMainWindowId, lastFocusedMainWindowId } from './player-host';

const RETRY_MS = 1200;
const BUDGET_MS = 60000;
const PER_FILE_TIMEOUT_MS = 4000;

let _pending: string[] = [];
let _timer: any = null;
let _deadline = 0;
let _delivering = false;
// ★ 投递目标（发起时刻捕获）：多窗场景下「投到哪个窗」不能等到真正投递再算——
//   second-instance 到场后焦点会被抢（旧行为直指第一个窗），异步投递时聚焦信号已失真。
//   捕获序 = 当场聚焦主窗 → 最后聚焦主窗（无主窗聚焦时，用户刚离开的就是它）。
let _targetId: number | null = null;

/** 入口：把一批「外部打开」文件按域路由（媒体→播放器宿主队列；文本→编辑器窗投递）。 */
export function routeExternalOpen(files: string[]): void {
    const list = (files || []).filter((f) => !!f && typeof f === 'string');
    if (!list.length) { return; }
    const split = classifyExternalFiles(list);
    if (split.media.length) {
        try { queuePlayerRequest('open', { list: filesToItems(split.media), index: 0, play: true, external: true }, 0); }
        catch (e: any) { console.warn('[fa-open] player queue err: ' + ((e && e.message) || e)); }
    }
    if (split.text.length) { _enqueueEditor(split.text); }
}

function _enqueueEditor(files: string[]): void {
    if (_targetId == null) {
        const fid = focusedMainWindowId();
        _targetId = (fid != null) ? fid : lastFocusedMainWindowId();
    }
    for (const f of files) { if (_pending.indexOf(f) < 0) { _pending.push(f); } }
    if (!_deadline) { _deadline = Date.now() + BUDGET_MS; }
    if (!_timer && !_delivering) {
        _timer = setTimeout(() => { _timer = null; void _tryDeliver(); }, 0);
    }
}

async function _tryDeliver(): Promise<void> {
    if (_delivering) { return; }
    if (!_pending.length) { _deadline = 0; _targetId = null; return; }
    _delivering = true;
    let progressed = false;
    try {
        const batch = _pending.slice();
        const okAll = await _deliverBatch(batch);
        if (okAll) {
            _pending = _pending.filter((f) => batch.indexOf(f) < 0);
            progressed = true;
        }
    } catch (e: any) {
        console.warn('[fa-open] deliver err: ' + ((e && e.message) || e));
    }
    _delivering = false;
    if (!_pending.length) { _deadline = 0; _targetId = null; return; }
    if (Date.now() > _deadline) {
        console.warn('[fa-open] editor open timeout, dropped=' + _pending.length + ' :: ' + _pending.slice(0, 4).join(' | '));
        _pending = [];
        _deadline = 0;
        _targetId = null;
        return;
    }
    if (_timer) { clearTimeout(_timer); }
    _timer = setTimeout(() => { _timer = null; void _tryDeliver(); }, progressed ? 0 : RETRY_MS);
}

async function _deliverBatch(files: string[]): Promise<boolean> {
    const win = pickMainWindow(_targetId);   // 选窗权威 = player-reveal.pickOpenTargetId（唯一实现）
    if (!win) { return false; }
    focusMainWindow(win);
    for (const f of files) {
        const ok = await _deliverOne(win, f);
        if (!ok) { return false; }   // 渲染层未就绪 → 整批下轮重试（幂等）
    }
    return true;
}

function _deliverOne(win: BrowserWindow, filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
        try {
            const code = '(function(){ try { if (window.qqqTabs && window.qqqTabs.openFile) { window.qqqTabs.openFile('
                + JSON.stringify(filePath) + '); return true; } return false; } catch (e) { return false; } })()';
            Promise.resolve(win.webContents.executeJavaScript(code)).then((r: any) => done(r === true), () => done(false));
            setTimeout(() => done(false), PER_FILE_TIMEOUT_MS);   // 渲染层忙 → 本轮弃等，下轮重试
        } catch { done(false); }
    });
}
