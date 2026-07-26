// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// tools.js — 已拆分为 4 个文件，此文件保留用于 Node.js 模块兼容
// 浏览器端加载顺序（index.html）: tools-defs.js → tools-exec-write.js → tools-exec.js → tools-exec-effect.js
// ============================================================================

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TOOL_DEFINITIONS: (typeof TOOL_DEFINITIONS !== 'undefined' ? TOOL_DEFINITIONS : []),
        TOOL_CATEGORY: (typeof TOOL_CATEGORY !== 'undefined' ? TOOL_CATEGORY : {}),
        getTools: (typeof getTools === 'function' ? getTools : function () { return []; }),
        executeTool: (typeof executeTool === 'function' ? executeTool : null)
    };
}
