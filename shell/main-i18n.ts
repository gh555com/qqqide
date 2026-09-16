// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// main-i18n.ts — 主进程 i18n 机器（渲染层摸不到的那些串）
//
// 覆盖：boot 加载面板 / boot-fallback 离线页 / 强制更新对话框 / 原生对话框 /
//       主进程错误返回（搜索/终端/gaea/编码）
//
// 语言决议链（与渲染层 i18n.js 同语义）：
//   state('qqq.i18n'.lang) → app.getLocale()（OS 语言）→ 'en' 兜底
// 词条来源：磁盘 locales JSON（Data/webapp → resources/app/webapp → dev server-app），
//   全部缺失 → 内置英文迷你字典（仅覆盖 boot 面板最低限度，保证英文兜底可读）。
//
// ★ 与渲染层 i18n.js 的关系：两运行时无法共享模块（CJS vs 渲染脚本），
//   mapOsLang 语义保持同步——改任一侧必须同改另一侧（i18n.js mapOsLang）。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const ALL_LANGS = ['zh', 'zh-tw', 'en', 'ja', 'de', 'ko', 'ru', 'ar', 'es', 'fr', 'pt-BR', 'hi', 'vi'];

// ── OS 语言映射（与 renderer i18n.js mapOsLang 同步）──
export function mapOsLang(osLang: string | null | undefined): string | null {
    if (!osLang) return null;
    const lang = String(osLang).toLowerCase();
    let mapped: string | null = null;
    if (lang === 'zh-cn' || lang === 'zh-hans' || lang === 'zh-hans-cn') {
        mapped = 'zh';
    } else if (lang === 'zh-tw' || lang === 'zh-hant' || lang === 'zh-hant-tw' || lang === 'zh-hk') {
        mapped = 'zh-tw';
    } else if (lang === 'pt-br') {
        mapped = 'pt-BR';
    } else {
        const prefix = lang.split('-')[0];
        if (ALL_LANGS.indexOf(prefix) !== -1) mapped = prefix;
        else if (prefix === 'zh') mapped = 'zh';
    }
    return (mapped && ALL_LANGS.indexOf(mapped) !== -1) ? mapped : null;
}

let _root: string | null = null;
let _lang: string | null = null;
const _dicts: Record<string, any | null> = {};

// ── 初始化：决议语言（persistedGetter = state('qqq.i18n','lang') 读取器）──
export async function initMainI18n(portableRoot: string, persistedGetter?: () => Promise<any>): Promise<void> {
    _root = portableRoot;
    if (_lang) return;
    let lang: string | null = null;
    if (persistedGetter) {
        try {
            const v = await Promise.race([
                persistedGetter(),
                new Promise((res) => setTimeout(() => res(null), 1500)),
            ]);
            if (v && typeof v === 'string' && ALL_LANGS.indexOf(v) !== -1) lang = v;
        } catch (_) { /* fallthrough */ }
    }
    if (!lang) lang = mapOsLang(app.getLocale()) || 'en';
    _lang = lang;
}

// 后置刷新：state 就绪后重新决议一次（boot 面板出现前调用）
export async function refreshMainI18nLang(persistedGetter: () => Promise<any>): Promise<void> {
    const old = _lang;
    _lang = null;
    await initMainI18n(_root || '', persistedGetter);
    if (!_lang) _lang = old;
}

function _dictDirs(): string[] {
    const dirs: string[] = [];
    if (_root) {
        dirs.push(path.join(_root, 'Data', 'webapp', 'locales'));
        dirs.push(path.join(_root, 'resources', 'app', 'webapp', 'locales'));
        dirs.push(path.join(_root, 'resources', 'app', 'server-app', 'locales'));
        dirs.push(path.join(_root, 'server-app', 'locales'));
    }
    try {
        const ap = app.getAppPath();
        dirs.push(path.join(ap, 'webapp', 'locales'));
        dirs.push(path.join(ap, 'server-app', 'locales'));
    } catch (_) { /* ignore */ }
    return dirs;
}

function _loadDict(lang: string): any | null {
    if (lang in _dicts) return _dicts[lang];
    let out: any = null;
    for (const d of _dictDirs()) {
        try {
            const p = path.join(d, lang + '.json');
            if (fs.existsSync(p)) { out = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
        } catch (_) { /* try next */ }
    }
    _dicts[lang] = out;
    return out;
}

function _get(obj: any, key: string): string | null {
    if (!obj || !key) return null;
    const keys = key.split('.');
    let cur = obj;
    for (const k of keys) {
        if (cur === null || cur === undefined) return null;
        cur = cur[k];
    }
    return (typeof cur === 'string') ? cur : null;
}

// ── 内置英文迷你字典（全部词条文件缺失时的最后兜底；仅覆盖 boot 面板关键串）──
const EN_MINI: Record<string, string> = {
    'main.boot.firstBoot': 'Starting…',
    'main.boot.connecting': 'Connecting to server…',
    'main.boot.parsing': 'Parsing page…',
    'main.boot.structure': 'Loading page structure…',
    'main.boot.scripts': 'Loading component scripts…',
    'main.boot.styles': 'Loading style resources…',
    'main.boot.init': 'Initializing IDE…',
    'main.boot.starting': 'Starting IDE…',
    'main.boot.almost': 'Almost done…',
    'main.boot.noServer': 'Unable to reach the server. The network may be down or the server is not ready.',
    'main.boot.retry': 'Retry Now',
    'main.boot.portableHint': 'Shell stays portable. All data is written only into the app directory.',
    'main.boot.firstWait': 'The first connection may take a moment…',
    'main.boot.reason': 'Reason: {r}',
    'main.boot.retrying': 'Retrying…',
    'main.boot.stillFail': 'Still unable to connect. Please try again later…',
    'main.boot.retryFail': 'Retry failed: {e}',
};

// ── 主进程取词入口 ──
export function mi(key: string, params?: Record<string, any>): string {
    if (!_lang) { _lang = mapOsLang(app.getLocale()) || 'en'; }
    let txt = _get(_loadDict(_lang), key);
    if (txt === null && _lang !== 'en') txt = _get(_loadDict('en'), key);
    if (txt === null) txt = EN_MINI[key] || null;
    if (txt === null) return key;
    if (params) {
        for (const k of Object.keys(params)) {
            txt = txt.split('{' + k + '}').join(String(params[k]));
        }
    }
    return txt;
}

// 供 boot-fallback 页注入用：一次取一组键（值缺失回落 key）
export function miDict(keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of keys) out[k] = mi(k);
    return out;
}

export function getMainLang(): string {
    if (!_lang) { _lang = mapOsLang(app.getLocale()) || 'en'; }
    return _lang;
}
