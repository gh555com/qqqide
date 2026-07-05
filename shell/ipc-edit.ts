// ============================================================================
// ipc-edit.ts — 编辑工具 IPC: edit_file / create_file / delete_file / write_file
// 含 qwr 机器保护 (_sn / _qe)
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { _sn, _qe, aiNormalizeWhitespace, aiNormalizeCRLF } from './ipc-state';

export function registerEditIpc(): void {
    // edit_file — 三级匹配引擎 (L1精确/L1b CRLF归一化/L2空白归一化/L3逐行)
    ipcMain.handle('qqqide:ai:edit_file', async (_e, args: { path: string; edits: Array<{ find: string; replace: string; replace_all?: boolean }> }) => {
        return _qe(args.path, async () => {
            try {
                // ★ qwr CAS: 检查 _sn 快照 — 若 AI 读后文件被外部修改，拒绝编辑
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
                        // ★ Auto-fix: real \n → literal \n (AI sent literal \n via JSON, became real newline)
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
                    // L1: exact match
                    let idx = content.indexOf(ed.find);
                    let matchLevel = 1;
                    // L1b: CRLF normalization
                    if (idx === -1) {
                        const findNorm = aiNormalizeCRLF(ed.find);
                        const contentNorm = aiNormalizeCRLF(content);
                        idx = contentNorm.indexOf(findNorm);
                        if (idx !== -1) {
                            // Map back to original content
                            let origIdx = 0, normIdx = 0;
                            while (normIdx < idx) {
                                if (content[origIdx] === '\r' && content[origIdx + 1] === '\n') { origIdx += 2; normIdx++; }
                                else if (content[origIdx] === '\r') { origIdx++; normIdx++; }
                                else { origIdx++; normIdx++; }
                            }
                            idx = origIdx;
                            matchLevel = 2;
                        }
                    }
                    // L1c: real \n → escaped \n (AI sent literal \n via JSON, became real newline; file has literal backslash-n)
                    if (idx === -1 && ed.find.indexOf('\n') !== -1) {
                        const escaped = ed.find.replace(/\n/g, '\\n');
                        idx = content.indexOf(escaped);
                        if (idx !== -1) matchLevel = 1;
                    }
                    // L2: whitespace normalization
                    if (idx === -1) {
                        const nf = aiNormalizeWhitespace(ed.find);
                        const nc = aiNormalizeWhitespace(content);
                        idx = nc.indexOf(nf);
                        if (idx !== -1) {
                            let origIdx = 0, normIdx = 0;
                            while (normIdx < idx && origIdx < content.length) {
                                if (content[origIdx] === ' ' || content[origIdx] === '\t' || content[origIdx] === '\r' || content[origIdx] === '\n') {
                                    if (nc[normIdx] === ' ' || nc[normIdx] === '\n') { origIdx++; normIdx++; }
                                    else origIdx++;
                                } else { origIdx++; normIdx++; }
                            }
                            idx = origIdx;
                            matchLevel = 3;
                        }
                    }
                    // L4: raw byte match (Buffer.indexOf, zero processing, last resort)
                    if (idx === -1) {
                        const findBuf = Buffer.from(ed.find, 'utf8');
                        const contentBuf = Buffer.from(content, 'utf8');
                        idx = contentBuf.indexOf(findBuf);
                        if (idx !== -1) matchLevel = 5;
                    }
                    if (idx === -1) {
                        var _h = '';
                        if (ed.find.length > 80) _h = ' (long text — try shorter match)';
                        var _f20 = ed.find.slice(0, 40);
                        var _pos = content.indexOf(_f20);
                        if (_pos !== -1) {
                            var _ln = (content.slice(0, _pos).match(/\n/g) || []).length + 1;
                            _h += '\n💡 Find starts: "' + _f20.replace(/\n/g,'\\n') + '"... Occurs at line ' + _ln + '. Check whitespace/escaping difference.';
                        }
                        return `Error: edit #${i + 1} match failed — text not found in ${args.path.split(/[\\/]/).pop()}.${_h}`;
                    }
                    matchPlan.push({ edit: ed, match: { start: idx, end: idx + ed.find.length, matchLevel }, index: i });
                }

                // Pass 2: apply edits
                const editLines: string[] = [];
                for (let pi = 0; pi < matchPlan.length; pi++) {
                    const plan = matchPlan[pi];
                    const ed = plan.edit;
                    const preContent = content.slice(0, plan.match.start);
                    const lineNum = (preContent.match(/\n/g) || []).length + 1;
                    if (ed.replace_all) {
                        const count = content.split(ed.find).length - 1;
                        let allLines: number[] = [];
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
                        content = content.slice(0, plan.match.start) + ed.replace + content.slice(plan.match.start + ed.find.length);
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
                            multiWarn += ` ⚠️ edit #${pi + 1}: ${count} candidates found, applied to first (L${plan.match.matchLevel})`;
                        }
                    }
                }

                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, content);
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                const matchInfo = results.some(r => r.indexOf('L2') !== -1 || r.indexOf('L3') !== -1 || r.indexOf('L4') !== -1)
                    ? ' (whitespace-tolerant match used)' : '';
                let lineInfo = editLines.length > 0 ? ' [' + editLines.join(', ') + ']' : '';
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
                try { await fs.promises.access(args.path); return `Error: file already exists: ${args.path}. Use edit_file to modify existing files.`; } catch { /* doesn't exist, proceed */ }
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, args.content);
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
                try { await fs.promises.mkdir(path.dirname(args.path), { recursive: true }); } catch { /* ignore */ }
                await fs.promises.writeFile(args.path, args.content);
                try { const st2 = await fs.promises.stat(args.path); _sn[args.path] = { mtimeMs: st2.mtimeMs, size: st2.size }; } catch { /* ignore */ }
                return `File written: ${args.path} (${args.content.length} chars)`;
            } catch (err: any) {
                return 'Error writing file: ' + (err.message || err);
            }
        });
    });
}
