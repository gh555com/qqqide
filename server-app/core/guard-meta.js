// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// guard-meta.js — 服务端甲壳元信息（唯一入口）
//
// 权威: gaea/guard/system-prompt.txt（服务端 Go 注入到 messages[0] 之前，客户端不可见）
// 动态: 启动后一次 GET /api/v3/ai/guard-meta 拉取 chars；失败/未拉取 → 出厂快照 FALLBACK_CHARS
// 消费方: panel-quest-ui.js (guardChars / _bpChars0) / panel-pipeline.js (背包重量) / conv-ui.html (背包图解)
// 加载点: server-app/index.html（主窗口，goods iframe 经 parent 读取）+ ai-panel/index.html
// 双线路 URL 与 ai-gateway.js _URLS 同源（chat 主备线），改动需同步。
// ============================================================================

; (function () {
    'use strict';

    var _URLS = [
        'https://direct-cn.gh555.com/api/v3/ai/guard-meta',
        'https://cnk.gh555.com/api/v3/ai/guard-meta'
    ];

    // ★ 出厂快照：2026-08-10 实测 gaea/guard/system-prompt.txt 字符数（服务端未部署/离线兜底）
    var FALLBACK_CHARS = 21354; // 2026-08-10 实测（档1损坏修复×4 + E-FLOW 模板 A/B 合并去重后）

    var _chars = 0;      // 拉取成功后的真实值
    var _loading = false;

    function _refresh() {
        if (_loading || _chars > 0) return;
        _loading = true;
        (function _try(i) {
            if (i >= _URLS.length) { _loading = false; return; }
            fetch(_URLS[i], { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    if (j && typeof j.chars === 'number' && j.chars > 0) {
                        _chars = j.chars;
                    } else {
                        _try(i + 1);
                    }
                    _loading = false;
                })
                .catch(function () { _try(i + 1); });
        })(0);
    }

    function chars() {
        if (_chars <= 0) _refresh(); // 懒拉取自愈：离线启动后任一消费方调用即再试
        return _chars > 0 ? _chars : FALLBACK_CHARS;
    }

    window.QQQGuardMeta = {
        chars: chars,
        refresh: _refresh,
        FALLBACK: FALLBACK_CHARS
    };

    _refresh(); // 启动即异步拉取，不阻塞任何路径
})();
