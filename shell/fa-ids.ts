// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// fa-ids.ts — 文件关联域共享标识（唯一真理源）
//   编辑器域（fa-editor.ts：注册 / 夺默认 / 外部打开分流的全部载体标识）消费。
//   改动这些标识 = 注册面与打开链同时失效（改前全仓搜用点）。
// ============================================================================

/** 编辑器域 ProgID（Win：Classes\qqqide.editor + UserChoice ProgId） */
export const EDITOR_PROGID = 'qqqide.editor';
/** 编辑器域 Linux 桌面条目 ID（~/.local/share/applications/ 与 mimeapps.list） */
export const EDITOR_DESKTOP_ID = 'qqqide-editor.desktop';
/** 编辑器域外部打开标记（argv 分流 + AssocQueryString 命令验证） */
export const EDITOR_OPEN_MARK = '--qqqide-open';
