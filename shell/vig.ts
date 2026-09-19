// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// vig.ts — 履历（Vig）采集机（老 q3 global.js `_collectVig` 100% 语义移植）
//
// 职责:
//   1. 本地持久化各功能使用统计（跨重启累计）→ {Data}/alphal/vig.json
//      （tmp+rename 原子写 + 800ms 防抖）
//   2. wq-ping.ts 每次 ping 取 vigSnapshot() 塞入 body.vig（搭便车上报）
//   3. 渲染层埋点经 IPC qqqide:vig:bump / qqqide:vig:set（ipc-vig.ts）
//
// 数据模型（与服务端 wq.device_vig 扁平列一一对应）:
//   savor/savor_radio { n, ms, t0 }
//   paste             { n, b, t0 }
//   roam              { n, f, fc, q, w, x, k, t0 }
//   export_doc/export_zip { n, t0 }
//   card              { times, count }   ← count 由 wq-ping 动态从 kope 读取回写
//   cache             { hit, miss }
//   squad             { '1'..'x': n }     ← 键 = 编队槽位字符；上报为 c 数组（8 槽位固定顺序）
//
// 语义铁律（老项目对齐）:
//   · 全量快照不是增量上报——本地只负责累加，幂等覆盖交给服务端 UPSERT
//   · t0 = 首次使用 Unix 秒，只在首次写入时落值（此后永不改）
//   · 上报格式只含"发生过"的模块（n>0 才出现——老 _collectVig 语义）
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, getOsBaseDir } from './portable-paths';

type Bag = Record<string, number>;
type VigStore = Record<string, Bag>;

const SAVE_DEBOUNCE_MS = 800;
const MAX_N = 1_000_000;          // 协议上限（老 clamp 口径）
const MAX_BIG = Number.MAX_SAFE_INTEGER;

// 模块白名单（组协议 2.3 字段矩阵）
const MODS_SIMPLE_N = ['savor', 'savor_radio', 'paste', 'video', 'export_doc', 'export_zip', 'pure'] as const;
const MOD_OPTIONAL_KEYS: Record<string, string[]> = {
  savor: ['ms'],
  savor_radio: ['ms'],
  paste: ['b'],
  video: ['b'],
  roam: ['f', 'fc', 'q', 'w', 'x', 'k'],
};

let _vig: VigStore | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;

function _file(): string {
  return path.join(getDataDir(), 'alphal', 'vig.json');
}

function _empty(): VigStore {
  return {
    savor: { n: 0, ms: 0, t0: 0 },
    savor_radio: { n: 0, ms: 0, t0: 0 },
    paste: { n: 0, b: 0, t0: 0 },
    video: { n: 0, b: 0, t0: 0 },
    roam: { n: 0, f: 0, fc: 0, q: 0, w: 0, x: 0, k: 0, t0: 0 },
    export_doc: { n: 0, t0: 0 },
    export_zip: { n: 0, t0: 0 },
    pure: { n: 0, t0: 0 },
    card: { times: 0, count: 0 },
    cache: { hit: 0, miss: 0 },
    squad: {},
  };
}

function _load(): VigStore {
  if (_vig) return _vig;
  let disk: any = null;
  try { disk = JSON.parse(fs.readFileSync(_file(), 'utf8')); } catch { /* first run */ }
  const base = _empty();
  if (disk && typeof disk === 'object') {
    for (const mod of Object.keys(disk)) {
      const src = disk[mod];
      if (!src || typeof src !== 'object') continue;
      if (!base[mod]) base[mod] = {};
      for (const k of Object.keys(src)) {
        const v = Number(src[k]);
        if (Number.isFinite(v) && v >= 0) base[mod][k] = Math.floor(v);
      }
    }
  }
  _vig = base;
  return _vig;
}

/** 立即落盘（原子 tmp+rename）。退出/低频场景可直接调；常规埋点走防抖。 */
export function vigFlush(): void {
  if (!_vig) return;
  const fp = _file();
  const tmp = fp + '.tmp';
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_vig), 'utf8');
    fs.renameSync(tmp, fp);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function _saveSoon(): void {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    vigFlush();
  }, SAVE_DEBOUNCE_MS);
  try { if (_timer && (_timer as any).unref) { (_timer as any).unref(); } } catch { /* ignore */ }
}

function _clampKey(k: string, v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (k === 'ms' || k === 'b') return Math.min(Math.floor(v), MAX_BIG);
  if (k === 'hit' || k === 'miss') return Math.min(Math.floor(v), 10_000_000);
  return Math.min(Math.floor(v), MAX_N);
}

/** 增量累加（n/fc/f/q/w/x/k/hit/miss/times 等一切计数）；t0 首次自动落值。 */
export function vigBump(mod: string, add: Record<string, number>): void {
  if (!mod || !add || typeof add !== 'object') return;
  const v = _load();
  if (!v[mod]) v[mod] = {};
  const bag = v[mod];
  const nowSec = Math.floor(Date.now() / 1000);
  if (!bag.t0 || bag.t0 <= 0) bag.t0 = nowSec;
  for (const k of Object.keys(add)) {
    if (k === 't0') continue;
    bag[k] = _clampKey(k, (Number(bag[k]) || 0) + (Number(add[k]) || 0));
  }
  _saveSoon();
}

/** 覆盖合并（savor 统计镜像 / card.count 动态回写——全量值语义）。
 *  patch 显式携带合法 t0（来自 savor firstUse 等权威值）→ 采信写入；否则首写保护。 */
export function vigSet(mod: string, patch: Record<string, number>): void {
  if (!mod || !patch || typeof patch !== 'object') return;
  const v = _load();
  if (!v[mod]) v[mod] = {};
  const bag = v[mod];
  const nowSec = Math.floor(Date.now() / 1000);
  if (!bag.t0 || bag.t0 <= 0) bag.t0 = nowSec;
  for (const k of Object.keys(patch)) {
    if (k === 't0') {
      const t0 = Number(patch[k]);
      if (Number.isFinite(t0) && t0 >= 1577836800 && t0 <= nowSec) { bag.t0 = Math.floor(t0); }
      continue;
    }
    bag[k] = _clampKey(k, Number(patch[k]) || 0);
  }
  _saveSoon();
}

// ── 窗口编队召回（squad）────────────────────────────────────────────────────
// 计数点 = 主进程 summon 事件（py-broker 热键召回成功 ev.ok=true；槽位=ev.squad）；
// 「已在前台」不算成功（py-broker 侧 ok=false），与音效同条件。
export const SQUAD_SLOTS = ['1', '2', 'q', 'w', 'a', 's', 'z', 'x'] as const;

/** 记一次编队召回成功（槽位非法忽略）。 */
export function vigSquadSummon(slot: string): void {
  if (!(SQUAD_SLOTS as readonly string[]).includes(slot)) { return; }
  vigBump('squad', { [slot]: 1 });
}

/** 构建上报快照（老 _collectVig 语义：n>0 才出现；可选字段 >0 才带）。无数据返回 null。 */
export function vigSnapshot(): Record<string, any> | null {
  const v = _load();
  const out: Record<string, any> = {};

  for (const mod of MODS_SIMPLE_N) {
    const bag = v[mod] || {};
    const n = Number(bag.n) || 0;
    if (n <= 0) continue;
    const item: Record<string, number> = { n: _clampKey('n', n) };
    for (const ok of (MOD_OPTIONAL_KEYS[mod] || [])) {
      const val = Number(bag[ok]) || 0;
      if (val > 0) item[ok] = _clampKey(ok, val);
    }
    if (bag.t0 > 0) item.t0 = bag.t0;
    out[mod] = item;
  }

  // roam 独立（含键盘/文件操作字段）
  {
    const bag = v.roam || {};
    const n = Number(bag.n) || 0;
    const touch = n > 0 || ['f', 'fc', 'q', 'w', 'x', 'k'].some((k) => (Number(bag[k]) || 0) > 0);
    if (touch) {
      const item: Record<string, number> = { n: _clampKey('n', n) };
      for (const ok of ['f', 'fc', 'q', 'w', 'x', 'k']) {
        const val = Number(bag[ok]) || 0;
        if (val > 0) item[ok] = _clampKey(ok, val);
      }
      if (bag.t0 > 0) item.t0 = bag.t0;
      out.roam = item;
    }
  }

  // squad（窗口编队召回）: c = 8 槽位固定顺序数组 [1,2,q,w,a,s,z,x]，n = 召回总数
  {
    const bag = v.squad || {};
    const c = SQUAD_SLOTS.map((s) => _clampKey('n', Number(bag[s]) || 0));
    const n = c.reduce((a, b) => a + b, 0);
    if (n > 0) {
      const item: Record<string, any> = { n, c };
      if (bag.t0 > 0) { item.t0 = bag.t0; }
      out.squad = item;
    }
  }

  // card / cache（独立结构）
  {
    const c = v.card || {};
    const times = Number(c.times) || 0, count = Number(c.count) || 0;
    if (times > 0 || count > 0) out.card = { times: _clampKey('times', times), count: _clampKey('times', count) };
  }
  {
    const c = v.cache || {};
    const hit = Number(c.hit) || 0, miss = Number(c.miss) || 0;
    if (hit > 0 || miss > 0) out.cache = { hit: _clampKey('hit', hit), miss: _clampKey('miss', miss) };
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ── window-there 外部履历（OS 级 stats.json，由 goods 进程独立写入）──────────
// 3W 保存 / 3X 还原 / 布局总数 —— ping 时动态读回（同 card.count 动态回读模式；
// 计数真理源在 %LOCALAPPDATA%/window-there/stats.json，跨实例/跨绿色包共享）
export function winthereExternal(): Record<string, number> | null {
  try {
    const p = path.join(getOsBaseDir(), 'window-there', 'stats.json');
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    const save = Math.min(Math.max(0, Math.floor(Number(d.save) || 0)), MAX_N);
    const restore = Math.min(Math.max(0, Math.floor(Number(d.restore) || 0)), MAX_N);
    const layouts = Math.min(Math.max(0, Math.floor(Number(d.layouts) || 0)), MAX_N);
    if (save <= 0 && restore <= 0 && layouts <= 0) return null;
    const out: Record<string, number> = { save, restore, layouts };
    const t0 = Math.floor(Number(d.t0) || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (t0 >= 1577836800 && t0 <= nowSec) out.t0 = t0;   // 与服务端 clampT0 同语义：未来时间戳丢弃
    return out;
  } catch { return null; }
}
