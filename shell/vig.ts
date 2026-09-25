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
import { promises as fsp } from 'fs';
import * as path from 'path';
import { getDataDir, getOsBaseDir } from './portable-paths';

type Bag = Record<string, number>;
type VigStore = Record<string, Bag>;

const SAVE_DEBOUNCE_MS = 800;
const MAX_N = 1_000_000;          // 协议上限（老 clamp 口径）
const MAX_BIG = Number.MAX_SAFE_INTEGER;
const FLOORS_MAX_ROOTS = 500;     // floors per-root 计数上限（root 数，防 vig.json 无界膨胀）

// 模块白名单（组协议 2.3 字段矩阵）
const MODS_SIMPLE_N = ['savor', 'savor_radio', 'paste', 'video', 'export_doc', 'export_zip', 'pure', 'byok', 'free'] as const;
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
  // ★ floors 复合结构专项装载（t 数组 / m per-root 映射 / s 播种标记——通用 Number 合并不适用）
  try {
    const df: any = disk && (disk as any).floors;
    const fb: any = { t0: 0, t: [0, 0, 0], m: {}, s: [] };
    if (df && typeof df === 'object') {
      const t0n = Number(df.t0);
      if (Number.isFinite(t0n) && t0n >= 0) fb.t0 = Math.floor(t0n);
      if (Array.isArray(df.t)) {
        for (let i = 0; i < 3; i++) {
          const n = Number(df.t[i]);
          if (Number.isFinite(n) && n > 0) fb.t[i] = Math.floor(n);
        }
      }
      if (df.m && typeof df.m === 'object') {
        for (const k of Object.keys(df.m)) {
          const n = Number(df.m[k]);
          if (!Number.isFinite(n) || n <= 0) continue;
          if (Object.keys(fb.m).length >= FLOORS_MAX_ROOTS) break;
          fb.m[k] = Math.floor(n);
        }
      }
      if (Array.isArray(df.s)) {
        for (const x of df.s) { if (typeof x === 'string' && x && fb.s.length < FLOORS_MAX_ROOTS) fb.s.push(x); }
      }
    }
    (base as any).floors = fb;
  } catch { /* ignore */ }
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

  // floors（总楼层：n = 全史合计 Σ per-root 计数；t = 等级直方 [1级,2级,3级] 仅正向楼层可知）
  {
    const bag: any = (v as any).floors || {};
    const m = (bag.m && typeof bag.m === 'object') ? bag.m : {};
    let n = 0;
    for (const k of Object.keys(m)) { n += (Number(m[k]) || 0); }
    if (n > 0) {
      const item: Record<string, any> = { n: _clampKey('n', n) };
      const t = Array.isArray(bag.t) ? bag.t : [];
      const t3 = [_clampKey('n', Number(t[0]) || 0), _clampKey('n', Number(t[1]) || 0), _clampKey('n', Number(t[2]) || 0)];
      if (t3[0] + t3[1] + t3[2] > 0) item.t = t3;
      if (bag.t0 > 0) item.t0 = bag.t0;
      out.floors = item;
    }
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

// ── 楼层履历（floors，2026-09-22）────────────────────────────────────────────
// 总楼层 = 全史合计：per-root 计数映射的 Σ（root = 主项目路径归一化键）。
//   · 正向计数：发送成功分配楼层 → IPC qqqide:vig:floor（渲染层）→ m[root] += 1 + t[等级-1] += 1
//   · 离线播种：vigStartFloorsSeed 扫最近项目 _qqq/quests/{*,.trash/*}/f* 一次性回填
//     （m[root] = max(现值, 扫描值)——已提交楼层必在盘上，max 语义防与正向双计）
//   · t = 等级直方 [1级,2级,3级]（仅正向楼层知等级；历史回填楼无样本）
//   · s = 已播种 root 标记（每 root 一次；非 qqqide 项目不标记——零成本 stat，下次启动再查）
// 服务端消费：device_vig.floors_n / floors_t / floors_t0 → qd 行为追踪「总楼层 / 平均等级」

function _normRoot(root: string): string {
  try { return String(root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
}

/** 记一个新楼层（root=主项目路径；tier=UI 档位 1/2/3，0=未知；free=免费时段建造）。 */
export function vigFloor(root: string, tier: number, free: boolean): void {
  const v: any = _load();
  if (!v.floors || typeof v.floors !== 'object') v.floors = { t0: 0, t: [0, 0, 0], m: {}, s: [] };
  const bag: any = v.floors;
  if (!bag.m || typeof bag.m !== 'object') bag.m = {};
  if (!Array.isArray(bag.t) || bag.t.length < 3) bag.t = [0, 0, 0];
  if (!Array.isArray(bag.s)) bag.s = [];
  const key = _normRoot(root) || '?';
  if (key in bag.m || Object.keys(bag.m).length < FLOORS_MAX_ROOTS) {
    bag.m[key] = _clampKey('n', (Number(bag.m[key]) || 0) + 1);
  }
  const ti = Math.floor(Number(tier) || 0);
  if (ti >= 1 && ti <= 3) bag.t[ti - 1] = _clampKey('n', (Number(bag.t[ti - 1]) || 0) + 1);
  if (!bag.t0 || bag.t0 <= 0) bag.t0 = Math.floor(Date.now() / 1000);
  if (free) {
    const f: any = v.free || (v.free = {});
    if (!f.t0 || f.t0 <= 0) f.t0 = Math.floor(Date.now() / 1000);
    f.n = _clampKey('n', (Number(f.n) || 0) + 1);
  }
  _saveSoon();
}

/** 扫描单个项目的楼层数（quests 下各 quest 的 f* 目录 + .trash 归档 quest 的 f* 目录）。
 *  返回 null = 非 qqqide 项目（无 _qqq/quests）或不可读。
 *  ★ 全异步（fs.promises，2026-09-24）: 启动播种不阻塞主进程事件循环（大目录零卡顿）。 */
async function _scanFloorCount(root: string): Promise<number | null> {
  const qdir = path.join(root, '_qqq', 'quests');
  try { if (!(await fsp.stat(qdir)).isDirectory()) return null; } catch { return null; }
  let total = 0;
  const countQuest = async (qpath: string): Promise<void> => {
    try {
      for (const e of await fsp.readdir(qpath, { withFileTypes: true })) {
        if (e.isDirectory() && /^f\d/.test(e.name)) total++;
      }
    } catch { /* ignore */ }
  };
  try {
    for (const e of await fsp.readdir(qdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === '.trash') {
        const tdir = path.join(qdir, '.trash');
        try {
          for (const q of await fsp.readdir(tdir, { withFileTypes: true })) {
            if (q.isDirectory()) await countQuest(path.join(tdir, q.name));
          }
        } catch { /* ignore */ }
      } else {
        await countQuest(path.join(qdir, e.name));
      }
    }
  } catch { return null; }
  return total;
}

/** 启动楼层播种（main.ts 注入 stateStore；60s 后跑一次，每 root 只播种一次）。
 *  roots 来源 = global.sq3 'qqqide'/'recent_folders'（用户开过的全部主项目，上限 100）。 */
export function vigStartFloorsSeed(store: any, delayMs = 60000): void {
  setTimeout(async () => {
    try {
      const roots: string[] = [];
      try {
        const raw = store ? await store.get('qqqide', 'recent_folders') : null;
        if (Array.isArray(raw)) {
          for (const r of raw) {
            const p = r && (r.path || r);
            if (typeof p === 'string' && p) roots.push(p);
          }
        }
      } catch { /* ignore */ }
      if (roots.length === 0) return;
      const v: any = _load();
      if (!v.floors || typeof v.floors !== 'object') v.floors = { t0: 0, t: [0, 0, 0], m: {}, s: [] };
      const bag: any = v.floors;
      if (!bag.m || typeof bag.m !== 'object') bag.m = {};
      if (!Array.isArray(bag.s)) bag.s = [];
      let dirty = false;
      for (const root of roots) {
        const key = _normRoot(root);
        if (!key || bag.s.indexOf(key) >= 0) continue;
        if (bag.s.length >= FLOORS_MAX_ROOTS) break;
        let exists = false;
        try { exists = (await fsp.stat(root)).isDirectory(); } catch { exists = false; }
        if (!exists) { bag.s.push(key); dirty = true; continue; }   // 死路径：标记防每次启动重扫
        const cnt = await _scanFloorCount(root);
        if (cnt === null) continue;   // 非 qqqide 项目：不标记（零成本 stat，换项目后不再扫）
        bag.s.push(key);
        bag.m[key] = Math.max(Number(bag.m[key]) || 0, cnt);
        dirty = true;
        await new Promise((res) => setTimeout(res, 30));   // 让出主线程（多项目不卡启动）
      }
      if (dirty) vigFlush();
    } catch { /* ignore */ }
  }, delayMs);
}
