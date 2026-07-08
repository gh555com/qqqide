// ★ 出厂默认值唯一真理源 — 改任何默认值只改此文件
//   其他所有地方通过 qqqSettings.get(key) 或 QQQ_DEFAULTS[key] 读取
//   SETTINGS_DEF 在 settings.js 里自动引用这里的值
window.qqqideDefaults = {
    'ai.defaultTier': 3,
    'ai.compressThreshold': 600,    // k tokens（×1000 = 实际 token 数）
    'editor.undoMode': 'char',
    'timeline.trackRunCommand': false
};
