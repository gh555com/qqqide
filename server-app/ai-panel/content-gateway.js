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
    var OUTPUT_CAP_DEFAULT = 200000;    // AI 视野默认上限（单次工具结果 AI 最多看到这些字符）
    var OUTPUT_CAP_MAX = 800000;       // AI 视野最大上限（AI 传 maxOutput 时可突破到）
    var MAX_RESPONSE_TOKENS = 393216; // AI 回答最大 tokens（上限 393216，唯一真理在此）
    var READ_FILE_CAP_BYTES = 200000;  // read_file 单次返回字节上限（～200KB，超过则截断+分页提示）
    // ═══ 网络超时参数（单一真理源：改一处全局生效） ═══
    var FETCH_DEADLINE_PRIMARY_MS = 1000000;   // 主线直连（绕过 CF），对齐 Nginx+Go 1000s，仅作兜底天花板
    var FETCH_DEADLINE_FALLBACK_MS = 1000000;  // 备线走 CF Worker，实测 CF Proxy 有心跳流不掐 100s
    var STREAM_WATCHDOG_MS = 60000;           // SSE 流看门狗 60s（Go 心跳 25~30s，2 轮心跳未复位即判死）

    // ═══ 模型上下文窗口参数（换模型只需改这里） ═══
    var CTX_MAX_TOKENS = 1048565;     // 上下文窗口总上限（实测精确值）
    var COMPRESS_THRESHOLD = 200000;  // 压缩触发阈值（200k tokens，约 20% 窗口）
    var MAX_TOKENS_SAFETY = 10000;    // max_tokens 帽安全余量
    var CHAR_PER_TOKEN = 2.5;         // 统一 chars→tokens 估算比例（2026-06-22 校准: 3.0→2.7）
    // 单专家统一压缩参数（tier 6, 64K max_tokens）
    var COMPACT_MAX_TOKENS = 65536;       // 单专家统一 max_tokens（旧三专家 3×32K 已废弃）
    var ARCHIVE_MAX_CHARS = 1000000;      // archive 硬上限 ~1M chars
    var COMPACT_DEBUG = true;            // 压缩埋点开关（调试期开，稳定后关）

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
    // 键入：工具执行的原始字符串结果
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
        READ_FILE_CAP_BYTES: READ_FILE_CAP_BYTES,
        READ_FILE_CAP_KB: Math.round(READ_FILE_CAP_BYTES / 1024),
        COMPACT_MAX_TOKENS: COMPACT_MAX_TOKENS,
        // 网络超时参数
        FETCH_DEADLINE_PRIMARY_MS: FETCH_DEADLINE_PRIMARY_MS,
        FETCH_DEADLINE_FALLBACK_MS: FETCH_DEADLINE_FALLBACK_MS,
        STREAM_WATCHDOG_MS: STREAM_WATCHDOG_MS,
        // 模型上下文窗口参数
        CTX_MAX_TOKENS: CTX_MAX_TOKENS,
        COMPRESS_THRESHOLD: COMPRESS_THRESHOLD,
        MAX_TOKENS_SAFETY: MAX_TOKENS_SAFETY,
        CHAR_PER_TOKEN: CHAR_PER_TOKEN,
        // 单专家统一阀值
        COMPACT_MAX_TOKENS: COMPACT_MAX_TOKENS,
        ARCHIVE_MAX_CHARS: ARCHIVE_MAX_CHARS,
        COMPACT_DEBUG: COMPACT_DEBUG
    };

    // [silent] content-gateway ready
})();
