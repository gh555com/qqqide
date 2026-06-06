// ============================================================================
// content-gateway.js — 内容安全网关
// 所有工具执行结果必须经过此网关后才能进入存储/UI/归档系统。
// 单一真理源：所有截断、二进制检测、大小限制的常量都在这里定义。
//
// 架构铁律：
//   • 网关是工具结果进入系统的唯一入口（agent-loop.js 调用）
//   • 下游（all.txt / UI / conversation）信任网关输出，不再重复检测
//   • tools.js 的 read_file 二进制检测保留，但那是 AI 友好提示，不影响存储安全
// ============================================================================

; (function () {
    'use strict';

    // ═══ 单一真理常量 ═══
    var MAX_STORAGE_CHARS = 100000;   // 存储截断上限（all.txt / conversation / UI）
    var MAX_BINARY_NULLS = 3;         // NULL 字节阈值：前 4000 字符中出现 >3 个 → 二进制
    var MAX_BINARY_RATIO = 0.3;       // 非打印字符占比阈值（不含 \n \r \t）
    var BINARY_SAMPLE_LEN = 4000;     // 二进制检测采样长度
    var OUTPUT_CAP_DEFAULT = 16000;    // AI 视野默认上限（单次工具结果 AI 最多看到这些字符）
    var OUTPUT_CAP_MAX = 65536;       // AI 视野最大上限（AI 传 maxOutput 时可突破到）
    var MAX_RESPONSE_TOKENS = 393216; // AI 回答最大 tokens（DeepSeek 上限 393216，唯一真理在此）
    var COMPACT_MAX_TOKENS = 32768;   // 上下文压缩产出硬限 32K

    // ═══ 二进制检测 ═══
    function detectBinary(str) {
        if (!str || str.length === 0) return false;
        var nullCount = 0;
        var nonPrintable = 0;
        var sampleLen = Math.min(str.length, BINARY_SAMPLE_LEN);
        for (var i = 0; i < sampleLen; i++) {
            var c = str.charCodeAt(i);
            if (c === 0) nullCount++;
            else if (c < 32 && c !== 10 && c !== 13 && c !== 9) nonPrintable++;
        }
        return nullCount > MAX_BINARY_NULLS || (nonPrintable / sampleLen > MAX_BINARY_RATIO);
    }

    // ═══ 主入口：处理工具结果 → 返回安全版本 ═══
    // 输入：工具执行的原始字符串结果
    // 返回：{ safe: string, flags: { binary, truncated, originalSize } }
    function process(rawResult) {
        if (rawResult == null) {
            return { safe: '', flags: { binary: false, truncated: false, originalSize: 0 } };
        }
        var str = typeof rawResult === 'string' ? rawResult : String(rawResult);
        var flags = { binary: false, truncated: false, originalSize: str.length };

        // ① 二进制检测 — 脏数据直接替换为短标记
        if (detectBinary(str)) {
            flags.binary = true;
            return {
                safe: '[BINARY DATA SKIPPED] ' + str.length + ' bytes — not stored to all.txt',
                flags: flags
            };
        }

        // ② 存储截断 — 单条结果不超过 MAX_STORAGE_CHARS
        if (str.length > MAX_STORAGE_CHARS) {
            flags.truncated = true;
            return {
                safe: str.slice(0, MAX_STORAGE_CHARS) +
                    '\n…[TRUNCATED: ' + str.length + ' chars total, ' + MAX_STORAGE_CHARS + ' saved]',
                flags: flags
            };
        }

        // ③ 通过
        return { safe: str, flags: flags };
    }

    // ═══ 暴露到全局 ═══
    window.ContentGateway = {
        process: process,
        detectBinary: detectBinary,
        // 常量暴露（只读参考）
        MAX_STORAGE_CHARS: MAX_STORAGE_CHARS,
        MAX_BINARY_NULLS: MAX_BINARY_NULLS,
        MAX_BINARY_RATIO: MAX_BINARY_RATIO,
        OUTPUT_CAP_DEFAULT: OUTPUT_CAP_DEFAULT,
        OUTPUT_CAP_MAX: OUTPUT_CAP_MAX,
        MAX_RESPONSE_TOKENS: MAX_RESPONSE_TOKENS,
        COMPACT_MAX_TOKENS: COMPACT_MAX_TOKENS
    };

    console.log('[content-gateway] ready — MAX_STORAGE_CHARS=' + MAX_STORAGE_CHARS +
        ' OUTPUT_CAP=' + OUTPUT_CAP_DEFAULT + '/' + OUTPUT_CAP_MAX +
        ' MAX_RESPONSE_TOKENS=' + MAX_RESPONSE_TOKENS + ' COMPACT_MAX_TOKENS=' + COMPACT_MAX_TOKENS);
})();
