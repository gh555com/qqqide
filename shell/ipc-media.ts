// ============================================================================
// ipc-media.ts — 图像生成/分析 IPC: generate_image / analyze_image
// ============================================================================

import { ipcMain } from 'electron';
import * as path from 'path';
import { execFile } from 'child_process';
import { getPythonExe } from './ipc-state';

export function registerMediaIpc(portableRoot: string): void {
    const _pythonExe = getPythonExe(portableRoot);

    // generate_image — 通义万相文生图 (1 IPC → Python sidecar)
    ipcMain.handle('qqqide:ai:generate_image', async (_e, args: { prompt: string; style?: string; size?: string; n?: number; out_dir?: string }) => {
        const script = path.join(portableRoot, 'engines', 'wanx_gen.py');
        const cmdArgs = ['-u', script, '--prompt', args.prompt, '--size', args.size || '1024*1024', '--verbose'];
        if (args.style) { cmdArgs.push('--style', args.style); }
        if (args.n) { cmdArgs.push('--n', String(args.n)); }
        if (args.out_dir) { cmdArgs.push('--out-dir', args.out_dir); }
        return new Promise((resolve) => {
            execFile(_pythonExe, cmdArgs, { timeout: 300000, maxBuffer: 65536 }, (err, stdout, stderr) => {
                if (stderr && stderr.trim()) {
                    console.log('[wanx]', stderr.trim().replace(/\n/g, '\n[wanx] '));
                }
                if (err) {
                    resolve('Image generation failed (exit ' + (err as any).code + '): ' + ((stdout || '') + (stderr || '')).slice(0, 800));
                    return;
                }
                const out = (stdout || '').trim();
                try {
                    const parsed = JSON.parse(out);
                    if (parsed.ok && parsed.paths) {
                        const prefix = parsed.cached
                            ? '[cache hit] Generated '
                            : '[generated in ' + (parsed.elapsed || '?') + 's, ' + (parsed.polls || '?') + ' polls] Generated ';
                        resolve(prefix + parsed.paths.length + ' image(s):\n' + parsed.paths.map((p: string, i: number) => '  ' + (i + 1) + '. ' + p).join('\n'));
                    } else {
                        resolve('Image generation error: ' + (parsed.error || out));
                    }
                } catch (_) {
                    resolve('Image generation output (unexpected format): ' + out.slice(0, 1000));
                }
            });
        });
    });

    // analyze_image — qwen-vl 视觉理解 (1 IPC → Python sidecar)
    ipcMain.handle('qqqide:ai:analyze_image', async (_e, args: { image: string; action: string; detail?: string; targets?: string; question?: string }) => {
        const script = path.join(portableRoot, 'engines', 'wanx_vision.py');
        const cmdArgs = ['-u', script, '--image', args.image, '--action', args.action || 'describe'];
        if (args.detail) { cmdArgs.push('--detail', args.detail); }
        if (args.targets) { cmdArgs.push('--targets', args.targets); }
        if (args.question) { cmdArgs.push('--question', args.question); }
        return new Promise((resolve) => {
            execFile(_pythonExe, cmdArgs, { timeout: 60000, maxBuffer: 65536 }, (err, stdout, stderr) => {
                if (err) {
                    resolve('Image analysis failed (exit ' + (err as any).code + '): ' + ((stdout || '') + (stderr || '')).slice(0, 800));
                    return;
                }
                const out = (stdout || '').trim();
                try {
                    const parsed = JSON.parse(out);
                    if (parsed.ok) {
                        resolve(JSON.stringify(parsed.data, null, 2));
                    } else {
                        resolve('Image analysis error: ' + (parsed.error || out));
                    }
                } catch (_) {
                    resolve(out.slice(0, 2000));
                }
            });
        });
    });
}
