// ============================================================================
// ipc-edit.ts — 编辑工具 IPC: edit_file / create_file / delete_file / write_file
// 含 qwr 机器保护 (_sn / _qe)
//
// edit_file 五级匹配引擎:
//   L1 — 精确匹配
//   L1b — CRLF 归一化（\r\n→\n, \r→\n）
//   L2  — 空白归一化（[\t ]+→' ', [\r\n]+→\n）
//   L3  — 行级匹配（逐行trim后序列比对）
//   L5  — 原始字节匹配（Buffer.indexOf，不做任何处理）
//
// ★ 2026-07-09 空白安全加固:
//   L1b/L2 匹配后用 measureMatchSpan() 测量原文实际 span，而非 trust find.length。
//   根除因 whitespace compression 导致 find.length ≠ 实际原文 span
//   从而切错位置、文件损坏的 bug。适用于一切语言、一切场景，零代价。
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as vm from 'vm';
import { _sn, _qe, aiNormalizeWhitespace, aiNormalizeCRLF } from './ipc-state';

// ── 空白匹配 span 测量 ──────────────────────────────────────────────────────
// 在归一化匹配成功后，用原始 find 文本的归一化版本，在原始内容中从 start 向后
// 逐字节推进 → 每次归一化 [start, end) → 与 normFind 比较 → 相等时返回 span 长度。
// 这是唯一正确的方式：不依赖 find.length，只认原文的实际归一化结果。
function measureMatchSpan(orig: string, start: number, findText: string,
    normFn: (s: string) => string): number {
    const normFind = normFn(findText);
    for (let end = start + 1; end <= orig.length; end++) {
        if (normFn(orig.slice(start, end)) === normFind) {
            return end - start;
        }
    }
    // 兜底：如果归一化后永远不等（理论上不可能），fallback 到这里
    return findText.length;
}

// ── 自动语法门（§59，2026-07-14 落地）────────────────────────
// 每次 edit/create/write 后自动跑语法检查。不通过→拒绝提交+还原文件。
// ★ 使用 vm.Script 同进程解析（零 spawn，秒级完成，无 Electron 二进制兼容问题）。
//   vm.Script 与 node --check 用同一 V8 解析器，等效。
//   ES module 文件（.mjs/.cjs）跳过 vm.Script，改为 try/catch new Function 降级检查。
function checkSyntaxSync(filePath: string, originalContent: string | null, matchCtx?: string): string | null {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.js') {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            new vm.Script(content, { filename: filePath });
        } catch (syntaxErr: any) {
            const msg = (syntaxErr.message || String(syntaxErr)).replace(/\n/g, ' ').substring(0, 250);
            if (originalContent !== null) {
                try { fs.writeFileSync(filePath, originalContent); } catch (_) {}
            } else {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
            let hint = matchCtx ? ' (' + matchCtx + ')' : '';
            return 'Error: your edit produced invalid JS syntax — ' + msg + hint + '. File reverted unchanged. ⚠ Your find string likely matched at the WRONG location. Re-read the file, then use a LONGER / more unique find string (add surrounding context lines).';
        }
    } else if (ext === '.mjs' || ext === '.cjs') {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            new Function(content);
        } catch (syntaxErr: any) {
            const msg = (syntaxErr.message || String(syntaxErr)).replace(/\n/g, ' ').substring(0, 250);
            if (originalContent !== null) {
                try { fs.writeFileSync(filePath, originalContent); } catch (_) {}
            } else {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
            return 'Error: your edit produced invalid ES module syntax — ' + msg + '. File reverted unchanged. Re-read the file and use a more precise find string.';
        }
    } else if (ext === '.json') {
        try {
            const jsonContent = fs.readFileSync(filePath, 'utf8');
            JSON.parse(jsonContent);
        } catch (jsonErr: any) {
            const msg = (jsonErr.message || String(jsonErr)).replace(/\n/g, ' ').substring(0, 250);
            if (originalContent !== null) {
                try { fs.writeFileSync(filePath, originalContent); } catch (_) {}
            } else {
                try { fs.unlinkSync(filePath); } catch (_) {}
            }
            return 'Error: your edit produced invalid JSON — ' + msg + '. File reverted unchanged. Check bracket/brace balance in your replace text.';
        }
    }

    return null; // OK
}

export function registerEditIpc(): void {
    ipcMain.handle('qqqide:ai:edit_file', async (_e, args: { path: string; edits: Array<{ find: string; replace: string; replace_all?: boolean }> }) => {
        return _qe(args.path, async () => {
            try {
                const snap = _sn[args.path];
                if (snap) {
                    try {
                        const st = await fs.promises.stat(args.path);
                        if (st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) {
                            return 'Error: file has been modified externally since last read. Please re-read the file and try again.';
                        }
                    } catch (_) { /* stat failed, proceed */ }
                }

                const originalContent = await fs.promises.readFile(args.path, 'utf8');
                let content = originalContent;
                const matchPlan: Array<{ edit: any; match: { start: number; end: number; matchLevel: number }; index: number }> = [];
                const results: string[] = [];
                let totalApplied = 0;

                // Pass 1: find all matches
                for (let i = 0; i < args.edits.length; i++) {
                    const ed = args.edits[i];
                    if (ed.replace_all) {
                        let count = content.split(ed.find).length - 1;
                        if (count === 0 && ed.find.indexOf('\n') !== -1) {
                            const escaped = ed.find.replace(/\n/g, '\\n');
                            const count2 = content.split(escaped).length - 1;
                            if (count2 > 0) { ed.find = escaped; count = count2; }
                        }
                        if (count === 0) {
                            return `Error: edit #${i + 1} match failed — text not found in ${args.path.split(/[\\/]/).pop()}. (checked exact match)`;
                        }
                        matchPlan.push({ edit: ed, match: { start: 0, end: 0, matchLevel: 1 }, index: i });
                        continue;
                    }

                    let matchStart = -1;
                    let matchSpan = ed.find.length; // L1 精确匹配：find.length 就是实际 span
                    let matchLevel = 1;

                    // L1: exact match
                    let idx = content.indexOf(ed.find);
                    if (idx !== -1) {
                        matchStart = idx;
                        matchLevel = 1;
                    }

                    // L1b: CRLF normalization
                    if (matchStart === -1) {
                        const findNorm = aiNormalizeCRLF(ed.find);
                        const contentNorm = aiNormalizeCRLF(content);
                        const normIdx = contentNorm.indexOf(findNorm);
                        if (normIdx !== -1) {
                            // 映射归一化下标 → 原文下标
                            let oi = 0, ni = 0;
                            while (ni < normIdx && oi < content.length) {
                                if (content[oi] === '\r' && content[oi + 1] === '\n') { oi += 2; ni++; }
                                else if (content[oi] === '\r') { oi++; ni++; }
                                else { oi++; ni++; }
                            }
                            matchStart = oi;
                            matchSpan = measureMatchSpan(content, oi, ed.find, aiNormalizeCRLF);
                            matchLevel = 2;
                        }
                    }

                    // L1c: real \n → escaped \n
                    if (matchStart === -1 && ed.find.indexOf('\n') !== -1) {
                        const escaped = ed.find.replace(/\n/g, '\\n');
                        idx = content.indexOf(escaped);
                        if (idx !== -1) {
                            matchStart = idx;
                            matchLevel = 1;
                        }
                    }

                    // L2: whitespace normalization (with context verification for short finds)
                    if (matchStart === -1) {
                        const nf = aiNormalizeWhitespace(ed.find);
                        const nc = aiNormalizeWhitespace(content);
                        let normIdx = -1;
                        let searchFrom = 0;
                        // For short normalized finds (<30 chars), verify line-anchoring
                        // to avoid matching at wrong position when find appears many times
                        while ((normIdx = nc.indexOf(nf, searchFrom)) !== -1) {
                            let oi = 0, ni = 0;
                            while (ni < normIdx && oi < content.length) {
                                const c = content[oi];
                                if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
                                    const ncChar = nc[ni];
                                    if (ncChar === ' ' || ncChar === '\n') { oi++; ni++; }
                                    else oi++;
                                } else { oi++; ni++; }
                            }
                            // Verification: for short finds, match must be at line start
                            if (nf.length >= 30) break; // long finds: first match is fine
                            if (oi === 0 || content[oi - 1] === '\n') break; // line start: accept
                            // Also accept if preceded by whitespace and find starts with non-structural char
                            const firstChar = nf[0];
                            if (firstChar !== '}' && firstChar !== ')' && firstChar !== ';' && firstChar !== ']') break;
                            searchFrom = normIdx + 1;
                        }
                        if (normIdx !== -1) {
                            // Re-map from final normIdx
                            let oi2 = 0, ni2 = 0;
                            while (ni2 < normIdx && oi2 < content.length) {
                                const c = content[oi2];
                                if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
                                    const ncChar = nc[ni2];
                                    if (ncChar === ' ' || ncChar === '\n') { oi2++; ni2++; }
                                    else oi2++;
                                } else { oi2++; ni2++; }
                            }
                            matchStart = oi2;
                            matchSpan = measureMatchSpan(content, oi2, ed.find, aiNormalizeWhitespace);
                            matchLevel = 3;
                        }
                    }

                    // L3: line-level matching (trim each line, match sequence)
                    if (matchStart === -1) {
                        const fl = ed.find.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                        if (fl.length >= 2) {
                            const cl2 = content.split('\n');
                            for (let li = 0; li <= cl2.length - fl.length; li++) {
                                let ok = true;
                                for (let lj = 0; lj < fl.length; lj++) {
                                    if (cl2[li + lj].trim() !== fl[lj]) { ok = false; break; }
                                }
                                if (ok) {
                                    matchStart = cl2.slice(0, li).join('\n').length + (li > 0 ? 1 : 0);
                                    matchSpan = cl2.slice(0, li + fl.length).join('\n').length - matchStart;
                                    matchLevel = 4;
                                    break;
                                }
                            }
                        }
                    }

                    // L5: raw byte match (Buffer.indexOf)
                    if (matchStart === -1) {
                        const findBuf = Buffer.from(ed.find, 'utf8');
                        const contentBuf = Buffer.from(content, 'utf8');
                        const bufIdx = contentBuf.indexOf(findBuf);
                        if (bufIdx !== -1) {
                            // bufIdx is byte offset → decode prefix to get character offset
                            matchStart = contentBuf.subarray(0, bufIdx).toString('utf8').length;
                            // find is a JS string, .length = character count (correct span)
                            matchSpan = ed.find.length;
                            matchLevel = 5;
                        }
                    }

                    if (matchStart === -1) {
                        let _h = '';
                        if (ed.find.length > 80) _h = ' (long text — try shorter match)';
                        const _f20 = ed.find.slice(0, 40);
                        const _pos = content.indexOf(_f20);
                        if (_pos !== -1) {
                            const _ln = (content.slice(0, _pos).match(/\n/g) || []).length + 1;
                            _h += `\n💡 Find starts: "${_f20.replace(/\n/g, '\\n')}"... Occurs at line ${_ln}. Check whitespace/escaping difference.`;
                        }
                        return `Error: edit #${i + 1} match failed — text not found in ${args.path.split(/[\\/]/).pop()}.${_h}`;
                    }

                    matchPlan.push({
                        edit: ed,
                        match: { start: matchStart, end: matchStart + matchSpan, matchLevel },
                        index: i
                    });
                }

                // Pass 2: apply edits (保持提交顺序，AI 依赖顺序语义)
                const editLines: string[] = [];
                for (let pi = 0; pi < matchPlan.length; pi++) {
                    const plan = matchPlan[pi];
                    const ed = plan.edit;
                    if (ed.replace_all) {
                        const count = content.split(ed.find).length - 1;
                        const allLines: number[] = [];
                        let pos = 0;
                        while (pos < content.length) {
                            const idx2 = content.indexOf(ed.find, pos);
                            if (idx2 === -1) break;
                            allLines.push((content.slice(0, idx2).match(/\n/g) || []).length + 1);
                            pos = idx2 + 1;
                        }
                        content = content.split(ed.find).join(ed.replace);
                        results.push(`#${pi + 1}: all (${count}x, L${plan.match.matchLevel}, lines ${allLines.join(',')})`);
                        editLines.push(`#${pi + 1}: lines ${allLines.join(',')} (${count}x replace_all)`);
                        totalApplied += count;
                    } else {
                        const preContent = content.slice(0, plan.match.start);
                        const lineNum = (preContent.match(/\n/g) || []).length + 1;
                        content = content.slice(0, plan.match.start) + ed.replace + content.slice(plan.match.end);
                        results.push(`L${plan.match.matchLevel} @L${lineNum}`);
                        editLines.push(`#${pi + 1}: L${lineNum} (L${plan.match.matchLevel})`);
                        totalApplied++;
                    }
                }

                // Multi-candidate warning
                let multiWarn = '';
                for (let pi = 0; pi < matchPlan.length; pi++) {
                    const plan = matchPlan[pi];
                    if (plan.match.matchLevel >= 2 && !plan.edit.replace_all) {
                        const nf = aiNormalizeWhitespace(plan.edit.find);
                        const nc = aiNormalizeWhitespace(originalContent);
                        let count = 0;
                        let pos = 0;
                        while ((pos = nc.indexOf(nf, pos)) !== -1) { count++; pos++; }
                        if (count > 1) {
                            multiWarn += ` ⚠️ edit #${plan.match.index + 1}: ${count} candidates found, applied to first (L${plan.match.matchLevel})`;
                        }
                    }
                }

                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, content);
                // ★ 自动语法门（§59）: JS/JSON 语法不过→还原+报错
                const syntaxCtx = multiWarn || (results.some(r => r.indexOf('L2') !== -1 || r.indexOf('L3') !== -1 || r.indexOf('L4') !== -1 || r.indexOf('L5') !== -1) ? 'whitespace-tolerant matching used — higher mismatch risk' : '');
                const syntaxErr = checkSyntaxSync(args.path, originalContent, syntaxCtx || undefined);
                if (syntaxErr) return syntaxErr;
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                const matchInfo = results.some(r => r.indexOf('L2') !== -1 || r.indexOf('L3') !== -1 || r.indexOf('L4') !== -1 || r.indexOf('L5') !== -1)
                    ? ' (whitespace-tolerant match used)' : '';
                const lineInfo = editLines.length > 0 ? ' [' + editLines.join(', ') + ']' : '';
                return `\u2713 ${totalApplied} edit(s) applied to ${args.path.split(/[\\/]/).pop()}${lineInfo}${matchInfo}${multiWarn}`;
            } catch (err: any) {
                return 'Error editing file: ' + (err.message || err);
            }
        });
    });

    // create_file
    ipcMain.handle('qqqide:ai:create_file', async (_e, args: { path: string; content: string }) => {
        return _qe(args.path, async () => {
            try {
                try { await fs.promises.access(args.path); return `Error: file already exists: ${args.path}. Use edit_file to modify existing files.`; } catch { /* doesn\x27t exist, proceed */ }
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, args.content);
                // ★ 自动语法门
                const syntaxErr2 = checkSyntaxSync(args.path, null, undefined);
                if (syntaxErr2) return syntaxErr2;
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                return `File created: ${args.path} (${args.content.length} chars)`;
            } catch (err: any) {
                return 'Error creating file: ' + (err.message || err);
            }
        });
    });

    // delete_file
    ipcMain.handle('qqqide:ai:delete_file', async (_e, args: { path: string }) => {
        return _qe(args.path, async () => {
            try {
                try { await fs.promises.access(args.path); } catch { return `Error: file not found: ${args.path}`; }
                await fs.promises.unlink(args.path);
                delete _sn[args.path];
                return `Deleted: ${args.path}`;
            } catch (err: any) {
                return 'Error deleting file: ' + (err.message || err);
            }
        });
    });

    // write_file
    ipcMain.handle('qqqide:ai:write_file', async (_e, args: { path: string; content: string }) => {
        return _qe(args.path, async () => {
            try {
                const snap = _sn[args.path];
                if (snap) {
                    try {
                        const st = await fs.promises.stat(args.path);
                        if (st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) {
                            return 'Error: file has been modified externally since last read. Please re-read the file and try again.';
                        }
                    } catch (_) { }
                }
                // 捕获原始内容（用于语法检查失败时还原）
                let origContent: string | null = null;
                try { origContent = await fs.promises.readFile(args.path, 'utf8'); } catch (_) {}
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, args.content);
                // ★ 自动语法门
                const syntaxErr3 = checkSyntaxSync(args.path, origContent, undefined);
                if (syntaxErr3) return syntaxErr3;
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                return `File written: ${args.path} (${args.content.length} chars)`;
            } catch (err: any) {
                return 'Error writing file: ' + (err.message || err);
            }
        });
    });
}
