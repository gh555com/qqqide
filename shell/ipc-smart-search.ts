// ============================================================================
// ipc-smart-search.ts — search_smart IPC handler
// 语义搜索 + 正则搜索 + 符号搜索 三路并行合并
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IndexService } from './index-service';

// Re-export for external use
export { IndexService };

// Skip dirs list (shared with ipc-search.ts)
const REGEX_SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'backup', '__pycache__', '.venv', 'vendor',
    'build', 'out', '.next', '.nuxt', '.cache', 'coverage', 'target', 'logs',
    '.hg', '.svn', 'bower_components', '.idea', '.vs', 'cache', 'temp',
    'crashDumps', 'dist-pack', 'shell-out', 'shell-build', '.qoder',
    'qqq', 'userData', 'logs', 'new_log', 'tmp', 'op'
]);

const REGEX_SKIP_EXTS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin', '.png', '.jpg', '.jpeg',
    '.gif', '.bmp', '.webp', '.ico', '.mp3', '.mp4', '.avi', '.mkv',
    '.mov', '.wav', '.flac', '.ogg', '.zip', '.tar', '.gz', '.xz',
    '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.pdf',
    '.vsix', '.wasm', '.class', '.o', '.obj', '.pyc', '.pyo', '.sqlite',
    '.db', '.lock', '.otf'
]);

const REGEX_MAX_FILE = 5 * 1024 * 1024;
const REGEX_MAX_RESULTS = 20;
const REGEX_TIMEOUT = 2500;  // 2.5s timeout per regex search

export function registerSmartSearchIpc(indexService: IndexService): void {
    ipcMain.handle('qqqide:ai:search_smart', async (_e, args: {
        query: string;
        topK?: number;
        path?: string;
        paths?: string[];
        regex?: string;          // optional explicit regex (auto-extracted if empty)
        includeRegex?: boolean;  // default true
        returnStructured?: boolean;  // ★ when true, return {text, bm25: [...]} for embedding re-rank
    }) => {
        const query = args.query;
        const topK = args.topK || 10;
        const includeRegex = args.includeRegex !== false;
        const returnStructured = args.returnStructured === true;
        const searchPaths: string[] = args.paths || (args.path ? [args.path] : []);
        const explicitRegex = args.regex || null;

        // ── Parse query for search hints ──
        // If query looks like a filename (contains .ext or /path/), emphasize regex
        const looksLikePath = /[\/\\]/.test(query) || /\.[a-z]{1,6}$/i.test(query);

        // ── Smart regex extraction from query ──
        // Extract CamelCase, snake_case, kebab-case identifiers for regex search
        const identifiers = query.match(/[a-zA-Z_]\w{2,}/g) || [];
        const regexQuery = explicitRegex || (
            identifiers.length > 0
                ? identifiers.slice(0, 3).join('|')  // top 3 identifiers as OR pattern
                : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // literal escape
        );

        // ═══════════════════════════════════════════════════════════════
        // Phase 1: Semantic search (BM25 + symbols) — always runs
        // ═══════════════════════════════════════════════════════════════
        const semanticResults: string[][] = [];
        const bm25Structured: Array<{ filePath: string; line?: number; snippet: string; score: number; matchType: string }> = [];
        let bm25Ran = false;
        if (indexService.isReady) {
            const { results, indexReady } = indexService.search(query, topK);
            if (indexReady) {
                const lines: string[] = [];
                for (const r of results) {
                    const projectRoot = (indexService as any).rootDir || '';
                    const absPath = path.join(projectRoot, r.filePath);
                    const snippet = r.snippet.length > 200 ? r.snippet.slice(0, 200) + '...' : r.snippet;
                    lines.push(`[${r.matchType.toUpperCase()}] ${r.filePath}${r.line ? ':' + r.line : ''} (score:${r.score.toFixed(1)})\n  ${snippet}`);
                    // ★ Capture structured data for embedding re-rank
                    bm25Structured.push({
                        filePath: r.filePath,
                        line: r.line,
                        snippet: r.snippet,
                        score: r.score,
                        matchType: r.matchType
                    });
                }
                semanticResults.push(lines.length > 0 ? lines : []);
                bm25Ran = true;
            }
            // ★ 索引未就绪时不报状态 — 静默降级，正则兜底
        }
        // ★ 索引完全未初始化也不报 — AI 不需要知道基础设施状态

        // ═══════════════════════════════════════════════════════════════
        // Phase 2: Regex search — reuses index file list when ready
        // ═══════════════════════════════════════════════════════════════
        const regexResults: string[] = [];
        if (includeRegex && !looksLikePath) {
            let regex: RegExp;
            try { regex = new RegExp(regexQuery, 'i'); }
            catch { regex = new RegExp(regexQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }

            const matches: string[] = [];
            const startTime = Date.now();
            const rootDir = (indexService as any).rootDir || process.cwd();

            if (indexService.isReady) {
                // ★ Fast path: reuse index manifest file list — skip directory walk
                const filePaths = indexService.getFilePaths();
                for (const relPath of filePaths) {
                    if (matches.length >= REGEX_MAX_RESULTS) break;
                    if (Date.now() - startTime > REGEX_TIMEOUT) break;
                    const full = path.join(rootDir, relPath);
                    try {
                        const st = await fs.promises.stat(full);
                        if (!st || st.size > REGEX_MAX_FILE) continue;
                        const content = await fs.promises.readFile(full, 'utf8');
                        const lines = content.split('\n');
                        for (let li = 0; li < lines.length && matches.length < REGEX_MAX_RESULTS; li++) {
                            if (regex.test(lines[li])) {
                                matches.push(relPath + ':' + (li + 1) + ':' + lines[li].trim().slice(0, 150));
                            }
                        }
                    } catch { /* skip */ }
                }
            } else {
                // ★ Fallback: directory walk (index not ready yet)
                const searchDirs = searchPaths.length > 0 ? searchPaths : [rootDir];
                const walk = async (dir: string, depth: number): Promise<void> => {
                    if (depth > 6 || matches.length >= REGEX_MAX_RESULTS) return;
                    if (Date.now() - startTime > REGEX_TIMEOUT) return;
                    let entries: fs.Dirent[];
                    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
                    catch { return; }
                    for (const ent of entries) {
                        if (matches.length >= REGEX_MAX_RESULTS) break;
                        if (Date.now() - startTime > REGEX_TIMEOUT) return;
                        if (ent.name.startsWith('.') && ent.isDirectory()) continue;
                        if (ent.isDirectory() && REGEX_SKIP_DIRS.has(ent.name)) continue;
                        const full = path.join(dir, ent.name);
                        if (ent.isDirectory()) {
                            await walk(full, depth + 1);
                        } else {
                            const ext = path.extname(ent.name).toLowerCase();
                            if (REGEX_SKIP_EXTS.has(ext)) continue;
                            try {
                                const st = await fs.promises.stat(full);
                                if (!st || st.size > REGEX_MAX_FILE) continue;
                                const content = await fs.promises.readFile(full, 'utf8');
                                const lines = content.split('\n');
                                for (let li = 0; li < lines.length && matches.length < REGEX_MAX_RESULTS; li++) {
                                    if (regex.test(lines[li])) {
                                        const relPath = full.replace(/\\/g, '/');
                                        matches.push(relPath + ':' + (li + 1) + ':' + lines[li].trim().slice(0, 150));
                                    }
                                }
                            } catch { /* skip */ }
                        }
                    }
                };
                for (const d of searchDirs) {
                    if (Date.now() - startTime > REGEX_TIMEOUT) break;
                    if (matches.length >= REGEX_MAX_RESULTS) break;
                    await walk(d, 0);
                }
            }

            for (const m of matches) {
                regexResults.push('[REGEX] ' + m);
            }
            if (regexResults.length === 0) {
                regexResults.push('[REGEX] No matches for pattern: ' + regexQuery);
            }
        } else if (looksLikePath) {
            regexResults.push('[REGEX] Skipped (query looks like a path)');
        }

        // ═══════════════════════════════════════════════════════════════
        // Phase 3: Merge & format output
        // ═══════════════════════════════════════════════════════════════
        const output: string[] = [];

        output.push('══════ SEARCH SMART: "' + query + '" ══════');
        output.push('');

        // Semantic results (BM25 + symbols)
        if (bm25Ran && semanticResults.length > 0 && semanticResults[0].length > 0) {
            output.push('── Semantic (BM25) ──');
            output.push(...semanticResults[0]);
            output.push('');
        }

        // Regex results
        if (regexResults.length > 0 && includeRegex) {
            const hasRealMatches = !regexResults[0].startsWith('[REGEX] No match') && !regexResults[0].startsWith('[REGEX] Skipped');
            if (hasRealMatches) {
                output.push('── Regex ──');
                output.push(...regexResults);
            }
        }

        if (output.length <= 2) {
            output.push('No results found for "' + query + '"');
            // ★ 索引未就绪时给 AI 可操作建议（而非基础设施状态）
            if (!indexService.isReady) {
                output.push('Tip: index is warming up. Use search_text for exact pattern matching in the meantime.');
            } else {
                output.push('Try: different keywords, check spelling, or use search_text for exact regex');
            }
        }

        // Stats footer — factual, no discouraging status
        output.push('');
        output.push('── Stats ──');
        if (indexService.isReady) {
            output.push('Index: ' + indexService.fileCount + ' files, ' + indexService.symbolCount + ' symbols, ' + indexService.chunkCount + ' chunks');
        }
        if (bm25Ran) {
            output.push('BM25: ' + (semanticResults[0] ? semanticResults[0].length : 0) + ' results');
        }
        if (includeRegex && regexResults.length > 0 && !regexResults[0].startsWith('[REGEX] No match') && !regexResults[0].startsWith('[REGEX] Skipped')) {
            output.push('Regex: ' + regexResults.length + ' matches (pattern: ' + regexQuery + ')');
        }

        const textOutput = output.join('\n');

        // ★ Structured mode: return JSON for embedding re-rank in tools.js
        if (returnStructured) {
            // Build symbol graph edges for matched symbols
            const symbolGraph: Array<{ symbol: string; kind: string; definingFiles: string[]; importingFiles: string[]; exportingFiles: string[] }> = [];
            if (indexService.isReady) {
                const fullGraph = indexService.getSymbolGraph();
                const seenSyms = new Set<string>();
                for (const r of bm25Structured) {
                    if (r.matchType !== 'symbol') continue;
                    // Extract symbol name from snippet (format: "symbol: fnName [kind]")
                    const symMatch = r.snippet.match(/^symbol:\s*(\S+)/);
                    if (!symMatch) continue;
                    const symName = symMatch[1];
                    if (seenSyms.has(symName)) continue;
                    seenSyms.add(symName);
                    const ge = fullGraph[symName];
                    if (ge) {
                        // Determine kind from snippet
                        const kindMatch = r.snippet.match(/\[(\w+)\]/);
                        symbolGraph.push({
                            symbol: symName,
                            kind: kindMatch ? kindMatch[1] : '?',
                            definingFiles: ge.definingFiles.slice(0, 5),
                            importingFiles: ge.importingFiles.slice(0, 10),
                            exportingFiles: ge.exportingFiles.slice(0, 5)
                        });
                    }
                }
            }

            return {
                text: textOutput,
                bm25: bm25Structured,
                bm25Ran: bm25Ran,
                symbolGraph: symbolGraph,
                indexReady: indexService.isReady,
                fileCount: indexService.isReady ? indexService.fileCount : 0,
                chunkCount: indexService.isReady ? indexService.chunkCount : 0
            };
        }

        return textOutput;
    });
}
