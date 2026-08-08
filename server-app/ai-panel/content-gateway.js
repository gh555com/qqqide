// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// content-gateway.js — 内容安全网关 v2
// 一切工具结果、附件内容、进上下文/落盘前必须过此门。
// 单一真理源：改截断大小只改 CTX_CAP_CHARS 一处。
// ============================================================================

; (function () {
    'use strict';

    // ═══ 上下文截断 — 唯一真理 ═══
    var CTX_CAP_CHARS = 50000;    // 单条工具结果上限（字符数 = str.length）
    var CTX_HEAD_CHARS = 20000;   // 截断时保留开头字符数
    var CTX_TAIL_CHARS = 20000;   // 截断时保留结尾字符数

    // ═══ 编辑框硬上限 — 唯一真理 ═══
    var EDITOR_CAP_CHARS = 16000;  // AI面板编辑框键入上限（字符数 = str.length）

    // ═══ 二进制检测 ═══
    var MAX_BINARY_NULLS = 3;
    var MAX_BINARY_RATIO = 0.3;
    var BINARY_SAMPLE_LEN = 4000;

    // ═══ 网络超时参数（唯一真理源：改一处全局生效） ═══
    var FETCH_DEADLINE_PRIMARY_MS = 1000000;
    var FETCH_DEADLINE_FALLBACK_MS = 1000000;
    var STREAM_WATCHDOG_MS = 60000;
    var HARD_FETCH_DEADLINE_MS = 220000;  // ★ 硬超时 220s：Promise.race 逃生通道，不依赖 AbortController（Chromium 108 HTTP/2 死连接上 abort 不生效）

    // ═══ 模型上下文窗口参数 ═══
    var CTX_MAX_TOKENS = 1048565;
    var COMPRESS_THRESHOLD = (function () {
        try {
            if (typeof parent !== 'undefined' && parent.window && parent.window.qqqideDefaults) {
                return parent.window.qqqideDefaults['ai.compressThreshold'] * 1000;
            }
        } catch (_) { }
        return 600000;
    })();
    var MAX_TOKENS_SAFETY = 10000;
    var CHAR_PER_TOKEN = 2.7;
    var COMPACT_MAX_TOKENS = 65536;
    var ARCHIVE_MAX_CHARS = 1000000;
    var COMPACT_DEBUG = true;
    var MAX_RESPONSE_TOKENS = 393216;

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

    // ═══ 统一内容门 ═══
    // 一切工具结果、附件内容过此门。AB 管道合一，上下文和落盘同尺寸。
    // ≤50K chars → 全文。>50K chars → 首20K + 尾20K。
    // opts.bypassCap=true → 跳过截断（仅二进制检测保留），用于 read_file 显式指定行号范围。
    function gate(rawStr, opts) {
        opts = opts || {};
        if (rawStr == null) return '';
        var str = typeof rawStr === 'string' ? rawStr : String(rawStr);

        if (detectBinary(str)) {
            return '[BINARY DATA — ' + str.length + ' chars]';
        }

        // ★ 跳过截断：AI 显式指定了范围（如 read_file start_line/end_line），信任 AI 的意图
        if (opts.bypassCap) return str;

        if (str.length <= CTX_CAP_CHARS) return str;

        var head = str.substring(0, CTX_HEAD_CHARS);
        var tail = str.substring(str.length - CTX_TAIL_CHARS);
        return head + '\n\n... [' + str.length + ' chars total, showing first ' + CTX_HEAD_CHARS + ' + last ' + CTX_TAIL_CHARS + ' chars] ...\n\n' + tail;
    }

    // ═══ HTTP 错误码分类（单一真理源） ═══
    var HttpError = {
        isGatewayDown: function (code) { return code === 502 || code === 503 || code === 504; },
        isClientError: function (code) { return code === 400 || code === 422; },
        isRetryable: function (code) { return code === 429 || HttpError.isGatewayDown(code); },
        isAutoRepairable: function (code) { return HttpError.isClientError(code) || HttpError.isGatewayDown(code); },
        shouldCaptureAsGatewayError: function (code) { return HttpError.isClientError(code) || code === 402 || HttpError.isGatewayDown(code); },
        isGatewayExitReason: function (reason) {
            if (!reason || typeof reason !== 'string') return false;
            var m = reason.match(/^http_(\d+)$/);
            return m ? HttpError.isGatewayDown(parseInt(m[1], 10)) : false;
        }
    };

    // ═══ 暴露到全局 ═══
    window.ContentGateway = {
        gate: gate,
        detectBinary: detectBinary,
        HttpError: HttpError,
        // 上下文截断
        CTX_CAP_CHARS: CTX_CAP_CHARS,
        CTX_HEAD_CHARS: CTX_HEAD_CHARS,
        CTX_TAIL_CHARS: CTX_TAIL_CHARS,
        EDITOR_CAP_CHARS: EDITOR_CAP_CHARS,
        // 二进制检测
        MAX_BINARY_NULLS: MAX_BINARY_NULLS,
        MAX_BINARY_RATIO: MAX_BINARY_RATIO,
        // 网络超时
        FETCH_DEADLINE_PRIMARY_MS: FETCH_DEADLINE_PRIMARY_MS,
        FETCH_DEADLINE_FALLBACK_MS: FETCH_DEADLINE_FALLBACK_MS,
        STREAM_WATCHDOG_MS: STREAM_WATCHDOG_MS,
        HARD_FETCH_DEADLINE_MS: HARD_FETCH_DEADLINE_MS,
        // 模型上下文
        CTX_MAX_TOKENS: CTX_MAX_TOKENS,
        COMPRESS_THRESHOLD: COMPRESS_THRESHOLD,
        MAX_TOKENS_SAFETY: MAX_TOKENS_SAFETY,
        CHAR_PER_TOKEN: CHAR_PER_TOKEN,
        COMPACT_MAX_TOKENS: COMPACT_MAX_TOKENS,
        ARCHIVE_MAX_CHARS: ARCHIVE_MAX_CHARS,
        COMPACT_DEBUG: COMPACT_DEBUG,
        MAX_RESPONSE_TOKENS: MAX_RESPONSE_TOKENS
    };

    // [silent] content-gateway v2 ready
})();
