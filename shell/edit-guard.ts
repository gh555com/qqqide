// edit-guard.ts — 编辑防粘连守卫（纯函数，ipc-edit.ts 唯一调用方）
// 2026-08-07: 根治 HTML/代码围栏边界行粘连（F17 main.ts / F35 shell.css /
//   F73 Roam HTML / F77 main.ts 四起事故，症状: 元素 id 丢失→getElementById
//   null→静默瘫痪或窗口起不来）。
//   ① boundaryNewlineGuard: 保留匹配区首尾换行 — 替换文本不再意外吞掉行边界
//   ② checkStructureText:   CSS 花括号平衡 / HTML button 平衡+嵌套 + 重复 id

export interface GuardResult {
    replace: string;
    notes: string[];
}

// ── ① 边界换行守卫 ─────────────────────────────────────────────────────────
// find 以 \n 开头/结尾 → 匹配区包含该换行。若 replace 丢掉了它，邻接行会被
// 粘连到替换文本上（F17/F77 的 `});sIpc();`、F35 的 CSS 规则粘连、F73 的
// `<button><button` 嵌套均由此产生）。守卫自动补回，保证行边界不消失。
export function boundaryNewlineGuard(find: string, replace: string): GuardResult {
    const notes: string[] = [];
    let out = replace;
    const leadNl = find.length > 0 && find[0] === '\n';
    const tailNl = find.length > 0 && find[find.length - 1] === '\n';
    if (leadNl && !out.startsWith('\n')) {
        out = '\n' + out;
        notes.push('preserved leading newline');
    }
    if (tailNl && !out.endsWith('\n')) {
        out = out + '\n';
        notes.push('preserved trailing newline');
    }
    return { replace: out, notes };
}

// ── ② 结构门 ───────────────────────────────────────────────────────────────
// 返回错误描述（需还原文件）或 null（结构 OK）。
// CSS: 花括号平衡（规则粘连必然破坏配对）。
// HTML: 注释/script/style 剥离后 → button 开闭平衡 + 嵌套检测 + 重复 id。
export function checkStructureText(ext: string, content: string): string | null {
    const e = ext.toLowerCase();

    if (e === '.css') {
        const t = content.replace(/\/\*[\s\S]*?\*\//g, '');
        const opens = (t.match(/\{/g) || []).length;
        const closes = (t.match(/\}/g) || []).length;
        if (opens !== closes) {
            return `CSS brace imbalance: ${opens} '{' vs ${closes} '}' — rules likely glued together or a rule boundary was lost.`;
        }
        return null;
    }

    if (e === '.html' || e === '.htm') {
        let t = content.replace(/<!--[\s\S]*?-->/g, '');
        let prev = '';
        while (prev !== t) {
            prev = t;
            t = t.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
                 .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
        }
        // button 开闭平衡 + 嵌套（button 内嵌 button 是 HTML5 非法结构）
        const btnRe = /<(\/?)\s*button\b[^>]*>/gi;
        let depth = 0;
        let m: RegExpExecArray | null;
        while ((m = btnRe.exec(t)) !== null) {
            if (m[1] === '/') {
                if (depth <= 0) return 'HTML: unmatched </button> — closing tag without a matching open tag.';
                depth--;
            } else {
                depth++;
                if (depth > 1) return 'HTML: nested <button> detected — an opening <button> tag was glued inside another button (button cannot nest).';
            }
        }
        if (depth !== 0) return `HTML: unbalanced <button> — ${depth} opening tag(s) never closed.`;
        // 重复 id（粘连吞掉闭合后，另一个按钮的 id 会重复出现）
        const idRe = /\bid\s*=\s*["']([^"']+)["']/gi;
        const seen = new Set<string>();
        while ((m = idRe.exec(t)) !== null) {
            if (seen.has(m[1])) return `HTML: duplicate id="${m[1]}" — element ids must be unique (typical symptom of line glue).`;
            seen.add(m[1]);
        }
        return null;
    }

    return null;
}
