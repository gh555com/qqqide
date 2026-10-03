// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// transcode-hw.ts — ffmpeg 硬件编码候选（纯函数；转码硬编优选的可测部分）
//
//   ★ 实测基准（bundled ffmpeg 4.1 N-92722 + GTX 1660/1060，2026-10-02）：
//     · -cq 在本版 nvenc 被忽略（19/21/23 产物逐字节相同）→ 质量旋钮 = -rc constqp -qp N；
//     · qp30 ≈ libx264 crf23 veryfast 画质（PSNR 43.07 vs 42.53 dB；体积 10.6MB vs 10.3MB）；
//     · CPU 时间 ≈ 1/5（720p 22s→4s；1080p 43s→9s）——多窗并发转码/弱 CPU 收益更大；
//     · 探测试编必须 ≥640x360（128x128 触发 NVENC "invalid param (8)" 实锤，640x360 通过）。
//
//   候选顺序 = 平台优选；真机可用性由 media-service 探针逐候选实编验证（编进构建 ≠ 机器有硬件）。
//   任一候选失败即试下一个；全败 = 纯软编（libx264），零回归。
// ============================================================================

export interface HwEncCand { name: string; args: string[]; }

/** 平台硬编候选（按优先级）。platform 传 process.platform（单测注入字符串）。 */
export function hwEncCandidatesFor(platform: string): HwEncCand[] {
    if (platform === 'win32') {
        return [
            {
                name: 'h264_nvenc',
                args: ['-c:v', 'h264_nvenc', '-preset', 'medium', '-rc', 'constqp', '-qp', '30', '-pix_fmt', 'yuv420p'],
            },
            {
                name: 'h264_qsv',
                args: ['-c:v', 'h264_qsv', '-global_quality', '26', '-pix_fmt', 'nv12'],
            },
            {
                name: 'h264_amf',
                args: ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '30', '-qp_p', '30', '-pix_fmt', 'yuv420p'],
            },
        ];
    }
    if (platform === 'darwin') {
        return [{ name: 'h264_videotoolbox', args: ['-c:v', 'h264_videotoolbox', '-q:v', '60', '-pix_fmt', 'yuv420p'] }];
    }
    return [];
}

/** 探测试编参数（640x360@30 0.3s 合成源 + 候选编码参数——presence ≠ 可用，必须真编一次）。 */
export function hwProbeArgs(cand: HwEncCand): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.3']
        .concat(cand.args, ['-an', '-f', 'null', '-']);
}
