// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// index-service.ts — 项目语义索引引擎 (BM25 + 符号提取)
//
// 存储: {projectRoot}/_qqq/index/
//   manifest.json   — 文件清单 + mtime (用于增量更新)
//   bm25.json       — BM25 倒排索引 (term → {file → count})
//   symbols.json    — 符号表 (file → {functions, classes, imports})
//   stats.json      — 索引统计 (N, avgdl, lastBuildAt)
//
// BM25 公式 (Okapi):
//   score(q,d) = Σ IDF(t) * (f(t,d)*(k1+1)) / (f(t,d) + k1*(1-b + b*|d|/avgdl))
//   IDF(t) = log((N - n(t) + 0.5) / (n(t) + 0.5) + 1)
//   k1=1.5, b=0.75
//
// 值: 一次 search_smart 调用 = 语义搜索 + 正则搜索 + 符号搜索 三路并行合并
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IndexManifest {
    files: Record<string, { mtime: number; size: number; chunkCount: number }>;
}

interface Bm25Stats {
    N: number;           // total chunks
    avgdl: number;       // average chunk length (tokens)
    lastBuildAt: number;
}

interface SymbolEntry {
    functions: string[];
    classes: string[];
    imports: string[];
    exports: string[];
}

interface SymbolTable {
    [filePath: string]: SymbolEntry;
}

interface SearchResult {
    filePath: string;
    score: number;
    matchType: 'bm25' | 'regex' | 'symbol';
    snippet: string;
    line?: number;
    /** ★ 2026-08-20: chunk 起始偏移 — snippet/line 由 IPC 层按需读盘补全（fileContents 已移除） */
    chunkStart?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B = 0.75;

const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor',
    'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs',
    '.hg', '.svn', 'bower_components', '.idea', '.vs', 'cache', 'temp',
    'crashDumps', 'dist-pack', 'shell-out', 'shell-build', '.qoder',
    'Data', 'logs', 'new_log', 'tmp', 'op',
    // ★ 2026-08-20 内存治理：索引自身产物 + 程序目录 + 项目元数据一律跳过
    //   _qqq = 项目元数据/对话（索引进自身 = 噪音 + 无限膨胀）
    //   engines/resources = 绿色包程序目录（Python 解释器 Lib + PortableGit 数千文本文件）
    '_qqq', 'engines', 'resources'
]);

const SKIP_EXTS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg',
    '.gif', '.bmp', '.webp', '.ico', '.mp3', '.mp4', '.avi', '.mkv',
    '.mov', '.wav', '.flac', '.ogg', '.zip', '.tar', '.gz', '.xz',
    '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.pdf',
    '.vsix', '.wasm', '.class', '.o', '.obj', '.pyc', '.pyo', '.sqlite',
    '.db', '.lock', '.otf'
]);

const MAX_FILE_SIZE = 500 * 1024;  // 500KB per file for indexing
const CHUNK_MIN = 100;             // min chars per chunk
const CHUNK_MAX = 4000;            // max chars per chunk
const MAX_FILES = 50000;

// Regex for extracting symbols from code
const FUNC_RE = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|def|fn|func)\s+(\w+)/g;
const CLASS_RE = /(?:^|\n)\s*(?:export\s+)?(?:class|interface|struct|enum|type)\s+(\w+)/g;
const IMPORT_RE = /(?:import|require|from)\s+.*?['"](\S+?)['"]/g;
const EXPORT_RE = /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/g;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const TOKEN_RE = /[a-zA-Z_]\w{1,}/g;  // identifiers only (skip numbers, punctuation)
const STOP_WORDS = new Set([
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'not',
    'but', 'in', 'with', 'to', 'for', 'of', 'by', 'from', 'as', 'be',
    'this', 'that', 'it', 'are', 'was', 'were', 'been', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
    'might', 'can', 'shall', 'you', 'he', 'she', 'they', 'we', 'me',
    'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our',
    'their', 'if', 'else', 'then', 'than', 'so', 'no', 'yes', 'just',
    'very', 'too', 'also', 'now', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
    'most', 'some', 'any', 'one', 'two', 'get', 'set', 'let', 'var',
    'const', 'new', 'return', 'true', 'false', 'null', 'undefined',
    'typeof', 'instanceof', 'void', 'delete', 'type', 'interface'
]);

function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();
    let m: RegExpExecArray | null;
    const re = new RegExp(TOKEN_RE.source, 'g');
    while ((m = re.exec(lower)) !== null) {
        const t = m[0];
        if (t.length < 2 || STOP_WORDS.has(t)) continue;
        tokens.push(t);
    }
    return tokens;
}

// ---------------------------------------------------------------------------
// Chunker — 按代码边界拆分（函数/类/段落）
// ---------------------------------------------------------------------------

interface Chunk {
    start: number;
    end: number;
    tokens: string[];
    type: 'code' | 'text';
}

function chunkFile(content: string, ext: string): Chunk[] {
    const chunks: Chunk[] = [];
    const isCode = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
        '.tsx', '.jsx', '.vue', '.svelte', '.rb', '.php', '.swift', '.kt', '.scala'].includes(ext);

    if (isCode) {
        // 按函数/类边界切分
        const lines = content.split('\n');
        let chunkStart = 0;
        let chunkLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            chunkLines.push(line);

            // 检测块边界: 空行后的函数/类/导出声明, 或者积累到 CHUNK_MAX
            const isBoundary = (
                /^(export\s+)?(async\s+)?(function|def|fn|func|class|interface|struct|enum|type|impl|pub\s+fn|public\s+class)\s/.test(line.trim()) &&
                (i === 0 || lines[i - 1].trim() === '')
            );
            const chunkLen = chunkLines.join('\n').length;

            if ((isBoundary && chunkLen > CHUNK_MIN) || chunkLen >= CHUNK_MAX) {
                const text = chunkLines.join('\n');
                chunks.push({
                    start: chunkStart,
                    end: chunkStart + text.length,
                    tokens: tokenize(text),
                    type: 'code'
                });
                chunkStart += text.length + 1; // +1 for the newline we stripped
                chunkLines = [];
            }
        }

        // 剩余
        if (chunkLines.length > 0) {
            const text = chunkLines.join('\n');
            if (text.trim().length >= CHUNK_MIN) {
                chunks.push({
                    start: chunkStart,
                    end: chunkStart + text.length,
                    tokens: tokenize(text),
                    type: 'code'
                });
            }
        }
    } else {
        // 文本文件: 按段落切分
        const paragraphs = content.split(/\n\n+/);
        let pos = 0;
        for (const para of paragraphs) {
            if (para.trim().length < CHUNK_MIN) { pos += para.length + 2; continue; }
            const combined = para;
            chunks.push({
                start: pos,
                end: pos + combined.length,
                tokens: tokenize(combined),
                type: 'text'
            });
            pos += combined.length + 2;
        }
    }

    return chunks;
}

// ---------------------------------------------------------------------------
// Symbol Extraction
// ---------------------------------------------------------------------------

function extractSymbols(content: string, ext: string): SymbolEntry {
    const entry: SymbolEntry = { functions: [], classes: [], imports: [], exports: [] };

    if (!['.ts', '.js', '.py', '.go', '.rs', '.java', '.tsx', '.jsx'].includes(ext)) {
        return entry;
    }

    // Functions
    let m: RegExpExecArray | null;
    const funcRe = new RegExp(FUNC_RE.source, 'g');
    while ((m = funcRe.exec(content)) !== null) {
        if (!entry.functions.includes(m[1])) entry.functions.push(m[1]);
    }

    // Classes
    const classRe = new RegExp(CLASS_RE.source, 'g');
    while ((m = classRe.exec(content)) !== null) {
        if (!entry.classes.includes(m[1])) entry.classes.push(m[1]);
    }

    // Imports
    const importRe = new RegExp(IMPORT_RE.source, 'g');
    while ((m = importRe.exec(content)) !== null) {
        const imp = m[1];
        if (!imp.startsWith('.') && !entry.imports.includes(imp)) entry.imports.push(imp);
    }

    // Exports
    const exportRe = new RegExp(EXPORT_RE.source, 'g');
    while ((m = exportRe.exec(content)) !== null) {
        if (!entry.exports.includes(m[1])) entry.exports.push(m[1]);
    }

    return entry;
}

// ---------------------------------------------------------------------------
// BM25 Index
// ---------------------------------------------------------------------------

interface Bm25Index {
    /** term → (chunkId → term frequency in chunk) */
    inverted: Record<string, Record<number, number>>;
    /** chunkId → { filePath, start, end, tokenCount } */
    chunks: Array<{ file: string; start: number; end: number; tokens: number; type: string }>;
    /** term → document frequency (in how many chunks does this term appear) */
    df: Record<string, number>;
    stats: Bm25Stats;
    // ★ 2026-08-20 内存治理: fileContents 全量常驻已删除 — snippet 按需读盘（IPC 层）
}

function createEmptyIndex(): Bm25Index {
    return {
        inverted: {},
        chunks: [],
        df: {},
        stats: { N: 0, avgdl: 0, lastBuildAt: 0 }
    };
}

function addToIndex(idx: Bm25Index, filePath: string, content: string, ext: string): void {
    const chunks = chunkFile(content, ext);

    for (const chunk of chunks) {
        const chunkId = idx.chunks.length;
        idx.chunks.push({
            file: filePath,
            start: chunk.start,
            end: chunk.end,
            tokens: chunk.tokens.length,
            type: chunk.type
        });

        // Count term frequencies in this chunk
        const tf: Record<string, number> = {};
        for (const t of chunk.tokens) {
            tf[t] = (tf[t] || 0) + 1;
        }

        // Update inverted index
        for (const [term, count] of Object.entries(tf)) {
            if (!idx.inverted[term]) idx.inverted[term] = {};
            idx.inverted[term][chunkId] = count;
        }

        // Update document frequency
        for (const term of Object.keys(tf)) {
            idx.df[term] = (idx.df[term] || 0) + 1;
        }

        idx.stats.N++;
    }
}

function finalizeIndex(idx: Bm25Index): void {
    // Compute avgdl
    let totalTokens = 0;
    for (const c of idx.chunks) {
        totalTokens += c.tokens;
    }
    idx.stats.avgdl = idx.stats.N > 0 ? totalTokens / idx.stats.N : 1;
    idx.stats.lastBuildAt = Date.now();
}

function removeFromIndex(idx: Bm25Index, filePath: string): void {
    // Find chunk IDs for this file
    const chunkIds: number[] = [];
    for (let i = 0; i < idx.chunks.length; i++) {
        if (idx.chunks[i].file === filePath) chunkIds.push(i);
    }

    // Remove from inverted index
    for (const term of Object.keys(idx.inverted)) {
        for (const cid of chunkIds) {
            if (idx.inverted[term][cid] !== undefined) {
                delete idx.inverted[term][cid];
                idx.df[term]--;
            }
        }
        if (Object.keys(idx.inverted[term]).length === 0) {
            delete idx.inverted[term];
            delete idx.df[term];
        }
    }

    // Mark chunks as removed (set file to empty)
    for (const cid of chunkIds) {
        idx.chunks[cid].file = '';
    }

}

// ---------------------------------------------------------------------------
// BM25 search
// ---------------------------------------------------------------------------

function bm25Idf(idx: Bm25Index, term: string): number {
    const n = idx.df[term] || 0;
    if (n === 0) return 0;
    return Math.log((idx.stats.N - n + 0.5) / (n + 0.5) + 1);
}

function bm25Search(idx: Bm25Index, query: string, topK: number): SearchResult[] {
    const queryTokens = tokenize(query);

    // Compute IDF for each query token
    const idfs: Record<string, number> = {};
    for (const t of queryTokens) {
        idfs[t] = bm25Idf(idx, t);
    }

    // Score each chunk
    const scores: Record<number, number> = {};  // chunkId → score
    const avgdl = idx.stats.avgdl;

    for (const term of queryTokens) {
        const idf = idfs[term];
        if (idf === 0) continue;
        const postings = idx.inverted[term];
        if (!postings) continue;

        for (const [chunkIdStr, tf] of Object.entries(postings)) {
            const chunkId = parseInt(chunkIdStr, 10);
            const chunk = idx.chunks[chunkId];
            if (!chunk || !chunk.file) continue;  // removed chunk

            const dl = chunk.tokens || 1;
            const numerator = tf * (BM25_K1 + 1);
            const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl);
            const score = idf * numerator / denominator;

            scores[chunkId] = (scores[chunkId] || 0) + score;
        }
    }

    // Convert to results
    const results: SearchResult[] = [];
    for (const [chunkIdStr, score] of Object.entries(scores)) {
        const chunkId = parseInt(chunkIdStr, 10);
        const chunk = idx.chunks[chunkId];
        if (!chunk || !chunk.file) continue;

        // ★ 2026-08-20: snippet/line 不再从内存全文取 — 由 IPC 层按需读盘补全（chunkStart 定位）
        results.push({
            filePath: chunk.file,
            score,
            matchType: 'bm25',
            snippet: '',
            chunkStart: chunk.start
        });
    }

    // Sort by score descending, dedup by file (keep highest score per file)
    results.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const r of results) {
        if (!seen.has(r.filePath)) {
            seen.add(r.filePath);
            deduped.push(r);
            if (deduped.length >= topK) break;
        }
    }

    return deduped;
}

// ---------------------------------------------------------------------------
// Symbol search
// ---------------------------------------------------------------------------

function symbolSearch(symbols: SymbolTable, query: string, topK: number): SearchResult[] {
    const queryLower = query.toLowerCase();
    const queryTokens = tokenize(query);
    const results: Array<{ filePath: string; score: number; matched: string; matchKind: string }> = [];

    for (const [filePath, entry] of Object.entries(symbols)) {
        let score = 0;
        let matched = '';
        let matchKind = '';

        // Check function names
        for (const fn of entry.functions) {
            for (const qt of queryTokens) {
                if (fn.toLowerCase().includes(qt)) {
                    score += 3;
                    if (!matched) { matched = fn; matchKind = 'fn'; }
                }
            }
            if (fn.toLowerCase() === queryLower) {
                score += 10;  // exact match bonus
                matched = fn; matchKind = 'fn';
            }
        }

        // Check class names
        for (const cls of entry.classes) {
            for (const qt of queryTokens) {
                if (cls.toLowerCase().includes(qt)) {
                    score += 3;
                    if (!matched) { matched = cls; matchKind = 'class'; }
                }
            }
            if (cls.toLowerCase() === queryLower) {
                score += 10;
                matched = cls; matchKind = 'class';
            }
        }

        // Check imports (e.g., query "auth" matches files importing "express")
        for (const imp of entry.imports) {
            for (const qt of queryTokens) {
                if (imp.toLowerCase().includes(qt)) {
                    score += 1;
                    if (!matched) { matched = imp; matchKind = 'import'; }
                }
            }
            if (imp.toLowerCase() === queryLower) {
                score += 5;
                matched = imp; matchKind = 'import';
            }
        }

        // ★ P3: Check exports (previously collected but NEVER searched!)
        for (const exp of entry.exports) {
            for (const qt of queryTokens) {
                if (exp.toLowerCase().includes(qt)) {
                    score += 4;  // exports are more important than imports
                    if (!matched || matchKind === 'import') { matched = exp; matchKind = 'export'; }
                }
            }
            if (exp.toLowerCase() === queryLower) {
                score += 12;  // exact export match = highest signal
                matched = exp; matchKind = 'export';
            }
        }

        if (score > 0) {
            results.push({ filePath, score, matched, matchKind });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK).map(r => ({
        filePath: r.filePath,
        score: r.score,
        matchType: 'symbol' as const,
        snippet: `symbol: ${r.matched} [${r.matchKind}]`,
        line: undefined
    }));
}

// ---------------------------------------------------------------------------
// Index Persistence
// ---------------------------------------------------------------------------

// ★ 2026-08-20: 索引落盘从 {root}/Data/index 迁移到 {root}/_qqq/index — 索引是项目资产
//   归位项目元数据目录（Data 是绿色包保险库/Electron userData，语义错位；
//   且 {root}/Data 已被 SKIP_DIRS 排除，索引自身永不被扫回）
function indexDir(rootDir: string): string {
    return path.join(rootDir, '_qqq', 'index');
}

function ensureIndexDir(rootDir: string): string {
    const dir = indexDir(rootDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function saveIndex(rootDir: string, idx: Bm25Index, manifest: IndexManifest, symbols: SymbolTable): Promise<void> {
    const dir = ensureIndexDir(rootDir);
    await fs.promises.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await fs.promises.writeFile(path.join(dir, 'symbols.json'), JSON.stringify(symbols, null, 2), 'utf8');
    // bm25 index can be large — write as binary-friendly JSON
    const bm25Data = {
        stats: idx.stats,
        chunks: idx.chunks,
        df: idx.df,
        inverted: idx.inverted,
        // fileContents NOT persisted (re-read on load)
    };
    await fs.promises.writeFile(path.join(dir, 'bm25.json'), JSON.stringify(bm25Data), 'utf8');
}

async function loadIndex(rootDir: string): Promise<{ idx: Bm25Index; manifest: IndexManifest; symbols: SymbolTable } | null> {
    const dir = indexDir(rootDir);
    try {
        const [manifestRaw, bm25Raw, symbolsRaw] = await Promise.all([
            fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8'),
            fs.promises.readFile(path.join(dir, 'bm25.json'), 'utf8'),
            fs.promises.readFile(path.join(dir, 'symbols.json'), 'utf8'),
        ]);
        const manifest: IndexManifest = JSON.parse(manifestRaw);
        const bm25Data = JSON.parse(bm25Raw);
        const symbols: SymbolTable = JSON.parse(symbolsRaw);

        const idx = createEmptyIndex();
        idx.stats = bm25Data.stats;
        idx.chunks = bm25Data.chunks;
        idx.df = bm25Data.df;
        idx.inverted = bm25Data.inverted;
        // ★ 2026-08-20: 无 fileContents（已删除）— snippet 按需读盘

        return { idx, manifest, symbols };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Main Index Service
// ---------------------------------------------------------------------------

export class IndexService {
    private rootDir: string | null;
    private idx: Bm25Index | null = null;
    private manifest: IndexManifest | null = null;
    private symbols: SymbolTable | null = null;
    private building = false;
    private ready = false;
    private _readyPromise: Promise<void> | null = null;
    private _buildFailAt = 0;
    private _idleTimer: NodeJS.Timeout | null = null;
    private _symbolGraphCache: Record<string, { definingFiles: string[]; importingFiles: string[]; exportingFiles: string[] }> | null = null;  // ★ P3: lazy-built, invalidated on rebuild

    // ★ 2026-08-20 内存治理（启动零索引，用完即焚）:
    //   ① 启动不再 init() — 首次 search_smart 才 ensureReady（ghrun 同款按需语义）
    //   ② 索引根 = 当前窗口主文件夹（setRoot 跟随项目锁），程序目录永不索引
    //   ③ 空闲 IDLE_TTL_MS 无调用 → release() 焚毁全部索引内存；下次调用读盘重建（~1s）
    static readonly IDLE_TTL_MS = 5 * 60 * 1000;
    static readonly BUILD_FAIL_COOLDOWN_MS = 30 * 1000;

    constructor(rootDir: string | null = null) {
        this.rootDir = rootDir;
    }

    /** 切换索引根（窗口绑定主文件夹时由 IPC 层驱动）；切换即焚旧索引 */
    setRoot(dir: string | null): void {
        const norm = dir ? dir.replace(/\\/g, '/').replace(/\/+$/, '') : null;
        if (norm === this.rootDir) return;
        this.release();
        this.rootDir = norm;
        this._readyPromise = null;  // 放弃在途 promise（旧构建结果会被 rootDir 校验丢弃）
        this._buildFailAt = 0;
    }

    getRoot(): string | null {
        return this.rootDir;
    }

    get hasRoot(): boolean { return !!this.rootDir; }

    /** 按需就绪：有索引读盘，无索引构建；并发去重；rootDir 为空则静默跳过 */
    async ensureReady(): Promise<void> {
        this.touch();
        if (this.ready || !this.rootDir) return;
        if (this._readyPromise) return this._readyPromise;
        this._readyPromise = this._doEnsure().finally(() => { this._readyPromise = null; });
        return this._readyPromise;
    }

    private async _doEnsure(): Promise<void> {
        const expectedRoot = this.rootDir;
        if (!expectedRoot) return;
        // 构建失败冷却（目录不可读等）——冷却内直接跳过，防每请求反复全量构建
        if (Date.now() < this._buildFailAt) return;

        const loaded = await loadIndex(expectedRoot);
        if (loaded) {
            if (this.rootDir !== expectedRoot) return;  // setRoot 竞态 → 丢弃
            this.idx = loaded.idx;
            this.manifest = loaded.manifest;
            this.symbols = loaded.symbols;
            this.ready = true;
            this._symbolGraphCache = null;
            console.log('[index] loaded existing index:', loaded.idx.stats.N, 'chunks,', Object.keys(loaded.manifest.files).length, 'files @', expectedRoot);
        } else {
            await this.buildAsync();
        }
    }

    /** 用完即焚：空闲 TTL 后释放全部索引内存（下次调用读盘重建） */
    private touch(): void {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => this.release(), IndexService.IDLE_TTL_MS);
        if (this._idleTimer.unref) this._idleTimer.unref();
    }

    release(): void {
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        this.idx = null;
        this.manifest = null;
        this.symbols = null;
        this._symbolGraphCache = null;
        this.ready = false;
    }

    get isReady(): boolean { return this.ready; }
    get isBuilding(): boolean { return this.building; }
    get chunkCount(): number { return this.idx ? this.idx.stats.N : 0; }
    get fileCount(): number { return this.manifest ? Object.keys(this.manifest.files).length : 0; }
    get symbolCount(): number { return this.symbols ? Object.keys(this.symbols).length : 0; }  // ★ P3

    /** Expose file paths from manifest (for regex phase reuse — skip directory walk) */
    getFilePaths(): string[] {
        return this.manifest ? Object.keys(this.manifest.files) : [];
    }

    // ═══ P3: Symbol Graph Interface ═══

    /** Expose raw symbol table for external consumers */
    getSymbols(): SymbolTable {
        return this.symbols || {};
    }

    /**
     * Build and return a reverse symbol graph:
     * symbolName → { definingFiles: string[], importingFiles: string[], exportingFiles: string[] }
     * Lazily computed — cached once per build cycle, invalidated on index rebuild.
     */
    getSymbolGraph(): Record<string, { definingFiles: string[]; importingFiles: string[]; exportingFiles: string[] }> {
        if (this._symbolGraphCache) return this._symbolGraphCache;

        const graph: Record<string, { definingFiles: string[]; importingFiles: string[]; exportingFiles: string[] }> = {};
        const syms = this.symbols || {};

        for (const [filePath, entry] of Object.entries(syms)) {
            // Functions → defining
            for (const fn of entry.functions) {
                if (!graph[fn]) graph[fn] = { definingFiles: [], importingFiles: [], exportingFiles: [] };
                if (!graph[fn].definingFiles.includes(filePath)) graph[fn].definingFiles.push(filePath);
            }
            // Classes → defining
            for (const cls of entry.classes) {
                if (!graph[cls]) graph[cls] = { definingFiles: [], importingFiles: [], exportingFiles: [] };
                if (!graph[cls].definingFiles.includes(filePath)) graph[cls].definingFiles.push(filePath);
            }
            // Exports → exporting
            for (const exp of entry.exports) {
                if (!graph[exp]) graph[exp] = { definingFiles: [], importingFiles: [], exportingFiles: [] };
                if (!graph[exp].exportingFiles.includes(filePath)) graph[exp].exportingFiles.push(filePath);
            }
            // Imports → importing (filePath imports this symbol)
            for (const imp of entry.imports) {
                if (!graph[imp]) graph[imp] = { definingFiles: [], importingFiles: [], exportingFiles: [] };
                if (!graph[imp].importingFiles.includes(filePath)) graph[imp].importingFiles.push(filePath);
            }
        }

        this._symbolGraphCache = graph;
        return graph;
    }

    /**
     * Find all files that reference a given symbol (define, export, or import it).
     * @returns {{ filePath: string; role: 'defines'|'exports'|'imports' }[]}
     */
    findSymbolReferences(symbolName: string): Array<{ filePath: string; role: 'defines' | 'exports' | 'imports' }> {
        const graph = this.getSymbolGraph();
        const entry = graph[symbolName];
        if (!entry) return [];

        const refs: Array<{ filePath: string; role: 'defines' | 'exports' | 'imports' }> = [];
        for (const f of entry.definingFiles) refs.push({ filePath: f, role: 'defines' });
        for (const f of entry.exportingFiles) refs.push({ filePath: f, role: 'exports' });
        for (const f of entry.importingFiles) refs.push({ filePath: f, role: 'imports' });
        return refs;
    }

    /** Build index asynchronously (does not block caller) */
    async buildAsync(): Promise<void> {
        if (this.building) return;
        const root = this.rootDir;
        if (!root) return;
        this.building = true;
        console.log('[index] building index for:', root);

        try {
            const files = await this.collectFiles(root);
            console.log('[index] collected', files.length, 'files for indexing');

            const idx = createEmptyIndex();
            const manifest: IndexManifest = { files: {} };
            const symbols: SymbolTable = {};

            let processed = 0;
            for (const filePath of files) {
                try {
                    const st = await fs.promises.stat(filePath);
                    if (st.size > MAX_FILE_SIZE) continue;

                    const content = await fs.promises.readFile(filePath, 'utf8');
                    if (content.length === 0) continue;
                    // Skip binary content
                    if (content.includes('\x00')) continue;

                    const ext = path.extname(filePath).toLowerCase();
                    const relPath = path.relative(root, filePath).replace(/\\/g, '/');

                    // Only index source code + text files
                    const indexableExts = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
                        '.tsx', '.jsx', '.vue', '.svelte', '.rb', '.php', '.swift', '.kt', '.scala',
                        '.json', '.txt', '.md', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.sh', '.bat',
                        '.html', '.css', '.scss', '.less', '.svg', '.xml', '.sql', '.graphql', '.proto'];
                    if (!indexableExts.includes(ext)) continue;

                    addToIndex(idx, relPath, content, ext);
                    manifest.files[relPath] = { mtime: st.mtimeMs, size: st.size, chunkCount: 0 };

                    // Extract symbols
                    const symEntry = extractSymbols(content, ext);
                    if (symEntry.functions.length > 0 || symEntry.classes.length > 0) {
                        symbols[relPath] = symEntry;
                    }

                    processed++;
                    if (processed % 500 === 0) {
                        console.log('[index] processed', processed, 'files...');
                    }
                } catch {
                    // skip unreadable files
                }
            }

            // Update chunk counts in manifest
            for (const c of idx.chunks) {
                if (c.file && manifest.files[c.file]) {
                    manifest.files[c.file].chunkCount++;
                }
            }

            finalizeIndex(idx);

            // ★ setRoot 竞态守卫：构建期间索引根已切换 → 丢弃本次结果（下次按需重建）
            if (this.rootDir !== root) {
                console.log('[index] build discarded (root switched):', root);
                return;
            }

            this.idx = idx;
            this.manifest = manifest;
            this.symbols = symbols;
            this.ready = true;
            this._symbolGraphCache = null;  // ★ invalidate graph cache on rebuild

            await saveIndex(root, idx, manifest, symbols);
            console.log('[index] build complete:', idx.stats.N, 'chunks,', processed, 'files');
        } catch (e) {
            console.error('[index] build failed:', e);
            this._buildFailAt = Date.now() + IndexService.BUILD_FAIL_COOLDOWN_MS;  // 冷却防反复全量构建
        } finally {
            this.building = false;
            if (this.rootDir === root) this.touch();  // 构建期间保持续命（防刚建好就被焚）
        }
    }

    /** Update a single file in the index (called on file save) */
    async updateFile(filePath: string): Promise<void> {
        if (!this.idx || !this.manifest || !this.symbols) return;
        const relPath = path.relative(this.rootDir, filePath).replace(/\\/g, '/');

        // Remove old entries
        if (this.manifest.files[relPath]) {
            removeFromIndex(this.idx, relPath);
            delete this.symbols[relPath];
        }

        // Re-index
        try {
            const st = await fs.promises.stat(filePath);
            if (st.size > MAX_FILE_SIZE || st.size === 0) return;

            const content = await fs.promises.readFile(filePath, 'utf8');
            if (content.includes('\x00')) return;

            const ext = path.extname(filePath).toLowerCase();
            const indexableExts = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
                '.tsx', '.jsx', '.vue', '.svelte', '.rb', '.php', '.swift', '.kt', '.scala',
                '.json', '.txt', '.md', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.sh', '.bat',
                '.html', '.css', '.scss', '.less', '.svg', '.xml', '.sql', '.graphql', '.proto'];
            if (!indexableExts.includes(ext)) return;

            addToIndex(this.idx, relPath, content, ext);
            this.manifest.files[relPath] = { mtime: st.mtimeMs, size: st.size, chunkCount: 0 };

            const symEntry = extractSymbols(content, ext);
            if (symEntry.functions.length > 0 || symEntry.classes.length > 0) {
                this.symbols[relPath] = symEntry;
            }

            // Update chunk count
            for (const c of this.idx.chunks) {
                if (c.file === relPath) {
                    const mf = this.manifest.files[relPath];
                    if (mf) mf.chunkCount++;
                }
            }

            finalizeIndex(this.idx);
            this._symbolGraphCache = null;  // ★ invalidate on update
            await saveIndex(this.rootDir, this.idx, this.manifest, this.symbols);
        } catch {
            // skip
        }
    }

    /** Remove a file from the index */
    async removeFile(filePath: string): Promise<void> {
        if (!this.idx || !this.manifest || !this.symbols) return;
        const relPath = path.relative(this.rootDir, filePath).replace(/\\/g, '/');
        removeFromIndex(this.idx, relPath);
        delete this.manifest.files[relPath];
        delete this.symbols[relPath];
        this._symbolGraphCache = null;  // ★ invalidate on remove
        await saveIndex(this.rootDir, this.idx, this.manifest, this.symbols);
    }

    /** Main search: BM25 + symbol matching */
    search(query: string, topK: number = 10): { results: SearchResult[]; indexReady: boolean } {
        this.touch();
        if (!this.idx || !this.symbols) {
            return { results: [], indexReady: false };
        }

        // 1. BM25 semantic search
        const bm25Results = bm25Search(this.idx, query, topK * 2);

        // 2. Symbol search
        const symResults = symbolSearch(this.symbols, query, topK);

        // 3. Merge: interleave BM25 and symbol results, BM25 first
        const merged: SearchResult[] = [];
        const seen = new Set<string>();
        let bi = 0, si = 0;

        while (merged.length < topK && (bi < bm25Results.length || si < symResults.length)) {
            // Pick the next best result
            const bScore = bi < bm25Results.length ? bm25Results[bi].score : -1;
            const sScore = si < symResults.length ? symResults[si].score : -1;

            if (bScore >= sScore && bi < bm25Results.length) {
                const r = bm25Results[bi++];
                if (!seen.has(r.filePath)) {
                    seen.add(r.filePath);
                    merged.push(r);
                }
            } else if (si < symResults.length) {
                const r = symResults[si++];
                if (!seen.has(r.filePath)) {
                    seen.add(r.filePath);
                    merged.push(r);
                }
            } else {
                break;
            }
        }

        return { results: merged, indexReady: true };
    }

    // -----------------------------------------------------------------------
    // File collection (respects .gitignore)
    // -----------------------------------------------------------------------

    private async collectFiles(rootDir: string): Promise<string[]> {
        const files: string[] = [];
        const ignoreMatchers: Array<(rel: string, isDir: boolean) => boolean> = [];

        // Try .gitignore, then .qqqignore
        for (const ignName of ['.gitignore', '.qqqignore']) {
            const ignPath = path.join(rootDir, ignName);
            try {
                if (fs.existsSync(ignPath)) {
                    ignoreMatchers.push(this.parseIgnoreFile(fs.readFileSync(ignPath, 'utf8')));
                }
            } catch { /* ignore */ }
        }

        const isIgnored = (rel: string, isDir: boolean): boolean => {
            for (const m of ignoreMatchers) { if (m(rel, isDir)) return true; }
            return false;
        };

        const walk = async (dir: string, relBase: string): Promise<void> => {
            if (files.length >= MAX_FILES) return;
            let entries: fs.Dirent[];
            try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
            catch { return; }
            for (const ent of entries) {
                if (files.length >= MAX_FILES) return;
                const rel = relBase ? relBase + '/' + ent.name : ent.name;
                if (ent.isDirectory()) {
                    if (SKIP_DIRS.has(ent.name)) continue;
                    if (ent.name.startsWith('.')) continue;
                    if (isIgnored(rel + '/', true)) continue;
                    await walk(path.join(dir, ent.name), rel);
                } else if (ent.isFile() || ent.isSymbolicLink()) {
                    const ext = path.extname(ent.name).toLowerCase();
                    if (SKIP_EXTS.has(ext)) continue;
                    if (isIgnored(rel, false)) continue;
                    files.push(path.join(dir, ent.name));
                }
            }
        };

        await walk(rootDir, '');
        return files;
    }

    private parseIgnoreFile(content: string): (rel: string, isDir: boolean) => boolean {
        const rules: Array<{ pattern: RegExp; negate: boolean; dirOnly: boolean }> = [];
        for (const raw of content.split('\n')) {
            let line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            let negate = false;
            if (line.startsWith('!')) { negate = true; line = line.slice(1); }
            const dirOnly = line.endsWith('/');
            if (dirOnly) line = line.slice(0, -1);
            let pattern = line.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*\*/g, '[[GLOBSTAR]]')
                .replace(/\*/g, '[^/]*')
                .replace(/\[\[GLOBSTAR\]\]/g, '.*')
                .replace(/\?/g, '[^/]');
            if (!pattern.startsWith('/')) pattern = '(^|/)' + pattern;
            rules.push({ pattern: new RegExp(pattern), negate, dirOnly });
        }
        return (rel: string, isDir: boolean): boolean => {
            let ignored = false;
            for (const r of rules) {
                if (r.dirOnly && !isDir) continue;
                if (r.pattern.test('/' + rel)) {
                    ignored = !r.negate;
                }
            }
            return ignored;
        };
    }
}
