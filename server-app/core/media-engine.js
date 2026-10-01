// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// media-engine.js — 共享媒体引擎（2026-09-26 q319 v5 · 从 shell-overlay.js 抽取）
//   三宿主同源：悬浮层（core/shell-overlay.js）＋ 独立播放器窗（player/player.html）＋ 窗内播放器卡（core/player-card.js）。
//   禁第二套实现（防漂移）——一切媒体行为（转码兜底/自建控制条/播放列表/A-B/倍速/逐帧/截图/键盘）
//   只在本文修改。★ v5 同页多宿主：宿主改由 mount({host}) 逐实例传入（默认全局 configure(host) 兜底）——
//   悬浮层与窗内播放器卡同在主动窗口，popOut/popIn/toast/onClose 必须实例隔离（禁共享全局 HOST 串号）。
//     host = { bridge, rootEl, i18n(k,fb,params), toast(msg,opts), onClose(), reopen(payload),
//              reveal(path), getLastDir(), onPlayState(playing), onState(), savePref(k,v)?,
//              popOut(state)?, popIn(state)?, stow()? }
//   popOut → ↗ 弹出独立播放器窗（仅悬浮层提供）；popIn → ⧈ 在窗内打开播放器卡（仅悬浮层提供）；播放器窗/卡不提供。
//   stow → [—] 最小化到状态栏（仅悬浮层提供——隐藏悬浮层、播放不断；遥控/恢复 = 状态栏播放器豆腐块）。
//   ★ v5 播放列表 = 侧边常驻 dock（非弹出面板）：列表 n>1 时恒显于播放器侧边（边随记忆；⇄ 切边按钮已删 2026-10-01），n≤1 整体隐藏。
//   mount(opts) → { keys, esc(), destroy(), pause(), isPlaying(), append(items,autoplay), getState() }
//     opts = { container, mode:'video'|'audio', src, localPath, shotBase, name, list, index, host,
//              isTx, autoplay, startTime, initial:{rate,loop,shuffle,volume,muted,dockSide} }
// ============================================================================
(function () {
  'use strict';
  var HOST = null;          // 默认宿主（configure 注入；悬浮层/播放器窗各用各的上下文）
  var _ovDockSide = null;   // 播放列表 dock 位置（'left'|'right'；会话粘性 + 宿主 savePref 持久化）
  var _AUDIO_EXTS = { '.mp3': 1, '.wav': 1, '.flac': 1, '.m4a': 1, '.aac': 1, '.ogg': 1, '.oga': 1, '.opus': 1, '.weba': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.ape': 1, '.ac3': 1, '.mka': 1, '.amr': 1, '.au': 1 };

  var _ovMediaCss =     // ★ 窄宽换行（v6，2026-09-26 q319 用户实测）：播放器窗偏窄时控制条尾部按钮（音量滑杆/倍速/模式/A-B）落在 maincol 外被 overflow 裁掉
    //   ——实测 600px 窗裁 4 个 / 460px 裁 5 个 / 视频 640px 裁 6 个（「功能键都没了」实锤）；flex-wrap 换行 = 任何宽度零静默裁切（宽窗零变化）
    '.ovmb{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:5;display:flex;align-items:center;justify-content:center;gap:4px;row-gap:6px;flex-wrap:wrap;' +
    'padding:7px 10px;border-radius:12px;background:rgba(15,15,15,0.84);border:1px solid rgba(255,255,255,0.14);' +
    'box-shadow:0 6px 24px rgba(0,0,0,0.45);user-select:none;font-family:system-ui,-apple-system,sans-serif;' +
    'width:min(760px,94%);box-sizing:border-box}' +
    '.ovmb-inline{position:static;left:auto;bottom:auto;transform:none;width:560px;max-width:100%}' +
    // ★ 播放列表 dock（2026-09-26 q319 v5 用户定案）：列表 n>1 恒显于播放器侧边（侧栏常驻，非弹出面板）；边随记忆（⇄ 切边按钮已删 2026-10-01）
    // ★ v6 宽度契约（2026-09-26 用户实测）：旧 150px 下限 → 歌名可见宽仅 10~28px 全截断（「歌名完全看不到」实锤）；
    //   190/38%/300 + 行内空间收窄（padding 3 · gap 5 · mk 9 · idx 12）= 歌名可读；禁改回小下限
    '.ovmb-shell{display:flex;width:100%;height:100%;min-width:0;min-height:0}' +
    '.ovmb-maincol{flex:1 1 auto;min-width:0;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
    '.ovmb-dock{flex:0 0 auto;align-self:center;width:clamp(190px,38%,300px);max-height:100%;display:none;flex-direction:column;margin:0 12px;box-sizing:border-box;' +
    'background:rgba(16,16,16,0.86);border:1px solid rgba(255,255,255,0.14);border-radius:11px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,0.35)}' +
    '.ovmb-dhead{display:flex;align-items:center;gap:6px;padding:1px 2px 7px;flex:0 0 auto}' +
    '.ovmb-dtitle{font-size:11px;color:#a8a49b;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.ovmb-dcnt{font-size:11px;color:#a8a49b;flex:0 0 auto}' +

    // ★ 可见边界（2026-10-01 q319 用户定案）：底部条按钮恒浅边框 + 淡底色——点选范围一眼可见（禁回 border:none 透明底）
    '.ovmb-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,0.16);box-sizing:border-box;' +
    'border-radius:7px;background:rgba(255,255,255,0.05);color:#e8e6e0;flex:0 0 auto;outline:none;transition:background .12s,border-color .12s}' +
    '.ovmb-btn:hover{background:rgba(255,255,255,0.14);border-color:rgba(255,255,255,0.28)}' +
    '.ovmb-btn.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.16);border-color:rgba(255,211,1,0.5)}' +
    '.ovmb-rate{width:auto;min-width:42px;padding:0 6px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}' +
    '.ovmb-time{font-size:12px;color:#cfcbc2;flex:0 0 auto;font-variant-numeric:tabular-nums;text-align:center;min-width:36px}' +
    '.ovmb-seek{position:relative;flex:1 1 auto;height:20px;display:flex;align-items:center;min-width:50px}' +
    '.ovmb-seek-track{position:absolute;left:0;right:0;height:4px;border-radius:2px;background:rgba(255,255,255,0.22)}' +
    '.ovmb-seek-fill{height:100%;width:0%;background:#ffd301;border-radius:2px}' +
    '.ovmb-seek-dot{position:absolute;width:11px;height:11px;border-radius:50%;background:#ffd301;top:50%;left:0%;' +
    'transform:translate(-50%,-50%);opacity:0;transition:opacity .12s}' +
    '.ovmb-seek:hover .ovmb-seek-dot,.ovmb-seek.ovmb-drag .ovmb-seek-dot{opacity:1}' +
    // ★ 音量增压视觉（2026-10-01 q319 用户定案）：上限 150%——轨道右段 = 增压区（金色淡染）+ 100% 处金色分隔刻度；
    //   进入增压区滑块加金色光环；拖拽浮读百分比（>100% 金色）——增压段可一眼辨识，无需永久文字
    '.ovmb-vol{-webkit-appearance:none;appearance:none;width:58px;height:4px;border-radius:2px;' +
    'background:linear-gradient(to right, rgba(255,255,255,0.22) 0 65.5%, rgba(255,211,1,0.6) 65.5% 68.2%, rgba(255,211,1,0.22) 68.2% 100%);outline:none;flex:0 0 auto;margin:0}' +
    '.ovmb-vol::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:11px;height:11px;border-radius:50%;background:#ffd301;border:none}' +
    '.ovmb-vol.ovmb-vboost::-webkit-slider-thumb{box-shadow:0 0 0 2px rgba(255,211,1,0.30), 0 0 7px rgba(255,211,1,0.55)}' +
    '.ovmb-volbox{position:relative;display:flex;align-items:center;flex:0 0 auto}' +
    '.ovmb-voltip{position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);z-index:9;pointer-events:none;' +
    'padding:2px 7px;border-radius:6px;background:rgba(18,18,18,0.95);border:1px solid rgba(255,255,255,0.2);color:#e8e6e0;' +
    'font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:0;transition:opacity .12s}' +
    '.ovmb-voltip.ovmb-von{opacity:1}' +
    '.ovmb-voltip.ovmb-vgold{color:#ffd301;border-color:rgba(255,211,1,0.5)}' +
    '.ovmb-shell:fullscreen{width:100%;height:100%;max-width:none;max-height:none;background:#000}' +
    '.ovmb-shell:fullscreen video{max-width:100vw;max-height:100vh}' +
    '.ovmb-ratehost{position:relative;display:flex;flex:0 0 auto}' +
    '.ovmb-modehost{position:relative;display:flex;flex:0 0 auto}' +
    '.ovmb-loop{position:relative}' +
    '.ovmb-m1{position:absolute;right:2px;bottom:1px;font-size:9px;font-weight:700;line-height:1;color:#ffd301;pointer-events:none}' +
    '.ovmb-pos{font-size:11px;color:#b9b5ac;flex:0 0 auto;font-variant-numeric:tabular-nums;padding:0 2px;white-space:nowrap}' +
    // ★ 播放模式面板 v2（2026-09-26）：循环/随机 两独立维度行并列组合；文本行弹性布局（无 fr 轨道——防 absolute shrink-to-fit 塌缩，同倍速面板契约）
    '.ovmb-modepanel{position:absolute;bottom:calc(100% + 10px);right:0;z-index:6;display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:11px;' +
    'background:rgba(18,18,18,0.96);border:1px solid rgba(255,255,255,0.16);box-shadow:0 8px 28px rgba(0,0,0,0.5);white-space:nowrap}' +
    '.ovmb-mrow{display:flex;align-items:center;gap:5px}' +
    '.ovmb-mlab{font-size:11px;color:#a8a49b;flex:0 0 auto;padding-right:2px}' +
    '.ovmb-mopt{height:26px;padding:0 10px;border:none;border-radius:6px;background:rgba(255,255,255,0.08);color:#e8e6e0;' +
    'font-size:12px;white-space:nowrap;outline:none;transition:background .1s}' +
    '.ovmb-mopt:hover{background:rgba(255,255,255,0.18)}' +
    '.ovmb-mopt.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.18)}' +
    // ★ 播放列表 dock 列表容器（2026-09-26 v5）：弹性吃满 dock 高度 + 内部滚动；当前轨金色高亮
    '.ovmb-pllist{display:flex;flex-direction:column;gap:2px;overflow-y:auto;min-height:0;flex:1 1 auto}' +
    // ★ 行结构 v3（2026-09-26 q319）：行容器（wrap）= 视觉/高亮/拖动单元；名称区 = 内嵌按钮（禁 button 套 button）；行尾三钮（↑ 上移 / ↓ 下移 / − 移除）
    '.ovmb-prowwrap{display:flex;align-items:center;gap:2px;height:28px;padding:0 3px 0 3px;border-radius:6px;color:#e8e6e0;flex:0 0 auto;transition:background .1s}' +
    '.ovmb-prowwrap:hover{background:rgba(255,255,255,0.12)}' +
    '.ovmb-prowwrap.ovmb-cur{color:#ffd301;background:rgba(255,211,1,0.14)}' +
    '.ovmb-prowwrap.ovmb-cur .ovmb-pidx{color:#ffd301}' +
    '.ovmb-prow{display:flex;align-items:center;gap:5px;height:28px;padding:0;border:none;background:transparent;color:inherit;flex:1 1 auto;' +
    'font-size:12px;text-align:left;min-width:0;outline:none}' +
    '.ovmb-pops{display:flex;align-items:center;gap:1px;flex:0 0 auto}' +
    '.ovmb-pop{display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;' +
    'color:#b9b5ac;font-size:12px;line-height:1;outline:none;transition:background .1s,color .1s}' +
    '.ovmb-pop:hover{background:rgba(255,255,255,0.16);color:#fff}' +
    '.ovmb-pop:disabled{opacity:.28}' +
    '.ovmb-pop:disabled:hover{background:transparent;color:#b9b5ac}' +
    '.ovmb-prowwrap.ovmb-dragging{opacity:.4}' +
    '.ovmb-prowwrap.ovmb-dtop{box-shadow:inset 0 2px 0 0 #ffd301}' +
    '.ovmb-prowwrap.ovmb-dbot{box-shadow:inset 0 -2px 0 0 #ffd301}' +
    '.ovmb-pmark{flex:0 0 auto;width:9px;font-size:8px;line-height:1}' +
    '.ovmb-pidx{flex:0 0 auto;min-width:12px;text-align:right;color:#b9b5ac;font-size:11px;font-variant-numeric:tabular-nums}' +
    '.ovmb-pname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    // ★ 定值轨道（2026-09-26）：absolute 容器 + 全 fr 轨道 → shrink-to-fit 内在尺寸塔缩（实测轨道 1.75px、按钮互叠 12 对）；
    //   repeat(4,48px) 内在尺寸恒确定（零依赖 fr 内在算法）；按钮 border-box + width:100% 防 content-box 挤出轨道
    '.ovmb-ratepanel{position:absolute;bottom:calc(100% + 10px);right:0;z-index:6;display:grid;' +
    'grid-template-columns:repeat(4,48px);gap:5px;padding:9px;border-radius:11px;' +
    'background:rgba(18,18,18,0.96);border:1px solid rgba(255,255,255,0.16);box-shadow:0 8px 28px rgba(0,0,0,0.5)}' +
    '.ovmb-rbtn{box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 4px;border:none;border-radius:6px;background:rgba(255,255,255,0.08);' +
    'color:#e8e6e0;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;outline:none;transition:background .1s}' +
    '.ovmb-rbtn:hover{background:rgba(255,255,255,0.18)}' +
    '.ovmb-rbtn.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.18)}' +
    // ★ 倍速 × 标记（2026-10-01 q319 用户定案）：数字右侧 × 加大一号 + 不加粗 + 底对齐（禁上浮小字）
    '.ovmb-rate-lab{display:inline-block;white-space:nowrap;line-height:1}' +
    '.ovmb-rate-x{font-size:1.6em;font-weight:400;vertical-align:-0.13em}' +
    '.ovmb-rrow{grid-column:1/-1;display:flex;gap:5px;margin-top:2px}' +
    '.ovmb-rinput{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);' +
    'background:rgba(0,0,0,0.4);color:#e8e6e0;font-size:12px;outline:none;box-sizing:border-box}' +
    '.ovmb-rinput:focus{border-color:#ffd301}' +
    '.ovmb-rok{height:26px;padding:0 10px;border:none;border-radius:6px;background:rgba(255,211,1,0.22);color:#ffd301;' +
    'font-size:12px;font-weight:600;flex:0 0 auto}' +
    '.ovmb-rok:hover{background:rgba(255,211,1,0.34)}' +
    // ★ A-B 循环（2026-09-26 q319）：按钮双字独金 + 进度条区间底色 + 两端内指三角（▶ 起点 / ◀ 终点）
    '.ovmb-ab{width:auto;min-width:42px;padding:0 6px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}' +
    '.ovmb-aba,.ovmb-abb{opacity:.4}' +
    '.ovmb-ab.ovmb-arm .ovmb-aba{opacity:1;color:#ffd301}' +
    '.ovmb-ab.ovmb-on .ovmb-aba,.ovmb-ab.ovmb-on .ovmb-abb{opacity:1;color:#ffd301}' +
    '.ovmb-abzone{position:absolute;top:50%;transform:translateY(-50%);height:4px;border-radius:2px;background:rgba(255,211,1,0.22);display:none;pointer-events:none}' +
    '.ovmb-abmark{position:absolute;top:50%;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;transform:translate(-50%,-50%);display:none;pointer-events:none}' +
    '.ovmb-abmark-a{border-left:6px solid #ffd301}' +
    '.ovmb-abmark-b{border-right:6px solid #ffd301}' +
    // ★ 专属播放控制行 v7（2026-10-01 q319 用户定案）：按钮上下两段式（上=快捷键字母加大一号 / 下=图标）+ 每钮可见边界（边框+底色）；播放+停止=中央对恒居中（对心对称、左右空白相等）+ 停止（■=暂停并回到开头，无键位）；
    //   两翼 逐帧（◀|/|▶ 竖线与三角平边隔开一点）→ 4秒（◀◀/▶▶ 双三角重叠）→ 速率（−0.5×/+0.5×）；行/条/间隙整带 no-drag（播放器窗拖拽区挖洞——登记于 player.html）
    '.ovmb-stack{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:5;display:flex;flex-direction:column;align-items:center;gap:8px;width:min(780px,94%);box-sizing:border-box}' +
    '.ovmb-stack .ovmb{position:static;left:auto;bottom:auto;transform:none;width:100%}' +
    '.ovmb-stack-inline{position:static;left:auto;bottom:auto;transform:none;width:auto;max-width:100%}' +
    '.ovmb-stack-inline .ovmb{width:560px;max-width:100%}' +
    '.ovmb-trx{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:nowrap;width:100%;padding:4px 8px;border-radius:12px;' +
    'background:rgba(15,15,15,0.84);border:1px solid rgba(255,255,255,0.14);box-shadow:0 6px 24px rgba(0,0,0,0.45);user-select:none;max-width:100%;box-sizing:border-box}' +
    // ★ 两翼等基宽（flex:1 1 0）——基宽相等 → 拿到的自由空间相等 → 播放按钮恒居整行正中；行恒单行（nowrap）
    //   ★ 2026-10-01 q319 用户定案：窄容器禁换行——按可用宽自动降档收紧尺寸（t1→t3，见下）；两翼均缩不偏心
    '.ovmb-trxl,.ovmb-trxr{display:flex;align-items:center;gap:6px;flex:1 1 0;min-width:0}' +
    '.ovmb-trxl{justify-content:flex-end}' +
    '.ovmb-trxr{justify-content:flex-start}' +
    // ★ v7（2026-10-01 q319）：按钮恒有可见边界（边框+底色）+ 上下两段式布局（kcap 上 / tbody 下）；播放/停止无键位（图标垂直居中）
    '.ovmb-tbtn{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;height:46px;min-width:36px;padding:3px 7px;border:1px solid rgba(255,255,255,0.22);border-radius:9px;background:rgba(255,255,255,0.05);color:#e8e6e0;flex:0 0 auto;outline:none;box-sizing:border-box;transition:background .12s,border-color .12s}' +
    '.ovmb-tbtn:hover{background:rgba(255,255,255,0.13);border-color:rgba(255,255,255,0.38)}' +
    '.ovmb-tbtn:active{background:rgba(255,255,255,0.20)}' +
    '.ovmb-tbtn svg{display:block;pointer-events:none}' +
    '.ovmb-tbody{display:flex;align-items:center;justify-content:center;line-height:1;pointer-events:none}' +
    '.ovmb-trx .ovmb-play{width:auto;height:46px;min-width:52px;padding:0 10px;border:1px solid rgba(255,255,255,0.22);border-radius:9px;background:rgba(255,255,255,0.08)}' +
    '.ovmb-trx .ovmb-play:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.34)}' +
    '.ovmb-trx .ovmb-play svg{width:20px;height:20px}' +
    '.ovmb-tlab{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;pointer-events:none}' +
    '.ovmb-kcap{display:inline-flex;align-items:center;justify-content:center;min-width:23px;height:17px;padding:0 4px;border-radius:4px;border:1px solid rgba(255,211,1,0.5);border-bottom-width:2px;background:rgba(255,211,1,0.14);color:#ffd301;font-size:12px;font-weight:400;text-transform:lowercase;line-height:1;font-family:Tahoma,Verdana,sans-serif;pointer-events:none;box-sizing:border-box}' +
    // ★ 恒单行紧凑三档（2026-10-01 q319 用户定案）：行永不换行——窄容器逐档收紧（base≥410 / t1≥340 / t2≥298 / 其余 t3；阈值按实测需求宽在 _fitTrxRow 选档 + 溢出自动降档）
    '.ovmb-trx.ovmb-t1{gap:4px;padding:3px 6px}' +
    '.ovmb-trx.ovmb-t1 .ovmb-trxl,.ovmb-trx.ovmb-t1 .ovmb-trxr{gap:4px}' +
    '.ovmb-trx.ovmb-t1 .ovmb-tbtn{min-width:32px;padding:3px 5px}' +
    '.ovmb-trx.ovmb-t1 .ovmb-kcap{padding:0 3px}' +
    '.ovmb-trx.ovmb-t1 .ovmb-tlab{font-size:10px}' +
    '.ovmb-trx.ovmb-t1 .ovmb-play{min-width:46px;padding:0 7px}' +
    '.ovmb-trx.ovmb-t2{gap:3px;padding:3px 4px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-trxl,.ovmb-trx.ovmb-t2 .ovmb-trxr{gap:3px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-tbtn{height:42px;min-width:30px;padding:2px 3px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-kcap{min-width:15px;height:15px;padding:0 2px;font-size:11px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-tlab{font-size:10px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-play{min-width:44px;height:42px;padding:0 5px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-tbtn svg{width:14px;height:14px}' +
    '.ovmb-trx.ovmb-t2 .ovmb-play svg{width:18px;height:18px}' +
    '.ovmb-trx.ovmb-t3{gap:2px;padding:2px 3px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-trxl,.ovmb-trx.ovmb-t3 .ovmb-trxr{gap:2px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-tbtn{height:38px;min-width:24px;padding:2px 2px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-kcap{min-width:13px;height:13px;padding:0 1px;font-size:10px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-tlab{font-size:9px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-play{min-width:38px;height:38px;padding:0 3px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-tbtn svg{width:13px;height:13px}' +
    '.ovmb-trx.ovmb-t3 .ovmb-play svg{width:16px;height:16px}';
  function _ensureMediaCss() {
    try {
      if (document.getElementById('qqq-media-engine-style')) { return; }
      var st = document.createElement('style');
      st.id = 'qqq-media-engine-style';
      st.textContent = _ovMediaCss;
      (document.head || document.documentElement).appendChild(st);
    } catch (_) { }
  }

  // ── 宿主差异面（seams）★ v5：一切宿主调用带显式 H（同页多宿主共存——悬浮层与窗内播放器卡同在主动窗口）──
  function _ifor(H, k, fb, prm) { try { return (H && H.i18n) ? H.i18n(k, fb, prm) : (fb || k); } catch (_) { return fb || k; } }
  function _toastFor(H, m, o) { try { if (H && H.toast) { H.toast(m, o); } } catch (_) { } }
  function _closeHostFor(H) { try { if (H && H.onClose) { H.onClose(); } } catch (_) { } }
  function _reopenHostFor(H, p) { try { if (H && H.reopen) { H.reopen(p); } } catch (_) { } }
  function _txRootFor(H) { try { return (H && H.rootEl) || document.body; } catch (_) { return document.body; } }
  function _persistTickFor(H) { try { if (H && H.onState) { H.onState(); } } catch (_) { } }
  // 全局 HOST 包装（模块级工具函数用；mount/控制条内部一律用 H 显式版本）
  function _i(k, fb, prm) { return _ifor(HOST, k, fb, prm); }
  function _toast(m, o) { _toastFor(HOST, m, o); }

  function _closeHost() { _closeHostFor(HOST); }
  function _reopenHost(p) { _reopenHostFor(HOST, p); }
  function _txRoot() { return _txRootFor(HOST); }
  function _persistTick() { _persistTickFor(HOST); }
  function _localPathFromSrc(src) {
    if (typeof src !== 'string') return null;
    if (/^file:\/\//i.test(src)) {
      var p = src.replace(/^file:\/\/\//i, '');
      try { p = decodeURIComponent(p); } catch (_) { }
      return p;
    }
    if (/^[A-Za-z]:[\\/]/.test(src)) return src;
    return null;
  }

  // ═══ ★ 音量增压机器（2026-10-01 q319 用户定案：音量上限 100%→150%，VLC 式）═══
  //   合成公式：元素音量 = min(1, v)（≤100% 与历史零差异）；增益 = muted ? 0 : max(1, v)（>100% 段补差）。
  //   AudioContext 全模块共享、惰性创建——未触发增压的会话零创建零开销。元素经 createMediaElementSource 俘获后
  //   file:/// 媒体在 webSecurity:false 下实测非静默（探针 raw 实测：RMS 0.021 / 增益 1.5× → 实测放大比 1.503）。
  var _OV_VOL_MAX = 1.5;   // 音量硬上限（150%；唯一阈值——滑块 max / 键盘步进 / 初值恢复共用）
  var _ovBoostCtx = null;
  function _ovBoostCtxEnsure() {
    if (_ovBoostCtx) { return _ovBoostCtx; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { return null; }
      _ovBoostCtx = new AC();
      try { if (_ovBoostCtx.state !== 'running') { _ovBoostCtx.resume(); } } catch (_) { }
    } catch (_) { _ovBoostCtx = null; }
    return _ovBoostCtx;
  }

// ── 共享状态：v5 起媒体路径/截图基准下沉为 mount 实例局部（_curLocalPath/_curShotBase——同页多实例共存）──

// ═════════ 段 A：转码兜底（媒体/图片共用） ═════════
  // ═══ ★ 转码兜底（2026-09-21）：Chromium 原生解不了的格式（avi/wmv/flv/rmvb/prores/psd…）═══
  //   壳层 ffmpeg 智能转码（media.playable：同编码 copy 秒级重封装 / 否则 x264）→ 产物回放/回显
  //   进度 qqqide:media:playable:progress；取消 = media.playableCancel；关闭/切换自动取消在飞任务
  var _OV_TX_FIRST_EXTS = { '.avi': 1, '.wmv': 1, '.flv': 1, '.rmvb': 1, '.rm': 1, '.mpg': 1, '.mpeg': 1, '.m2ts': 1, '.mts': 1, '.3gp': 1, '.vob': 1, '.asf': 1, '.f4v': 1, '.ogm': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.ape': 1, '.ac3': 1, '.mka': 1, '.amr': 1, '.au': 1, '.psd': 1, '.tif': 1, '.tiff': 1 };
  function _ovTxExt(p) {
    var s = String(p || '').toLowerCase();
    var i = s.lastIndexOf('.');
    return i === -1 ? '' : s.substring(i);
  }
  var _ovTxReqId = null;
  var _ovTxUnsub = null;
  var _ovTxLastHost = null;   // 在飞转码的宿主（进度条落点/取消桥引用——同页多宿主时归发起方）
  var _ovTxBarEl = null, _ovTxBarText = null;
  function _ovTxBarShow(show) {
    if (!_ovTxBarEl) {
      if (!show) { return; }
      _ovTxBarEl = document.createElement('div');
      _ovTxBarEl.className = 'ovmb-txbar';   // ★ 宿主拖拽区挖洞用（播放器窗 CSS 按此类名 no-drag：防转码条区域被拖拽区吞点击）
      _ovTxBarEl.style.cssText = 'position:absolute;left:50%;bottom:150px;transform:translateX(-50%);z-index:100002;' +
        'display:flex;align-items:center;gap:12px;background:rgba(0,0,0,0.78);color:#fff;border-radius:10px;' +
        'padding:10px 16px;font-size:13px;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,0.5);';
      _ovTxBarText = document.createElement('span');
      _ovTxBarText.textContent = _ifor(_ovTxLastHost || HOST, 'shell.overlay.transcoding', '正在转码预览…');
      var _txCancelBtn = document.createElement('button');
      _txCancelBtn.textContent = _ifor(_ovTxLastHost || HOST, 'common.cancel', '取消');
      _txCancelBtn.setAttribute('data-no-cd', '');
      _txCancelBtn.style.cssText = 'padding:3px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.35);' +
        'background:transparent;color:#fff;font-size:12px;cursor:pointer;';
      _txCancelBtn.addEventListener('click', function () {
        _ovTxAbort();
        try { _closeHostFor(_ovTxLastHost || HOST); } catch (_) { }
      });
      _ovTxBarEl.appendChild(_ovTxBarText);
      _ovTxBarEl.appendChild(_txCancelBtn);
      _txRootFor(_ovTxLastHost || HOST).appendChild(_ovTxBarEl);
    }
    _ovTxBarEl.style.display = show ? 'flex' : 'none';
  }
  function _ovTxAbort() {
    if (_ovTxUnsub) { try { _ovTxUnsub(); } catch (_) { } _ovTxUnsub = null; }
    var _hb = _ovTxLastHost || HOST || {};
    if (_ovTxReqId && _hb.bridge && _hb.bridge.media && _hb.bridge.media.playableCancel) {
      try { _hb.bridge.media.playableCancel(_ovTxReqId); } catch (_) { }
    }
    _ovTxReqId = null;
    _ovTxBarShow(false);
  }
  // 启动转码：成功后回调 onOk(正斜杠产物路径)；失败/取消回调 onFail()；H = 归属宿主（缺省全局 HOST）
  function _ovTxRun(filePath, kind, onOk, onFail, H) {
    var hh = H || HOST || {};
    _ovTxLastHost = hh;
    if (!filePath || !hh.bridge || !hh.bridge.media || !hh.bridge.media.playable) {
      try { onFail(); } catch (_) { }
      return;
    }
    var rid = 'ov-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    _ovTxReqId = rid;
    _ovTxBarShow(true);
    if (hh.bridge.media.onPlayableProgress) {
      try {
        _ovTxUnsub = hh.bridge.media.onPlayableProgress(function (m) {
          if (!m || m.reqId !== rid || !_ovTxBarText) { return; }
          var base = _ifor(hh, 'shell.overlay.transcoding', '正在转码预览…');
          _ovTxBarText.textContent = (m.pct != null && m.pct >= 0) ? (base + ' ' + m.pct + '%') : base;
        });
      } catch (_) { }
    }
    hh.bridge.media.playable({ src: filePath, kind: kind, reqId: rid }).then(function (r) {
      if (_ovTxReqId !== rid) { return; }   // 已被取消/切换（abort 置 null）→ 丢弃结果
      if (_ovTxUnsub) { try { _ovTxUnsub(); } catch (_) { } _ovTxUnsub = null; }
      _ovTxReqId = null;
      _ovTxBarShow(false);
      if (r && r.ok && r.path) {
        try { onOk(String(r.path).replace(/\\/g, '/')); } catch (_) { }
      } else if (r && r.cancelled) {
        /* 用户取消：静默 */
      } else {
        try { onFail(); } catch (_) { }
      }
    }).catch(function () {
      if (_ovTxReqId !== rid) { return; }
      _ovTxReqId = null;
      _ovTxBarShow(false);
      try { onFail(); } catch (_) { }
    });
  }


// ═════════ 段 B：自建控制条 ovmb（含倍速/模式/列表面板/A-B/逐帧/截图） ═════════
  // ═══ ★ 媒体控制条（2026-09-26）：悬浮层播放器弃用原生控件 → 自建控制条 ═══
  //   动机：原生控件 = Chromium 内置（⋮ 折叠菜单 / 系统语言文案 / 不可加按钮 / 不接本机 i18n）；
  //   自建 = 播放/逐帧/截图/进度/时间/音量/倍速/播放模式/A-B 循环/画中画/全屏 全部直显、一键可达，文案全走 window._i（13 语言）。
  //   ★ v6（2026-09-30 q319 用户定案）：播放按钮从条内摘出 → 专属播放控制行（.ovmb-stack 双条栈：行在上/条在下；播放居中，
  //   两翼 逐帧 ◀|/|▶（键 1/2）→ 4 秒 ◀◀/▶▶（键 Q/W）→ 速率 ±0.5×（键 Z/X）+ 停止）；键帽直显；禁回退。
  //   倍速 = 点击展开面板（0.5~4 预设单按钮网格 + 自定义倍数输入·确认/回车；非 1× 金色高亮）；
  //   循环按钮 = 播放模式入口（点击上展模式面板：循环[关/列表循环/单曲循环] × 随机[关/开] 并列组合；L 键切循环 / R 键切随机）；倍速/播放模式会话内粘性（重开下一个文件保持）；
  //   按钮 data-no-cd 跳过全局冷却护盾（准许连点）；会话清理经 _stopMedia 统一执行（close/切换全覆盖）。
  var _OV_MEDIA_RATE_PRESETS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4];   // 面板预设（每步一个按钮；2026-10-01 q319 用户定案：3.5× 移除、0.5~1 间增 0.75×）
  var _ovMediaRate = 1;         // 会话粘性（支持任意自定义值）
  // （逐帧帧率 _ovMediaFps / Esc 前置钩子 _engEscHook —— v5 下沉为控制条实例局部变量，同页多实例互不串号）
  // ★ 播放模式 v2（2026-09-26 q319 用户定案）：循环（关/列表循环/单曲循环）与 随机（关/开）为两个并列独立维度，任意组合
  //   —— 组合覆盖：顺序单次 / 顺序循环 / 随机单次 / 随机循环 / 单曲循环；会话粘性；多文件列表打开时重置为 循环=列表循环 + 随机=关
  var _ovMediaLoop = 'off';       // 'off' | 'all' | 'one'
  var _ovMediaShuffle = false;    // 随机维度（与循环并列）
  function _ovLoopName(v) {
    if (v === 'all') { return _i('shell.overlay.modeListLoop', '列表循环'); }
    if (v === 'one') { return _i('shell.overlay.modeOne', '单曲循环'); }
    return _i('shell.overlay.mOff', '关');
  }
  function _ovShufName(v) { return v ? _i('shell.overlay.mOn', '开') : _i('shell.overlay.mOff', '关'); }


  //   d = 路径片段（自动包 <path>）；以 '<' 开头 = 原始内联标记直通（复合图标：三角 + 字母）
  function _ovMediaIcon(d) {
    var inner = (typeof d === 'string' && d.charAt(0) === '<') ? d : '<path d="' + d + '"/>';
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" ' +
      'style="display:block;pointer-events:none">' + inner + '</svg>';
  }
  var _OV_MEDIA_ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volMute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
    prev: 'M6 6h2v12H6zM9.5 12l8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    // ★ 上一首/下一首（2026-10-01 q319 用户定案）：竖线改字母——左三角◀+右 P（◀P）/ 左 N+右三角▶（N▶）；平涂笔触（同图标语言）
    //   逐帧行保留原 |◀/▶| 竖线款（prev/next 键）——底条与逐帧 2026-10-01 起解耦，禁再把两者并称「同款」
    prevSong: '<path d="M2.6 12l8-6v12z"/><text x="12.4" y="17.4" font-family="Tahoma, Verdana, sans-serif" font-size="15" font-weight="700" fill="currentColor">P</text>',
    nextSong: '<text x="2.4" y="17.4" font-family="Tahoma, Verdana, sans-serif" font-size="15" font-weight="700" fill="currentColor">N</text><path d="M22 12l-8-6v12z"/>',
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    shot: 'M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z',
    pip: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
    fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z'
  };
  // ★ 专属播放控制行图标（v8 2026-10-01 q319 用户定案）：逐帧 = |◀/▶| 竖线+三角（纯色直角——竖线在外、尖角朝竖线；
  //   该 glyph = _OV_MEDIA_ICONS.prev/next——底条 上一首/下一首 2026-10-01 已改 P/N 字母图标（prevSong/nextSong），逐帧保留竖线款）；快退/进 = 双三角重叠；停止 = 实心方块（直角）
  function _ovRawIcon(inner) {
    return '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style="display:block;pointer-events:none">' + inner + '</svg>';
  }
  var _OV_TRX_ICONS = {
    seekB: '<path d="M16.5 4v12L8.5 10z"/><path d="M11.5 4v12L3.5 10z"/>',
    seekF: '<path d="M3.5 4v12L11.5 10z"/><path d="M8.5 4v12L16.5 10z"/>',
    stop: '<rect x="2.5" y="2.5" width="15" height="15"/>'
  };
  function _ovFmtT(s) {
    if (!isFinite(s) || s < 0) { return '--:--'; }
    var t = Math.floor(s);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
    return (h > 0 ? h + ':' + (m < 10 ? '0' + m : m) : m) + ':' + (ss < 10 ? '0' + ss : ss);
  }

  // 构建控制条 → { bar, cleanup, keys, esc, setTrack, resetAB, onListChanged }；wrapEl = 全屏目标（视频=壳层行；音频为 null）
  //   api（可选）= 播放列表上下文 { n, idx, onEnded, onPrev, onNext, list, jump, getState, getBase, dockSide }
  //   layout = { shell, main }（dock 挂载锚点）；H = 本实例宿主（缺省全局 HOST）
  function _ovBuildMediaBar(mEl, isVid, wrapEl, api, layout, H) {
    H = H || HOST || {};
    // ★ v5 实例局部（禁与模块全局串号）：i18n/toast/持久化 + Esc 钩子 + 逐帧帧率
    var _i = function (k, fb, prm) { return _ifor(H, k, fb, prm); };
    var _toast = function (m, o) { _toastFor(H, m, o); };
    var _persistTick = function () { _persistTickFor(H); };
    var _engEscHook = null;
    var _ovMediaFps = 0;
    var bar = document.createElement('div');
    bar.className = 'ovmb' + (isVid ? '' : ' ovmb-inline');

    function _mBtn(d, title) {
      var b = document.createElement('button');
      b.className = 'ovmb-btn';
      b.tabIndex = -1;
      b.setAttribute('data-no-cd', '');
      b.innerHTML = _ovMediaIcon(d);
      if (title) { b.title = title; }
      // 防焦点窃取（点后 Space 不误触按钮激活 → 键盘空格=播放/暂停 唯一语义）
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      return b;
    }

    var playB = _mBtn(_OV_MEDIA_ICONS.play, _i('shell.overlay.mplay', '播放'));
    playB.classList.add('ovmb-play');
    var curT = document.createElement('span'); curT.className = 'ovmb-time'; curT.textContent = '0:00';
    var seek = document.createElement('div'); seek.className = 'ovmb-seek';
    var seekTrack = document.createElement('div'); seekTrack.className = 'ovmb-seek-track';
    var seekFill = document.createElement('div'); seekFill.className = 'ovmb-seek-fill';
    var seekDot = document.createElement('div'); seekDot.className = 'ovmb-seek-dot';
    // ★ A-B 循环可视化（2026-09-26）：区间底色 + 两端内指三角（▶ 起点 / ◀ 终点）；滑块最后叠顶
    var abZone = document.createElement('div'); abZone.className = 'ovmb-abzone';
    var abMarkA = document.createElement('div'); abMarkA.className = 'ovmb-abmark ovmb-abmark-a';
    var abMarkB = document.createElement('div'); abMarkB.className = 'ovmb-abmark ovmb-abmark-b';
    seekTrack.appendChild(seekFill);
    seek.appendChild(seekTrack);
    seek.appendChild(abZone); seek.appendChild(abMarkA); seek.appendChild(abMarkB);
    seek.appendChild(seekDot);
    var durT = document.createElement('span'); durT.className = 'ovmb-time'; durT.textContent = '--:--';
    var volB = _mBtn(_OV_MEDIA_ICONS.vol, _i('shell.overlay.mmute', '静音'));
    var volS = document.createElement('input');
    volS.type = 'range'; volS.className = 'ovmb-vol';
    volS.min = '0'; volS.max = String(_OV_VOL_MAX); volS.step = '0.05';
    volS.tabIndex = -1; volS.title = _i('shell.overlay.mvolume', '音量（最大可增强至 150%）');
    // ★ 音量增压机器（2026-10-01 q319）：_volWant = 有效音量真值（0..1.5）；>1 首次触发 → 惰性建图
    //   （元素音量钉 ≤1 段 + 共享 ctx 增益补 >1 段）；<100% 用户与历史完全一致（不建 ctx 零开销）；拖拽浮读百分比
    var _volWant = 1, _boostSrc = null, _boostGain = null, _volTipTimer = 0;
    var volBox = document.createElement('div'); volBox.className = 'ovmb-volbox';
    var volTip = document.createElement('span'); volTip.className = 'ovmb-voltip';
    function _boostKick() {
      if (_boostGain) { return; }
      var ctx = _ovBoostCtxEnsure();
      if (!ctx) { return; }
      try {
        _boostSrc = ctx.createMediaElementSource(mEl);
        _boostGain = ctx.createGain();
        _boostGain.gain.value = 1;
        _boostSrc.connect(_boostGain);
        _boostGain.connect(ctx.destination);
        mEl.addEventListener('play', function () { try { if (_ovBoostCtx && _ovBoostCtx.state !== 'running') { _ovBoostCtx.resume(); } } catch (_) { } });
      } catch (_) { _boostSrc = null; _boostGain = null; }
    }
    function _volApply() {
      try { mEl.volume = Math.min(1, Math.max(0, _volWant)); } catch (_) { }
    }
    function _setVol(v, silent) {
      if (!isFinite(v)) { v = 0; }
      v = Math.round(Math.max(0, Math.min(_OV_VOL_MAX, v)) * 100) / 100;
      _volWant = v;
      if (v > 1) { _boostKick(); }   // 进入增压区 → 惰性建图（此后恒存）
      _volApply();
      syncVol();
      if (!silent) { _persistTick(); }
    }
    function _volTipShow(ms) {
      try {
        volTip.textContent = Math.round(_volWant * 100) + '%';
        volTip.classList.add('ovmb-von');
        volTip.classList.toggle('ovmb-vgold', _volWant > 1);
        if (_volTipTimer) { clearTimeout(_volTipTimer); }
        _volTipTimer = setTimeout(function () { volTip.classList.remove('ovmb-von'); }, ms || 900);
      } catch (_) { }
    }
    var rateHost = document.createElement('div');
    rateHost.className = 'ovmb-ratehost';
    var rateB = document.createElement('button');
    rateB.className = 'ovmb-btn ovmb-rate'; rateB.tabIndex = -1;
    rateB.setAttribute('data-no-cd', '');
    rateB.title = _i('shell.overlay.mspeed', '倍速播放（点击选择）');
    rateB.addEventListener('mousedown', function (e) { e.preventDefault(); });
    rateHost.appendChild(rateB);
    // ★ 播放模式按钮（2026-09-26 q319；v2 并列双维度）：点击上展模式面板（循环[关/列表循环/单曲循环] × 随机[关/开]）
    var loopB = _mBtn(_OV_MEDIA_ICONS.repeat, _i('shell.overlay.mmode', '播放模式（L 循环 / R 随机）'));
    loopB.classList.add('ovmb-loop');
    var modeHost = document.createElement('div');
    modeHost.className = 'ovmb-modehost';
    modeHost.appendChild(loopB);
    // ★ 弹出独立播放器（2026-09-26 q319 v4）：宿主提供 popOut 才出现（悬浮层）——连列表+进度整体交接
    function _engState() { try { return (api && api.getState) ? api.getState() : null; } catch (_) { return null; } }
    var popB = null;
    if (H.popOut) {
      popB = _mBtn('M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z', _i('shell.overlay.mpopout', '弹出独立播放器'));
      popB.classList.add('ovmb-popout');
      popB.addEventListener('click', function () {
        try { H.popOut(_engState()); } catch (_) { }
      });
    }
    // ★ 窗内播放器（2026-09-26 q319 v5）：宿主提供 popIn 才出现（悬浮层）——整体交接进主窗口播放器卡（⧈）
    var popInB = null;
    if (H.popIn) {
      popInB = _mBtn('M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H5V8h14v10z', _i('shell.overlay.mpopin', '在窗内打开播放器'));
      popInB.classList.add('ovmb-popin');
      popInB.addEventListener('click', function () {
        try { H.popIn(_engState()); } catch (_) { }
      });
    }
    // ★ [—] 最小化到状态栏（2026-10-01 q319 用户定案）：宿主提供 stow 才出现（仅悬浮层）——隐藏悬浮层、播放不断；
    //   控制/恢复唯一入口 = 状态栏播放器豆腐块（core/player-block.js ↔ window.qqqOverlayStow）
    var stowB = null;
    if (H.stow) {
      stowB = _mBtn('M5 16h14v2H5z', _i('shell.overlay.mstow', '最小化到状态栏'));
      stowB.classList.add('ovmb-stow');
      stowB.addEventListener('click', function () { try { H.stow(); } catch (_) { } });
    }
    // ★ A-B 循环按钮（2026-09-26 q319）：三态循环——首点标 A → 次点标 B 起循（跳回 A）→ 再点清除；A/B 字各自金色指示状态
    var abB = document.createElement('button');
    abB.className = 'ovmb-btn ovmb-ab';
    abB.tabIndex = -1;
    abB.setAttribute('data-no-cd', '');
    abB.addEventListener('mousedown', function (e) { e.preventDefault(); });
    abB.innerHTML = '<span class="ovmb-aba">A</span>-<span class="ovmb-abb">B</span>';
    var pipB = null, fsB = null, shotB = null, prevB = null, nextB = null, posT = null;
    // ★ 播放列表控件（2026-09-26 q319）：n>1 才出现——上一个/下一个 + 位置计数（n/N）
    {
      prevB = _mBtn(_OV_MEDIA_ICONS.prevSong, _i('shell.overlay.mprev', '上一个'));
      prevB.classList.add('ovmb-prev');
      nextB = _mBtn(_OV_MEDIA_ICONS.nextSong, _i('shell.overlay.mnext', '下一个'));
      nextB.classList.add('ovmb-next');
      prevB.addEventListener('click', function () { if (api.onPrev) { api.onPrev(); } });
      nextB.addEventListener('click', function () { if (api.onNext) { api.onNext(); } });
      posT = document.createElement('span');
      posT.className = 'ovmb-pos';
      posT.textContent = (api.idx + 1) + '/' + api.n;
      if (!(api && api.n > 1)) { prevB.style.display = 'none'; nextB.style.display = 'none'; posT.style.display = 'none'; }
    }

    // 粘性应用（会话内跨文件保持）
    // ★ defaultPlaybackRate 同步（2026-09-26 v4 修正）：媒体 load 算法（设 src/load()）会把 playbackRate 重置回 defaultPlaybackRate——
    //   只写 playbackRate 会被首次加载/切轨冲回 1；双写后 sticky 100% 生效。
    mEl.playbackRate = _ovMediaRate;
    mEl.defaultPlaybackRate = _ovMediaRate;

    function _togglePlay() {
      if (mEl.paused || mEl.ended) {
        if (mEl.ended) { try { mEl.currentTime = 0; } catch (_) { } }   // 播毕重播（模式引擎弃用原生 loop 后的重播入口）
        var p = mEl.play(); if (p && p.catch) { p.catch(function () { }); }
      } else { mEl.pause(); }
      try { syncPlay(); } catch (_) { }   // 图标立即对齐真值（play/pause 同步落定 paused 属性）
    }
    function syncPlay() {
      var playing = !mEl.paused && !mEl.ended;
      playB.innerHTML = _ovMediaIcon(playing ? _OV_MEDIA_ICONS.pause : _OV_MEDIA_ICONS.play);
      playB.title = playing ? _i('shell.overlay.mpause', '暂停') : _i('shell.overlay.mplay', '播放');
    }
    function syncVol() {
      var m = !!mEl.muted || _volWant === 0;
      volB.innerHTML = _ovMediaIcon(m ? _OV_MEDIA_ICONS.volMute : _OV_MEDIA_ICONS.vol);
      volB.title = m ? _i('shell.overlay.munmute', '取消静音') : _i('shell.overlay.mmute', '静音');
      volS.value = String(_volWant);
      volS.classList.toggle('ovmb-vboost', _volWant > 1);
      try { if (_boostGain) { _boostGain.gain.value = mEl.muted ? 0 : Math.max(1, _volWant); } } catch (_) { }
    }
    function syncProg() {
      var d = mEl.duration, ok = isFinite(d) && d > 0;
      var pct = ok ? Math.max(0, Math.min(100, (mEl.currentTime / d) * 100)) : 0;
      seekFill.style.width = pct + '%';
      seekDot.style.left = pct + '%';
      curT.textContent = _ovFmtT(mEl.currentTime);
      durT.textContent = ok ? _ovFmtT(d) : '--:--';
    }
    function _ovFmtRate(v) { return String(Math.round(v * 100) / 100); }
    // ★ 倍速 × 标记（2026-10-01 q319 用户定案）：加大一号 + 不加粗 + 底对齐（数字恒 600）——芯片/面板同源唯一入口
    function _ovRateHTML(v) { return '<span class="ovmb-rate-lab">' + _ovFmtRate(v) + '<span class="ovmb-rate-x">\u00D7</span></span>'; }
    function syncRate() {
      rateB.innerHTML = _ovRateHTML(_ovMediaRate);
      rateB.classList.toggle('ovmb-on', _ovMediaRate !== 1);
      if (_panel) {
        var _rpnBtns = _panel.querySelectorAll('.ovmb-rbtn');
        for (var _rpi = 0; _rpi < _rpnBtns.length; _rpi++) {
          _rpnBtns[_rpi].classList.toggle('ovmb-on', Math.abs(parseFloat(_rpnBtns[_rpi].textContent) - _ovMediaRate) < 0.001);
        }
      }
    }
    // ★ 倍速面板（2026-09-26 v2 用户定案）：点击 [1×] 在按钮上方展开——0.5~4 预设单按钮网格（每步一个按钮）+ 自定义倍数（确认/回车任意值）
    var _panel = null, _panelDocFn = null;
    function _applyRate(v) {
      if (!isFinite(v)) { return; }
      v = Math.round(Math.max(0.0625, Math.min(16, v)) * 100) / 100;
      _ovMediaRate = v;
      mEl.playbackRate = v;
      mEl.defaultPlaybackRate = v;
      syncRate();
      _persistTick();
    }
    // ★ 浮动面板防越界：先量后位——默认 CSS（右缘贴宿主右缘 + 上展）量实后双轴钳制进主列（≥8px）；
    //   顶越界 → 翻到宿主下方，再越底 → 贴底。边界盒 = 主列（overflow:hidden 的裁剪祖先）；禁按视口/固定偏移公式（主列外部分必被裁）。
    function _placeFloatPanel(pn, host) {
      try {
        var M = 8;
        var boxEl = (layout && layout.main) || null;
        var box = boxEl ? boxEl.getBoundingClientRect() :
          { left: 0, top: 0, right: (window.innerWidth || 0), bottom: (window.innerHeight || 0) };
        var hr = host.getBoundingClientRect();
        var pr = pn.getBoundingClientRect();
        var dx = 0;
        if (pr.right > box.right - M) { dx = (box.right - M) - pr.right; }
        if (pr.left + dx < box.left + M) { dx = (box.left + M) - pr.left; }
        if (dx) { pn.style.right = Math.round(-dx) + 'px'; }
        if (pr.top < box.top + M) {
          pn.style.bottom = 'auto';
          pn.style.top = Math.round(hr.height + 10) + 'px';
          pr = pn.getBoundingClientRect();
          if (pr.bottom > box.bottom - M) {
            pn.style.top = Math.round((box.bottom - M - pr.height) - hr.top) + 'px';
          }
        }
      } catch (_) { }
    }

    function _closeRatePanel() {
      if (_panelDocFn) { document.removeEventListener('pointerdown', _panelDocFn, true); _panelDocFn = null; }
      if (_panel && _panel.parentNode) { _panel.parentNode.removeChild(_panel); }
      _panel = null;
      _refreshEscapeHook();
    }
    function _toggleRatePanel() {
      if (_panel) { _closeRatePanel(); return; }
      _closeModePanel();
      var pn = document.createElement('div');
      pn.className = 'ovmb-ratepanel';
      for (var ri = 0; ri < _OV_MEDIA_RATE_PRESETS.length; ri++) {
        var rb = document.createElement('button');
        rb.className = 'ovmb-rbtn' + (Math.abs(_OV_MEDIA_RATE_PRESETS[ri] - _ovMediaRate) < 0.001 ? ' ovmb-on' : '');
        rb.tabIndex = -1;
        rb.setAttribute('data-no-cd', '');
        rb.innerHTML = _ovRateHTML(_OV_MEDIA_RATE_PRESETS[ri]);
        (function (rv) {
          rb.addEventListener('click', function () { _applyRate(rv); _closeRatePanel(); });
        })(_OV_MEDIA_RATE_PRESETS[ri]);
        pn.appendChild(rb);
      }
      var row = document.createElement('div');
      row.className = 'ovmb-rrow';
      var inp = document.createElement('input');
      inp.className = 'ovmb-rinput';
      inp.type = 'text'; inp.inputMode = 'decimal';
      inp.placeholder = _i('shell.overlay.mspeedCustom', '自定义倍数');
      inp.setAttribute('data-no-cd', '');
      var okB = document.createElement('button');
      okB.className = 'ovmb-rok'; okB.tabIndex = -1;
      okB.setAttribute('data-no-cd', '');
      okB.textContent = _i('shell.overlay.mspeedOk', '确认');
      okB.addEventListener('click', function () { _applyRate(parseFloat(inp.value)); _closeRatePanel(); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); _applyRate(parseFloat(inp.value)); _closeRatePanel(); }
      });
      row.appendChild(inp); row.appendChild(okB);
      pn.appendChild(row);
      rateHost.appendChild(pn);
      _placeFloatPanel(pn, rateHost);
      _panel = pn;
      _panelDocFn = function (e) { if (!rateHost.contains(e.target)) { _closeRatePanel(); } };
      document.addEventListener('pointerdown', _panelDocFn, true);
      _refreshEscapeHook();
      try { inp.focus(); } catch (_) { }
    }
    // ═══ ★ 播放模式机器（2026-09-26 q319）：按钮 = 进入点（位置与语义 = 全行业标准循环位，禁另设第二控件）═══
    //   面板全列五模式（单选即生效）；按钮外观随模式（once/listOnce = 暗色 ↔ one/listLoop/shuffle = 金色；one 带角落 1；shuffle 换图标）
    var _mpanel = null, _mpanelDocFn = null;
    function _refreshEscapeHook() {
      _engEscHook = function () {
        if (_mpanel) { _closeModePanel(); return true; }
        if (_panel) { _closeRatePanel(); return true; }
        return false;
      };
    }
    function syncMode() {
      loopB.dataset.loop = _ovMediaLoop;
      loopB.dataset.shuffle = _ovMediaShuffle ? '1' : '0';
      loopB.innerHTML = _ovMediaIcon(_ovMediaShuffle ? _OV_MEDIA_ICONS.shuffle : _OV_MEDIA_ICONS.repeat) +
        (_ovMediaLoop === 'one' ? '<span class="ovmb-m1">1</span>' : '');
      loopB.classList.toggle('ovmb-on', _ovMediaLoop !== 'off' || _ovMediaShuffle);
      loopB.title = _i('shell.overlay.mmode', '播放模式（L 循环 / R 随机）') + ' · ' +
        _i('shell.overlay.mlooplab', '循环') + '：' + _ovLoopName(_ovMediaLoop) + ' · ' +
        _i('shell.overlay.mshuflab', '随机') + '：' + _ovShufName(_ovMediaShuffle);
      if (_mpanel) {
        var _mbs = _mpanel.querySelectorAll('.ovmb-mopt');
        for (var _mi = 0; _mi < _mbs.length; _mi++) {
          var _mvOn = (_mbs[_mi].dataset.dim === 'loop' && _mbs[_mi].dataset.val === _ovMediaLoop) ||
            (_mbs[_mi].dataset.dim === 'shuffle' && _mbs[_mi].dataset.val === (_ovMediaShuffle ? '1' : '0'));
          _mbs[_mi].classList.toggle('ovmb-on', _mvOn);
        }
      }
    }
    // 维度写入唯一收敛点（面板点击 / L·R 键共走）：写状态 → 刷新外观 → 通知外部（随机开启时重建随机袋）
    function _applyLoop(v) {
      _ovMediaLoop = v; syncMode();
      _persistTick();
      if (api && api.onModeChange) { try { api.onModeChange('loop'); } catch (_) { } }
    }
    function _applyShuffle(v) {
      _ovMediaShuffle = !!v; syncMode();
      _persistTick();
      if (api && api.onModeChange) { try { api.onModeChange('shuffle'); } catch (_) { } }
    }
    function _closeModePanel() {
      if (_mpanelDocFn) { document.removeEventListener('pointerdown', _mpanelDocFn, true); _mpanelDocFn = null; }
      if (_mpanel && _mpanel.parentNode) { _mpanel.parentNode.removeChild(_mpanel); }
      _mpanel = null;
      _refreshEscapeHook();
    }
    // 面板 = 两行并列维度（循环 / 随机）——单选即生效、面板保持打开（另一维可接着调）；外点/Esc 关闭
    function _toggleModePanel() {
      if (_mpanel) { _closeModePanel(); return; }
      _closeRatePanel();
      var pn = document.createElement('div');
      pn.className = 'ovmb-modepanel';
      function _mRow(labKey, labFb, opts) {
        var row = document.createElement('div');
        row.className = 'ovmb-mrow';
        var lab = document.createElement('span');
        lab.className = 'ovmb-mlab';
        lab.textContent = _i(labKey, labFb);
        row.appendChild(lab);
        for (var oi = 0; oi < opts.length; oi++) {
          (function (opt) {
            var b = document.createElement('button');
            b.className = 'ovmb-mopt';
            b.tabIndex = -1;
            b.setAttribute('data-no-cd', '');
            b.dataset.dim = opt[0]; b.dataset.val = opt[1];
            b.textContent = opt[2];
            b.addEventListener('mousedown', function (e) { e.preventDefault(); });
            b.addEventListener('click', function () {
              if (opt[0] === 'loop') { _applyLoop(opt[1]); } else { _applyShuffle(opt[1] === '1'); }
            });
            row.appendChild(b);
          })(opts[oi]);
        }
        return row;
      }
      pn.appendChild(_mRow('shell.overlay.mlooplab', '循环', [
        ['loop', 'off', _i('shell.overlay.mOff', '关')],
        ['loop', 'all', _i('shell.overlay.modeListLoop', '列表循环')],
        ['loop', 'one', _i('shell.overlay.modeOne', '单曲循环')]
      ]));
      pn.appendChild(_mRow('shell.overlay.mshuflab', '随机', [
        ['shuffle', '0', _i('shell.overlay.mOff', '关')],
        ['shuffle', '1', _i('shell.overlay.mOn', '开')]
      ]));
      modeHost.appendChild(pn);
      _placeFloatPanel(pn, modeHost);
      _mpanel = pn;
      syncMode();
      _mpanelDocFn = function (e) { if (!modeHost.contains(e.target)) { _closeModePanel(); } };
      document.addEventListener('pointerdown', _mpanelDocFn, true);
      _refreshEscapeHook();
    }
    function _cycleLoop() {
      _applyLoop(_ovMediaLoop === 'off' ? 'all' : (_ovMediaLoop === 'all' ? 'one' : 'off'));
      _toast(_i('shell.overlay.mlooplab', '循环') + '：' + _ovLoopName(_ovMediaLoop));
    }
    function _toggleShuffle() {
      _applyShuffle(!_ovMediaShuffle);
      _toast(_i('shell.overlay.mshuflab', '随机') + '：' + _ovShufName(_ovMediaShuffle));
    }
    // ═══ ★ 播放列表面板 → 侧边 dock（v5，2026-09-26 q319 用户定案）：列表 n>1 恒显于播放器左/右侧（侧栏常驻，非弹出面板）；═══
    //   序号 + 文件名 + 行尾三钮（上移/下移/移除）；拖动 = 指针拖拽重排（阈值 5px，未达阈值零干扰）；边随记忆（⇄ 已删）；
    //   当前轨 ▶ 金色高亮、自动进位/重排/移除后高亮跟随并滚入视野；点击任意行切轨（拖动余波点击自动抑制）；n≤1 整体隐藏。
    var dockEl = null, _plListEl = null, _dockCntEl = null;
    var _dockSide = ((api && api.dockSide) === 'left') ? 'left' : 'right';
    var _plDrag = { from: -1, on: false, y0: 0, j: -1, after: false, el: null };
    var _plDragEndAt = 0;   // 拖动收尾余波点击抑制（<400ms 内行点击忽略）
    function _syncPl() {
      if (!_plListEl || !api || !api.list) { return; }
      var rows = _plListEl.querySelectorAll('.ovmb-prowwrap');
      var cur = api.idx || 0;
      for (var pi = 0; pi < rows.length; pi++) {
        var isCur = (pi === cur);
        rows[pi].classList.toggle('ovmb-cur', isCur);
        var mk = rows[pi].querySelector('.ovmb-pmark');
        if (mk) { mk.textContent = isCur ? '\u25B6' : ''; }
        if (isCur) {   // 仅滚动列表自身（scrollIntoView 会连祖先容器一起滚——禁止挪动外部容器）
          try {
            var _le = _plListEl;
            if (_le) {
              var _lr = _le.getBoundingClientRect(), _rr = rows[pi].getBoundingClientRect();
              if (_rr.top < _lr.top) { _le.scrollTop -= (_lr.top - _rr.top); }
              else if (_rr.bottom > _lr.bottom) { _le.scrollTop += (_rr.bottom - _lr.bottom); }
            }
          } catch (_) { }
        }
      }
    }
    // 行操作三钮（上移/下移/移除）——不拖也能整理列表；首/末行对应方向钮禁用（禁 button 嵌套：行容器 = div，名称区 = 内嵌按钮）
    function _plOpBtn(op, glyph, title, idx) {
      var b = document.createElement('button');
      b.className = 'ovmb-pop';
      b.tabIndex = -1;
      b.setAttribute('data-no-cd', '');
      b.textContent = glyph;
      b.title = title;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.stopPropagation(); _plRowOp(op, idx); });
      return b;
    }
    // 行重建（唯一渲染入口：建 dock/上移/下移/移除/拖动提交全走它）
    function _fillPlRows() {
      if (!_plListEl) { return; }
      var _L = (api && api.list) || [];
      var _st = _plListEl.scrollTop;
      _plListEl.innerHTML = '';
      if (_dockCntEl) { _dockCntEl.textContent = String(_L.length); }
      for (var pi2 = 0; pi2 < _L.length; pi2++) {
        (function (idx, item) {
          var wrap = document.createElement('div');
          wrap.className = 'ovmb-prowwrap';
          wrap.dataset.i = String(idx);
          var row = document.createElement('button');
          row.className = 'ovmb-prow';
          row.tabIndex = -1;
          row.setAttribute('data-no-cd', '');
          row.addEventListener('mousedown', function (e) { e.preventDefault(); });
          var mk = document.createElement('span'); mk.className = 'ovmb-pmark';
          var nm = document.createElement('span'); nm.className = 'ovmb-pidx'; nm.textContent = String(idx + 1);
          var tx = document.createElement('span'); tx.className = 'ovmb-pname';
          tx.textContent = (item && item.name) || String((item && item.localPath) || '').split(/[\\/]/).pop() || '';
          row.appendChild(mk); row.appendChild(nm); row.appendChild(tx);
          wrap.appendChild(row);
          wrap.title = tx.textContent;
          var ops = document.createElement('span'); ops.className = 'ovmb-pops';
          var upB = _plOpBtn('up', '\u2191', _i('shell.overlay.mplUp', '上移'), idx);
          var dnB = _plOpBtn('down', '\u2193', _i('shell.overlay.mplDown', '下移'), idx);
          var dlB = _plOpBtn('del', '\u2212', _i('shell.overlay.mplDel', '从播放列表移除'), idx);
          if (idx === 0) { upB.disabled = true; }
          if (idx === _L.length - 1) { dnB.disabled = true; }
          ops.appendChild(upB); ops.appendChild(dnB); ops.appendChild(dlB);
          wrap.appendChild(ops);
          wrap.addEventListener('click', function (e) {
            if (e.target && e.target.closest && e.target.closest('.ovmb-pop')) { return; }
            if (Date.now() - _plDragEndAt < 400) { return; }   // 拖动收尾的余波点击 → 忽略（防误切轨）
            if (api && api.jump) { api.jump(idx); }
          });
          _plListEl.appendChild(wrap);
        })(pi2, _L[pi2]);
      }
      _plListEl.scrollTop = _st;
    }
    // 行操作执行：外部列表变更（api.move/api.remove）→ dock 行重建 + 计数/高亮对齐；列表缩到单轨 → dock 整体隐藏（同单文件态）
    function _plRowOp(op, idx) {
      if (!api || !api.list) { return; }
      if (op === 'up' && api.move) { api.move(idx, idx - 1); }
      else if (op === 'down' && api.move) { api.move(idx, idx + 1); }
      else if (op === 'del' && api.remove) { api.remove(idx); }
      onListChanged();
    }
    function onListChanged() {
      var many = !!(api && api.n > 1);
      if (prevB) { prevB.style.display = many ? '' : 'none'; }
      if (nextB) { nextB.style.display = many ? '' : 'none'; }
      if (posT) {
        posT.style.display = many ? '' : 'none';
        if (api) { posT.textContent = ((api.idx || 0) + 1) + '/' + api.n; }
      }
      if (dockEl) {
        dockEl.style.display = many ? 'flex' : 'none';
        if (_dockCntEl) { _dockCntEl.textContent = String((api && api.n) || 0); }
      }
      if (!many) { try { _plDragClear(); } catch (_) { } return; }
      _fillPlRows();
      setTrack(api.idx || 0);
    }
    // ── 指针拖动重排（阈值 5px：未达阈值 = 纯点击，零干扰；拖动中只换顺序不动播放）──
    //   跟随监听挂 document 捕获相位：指针移出列表/面板（或 setPointerCapture 失效）时事件也不丢——pointerup 必达
    function _plDocMove(e) {
      if (_plDrag.from < 0) { return; }
      if (!_plDrag.on) {
        if (Math.abs(e.clientY - _plDrag.y0) < 5) { return; }
        _plDrag.on = true;
        try { if (_plListEl) { _plListEl.setPointerCapture(e.pointerId); } } catch (_) { }
        if (_plDrag.el) { _plDrag.el.classList.add('ovmb-dragging'); }
      }
      if (e.cancelable) { e.preventDefault(); }
      _plDragCalc(e.clientY);
    }
    function _plDocUp(e) { if (_plDrag.from >= 0) { _plDragEnd(e); } }
    function _plDocCancel() { _plDragClear(); }
    function _plDragAttach() {
      _plDragDetach();
      document.addEventListener('pointermove', _plDocMove, true);
      document.addEventListener('pointerup', _plDocUp, true);
      document.addEventListener('pointercancel', _plDocCancel, true);
    }
    function _plDragDetach() {
      document.removeEventListener('pointermove', _plDocMove, true);
      document.removeEventListener('pointerup', _plDocUp, true);
      document.removeEventListener('pointercancel', _plDocCancel, true);
    }
    function _plDragCalc(cy) {
      if (!_plListEl) { return; }
      var ws = _plListEl.querySelectorAll('.ovmb-prowwrap');
      if (!ws.length) { return; }
      var j = -1, after = false;
      for (var di = 0; di < ws.length; di++) {
        var r = ws[di].getBoundingClientRect();
        if (cy >= r.top && cy <= r.bottom) { j = di; after = (cy > r.top + r.height / 2); break; }
      }
      if (j === -1) {
        var r0 = ws[0].getBoundingClientRect(), rl = ws[ws.length - 1].getBoundingClientRect();
        if (cy < r0.top) { j = 0; after = false; } else { j = ws.length - 1; after = true; }
      }
      _plDrag.j = j; _plDrag.after = after;
      for (var ci = 0; ci < ws.length; ci++) { ws[ci].classList.remove('ovmb-dtop', 'ovmb-dbot'); }
      if (ws[j]) { ws[j].classList.add(after ? 'ovmb-dbot' : 'ovmb-dtop'); }
      var lr = _plListEl.getBoundingClientRect();
      if (cy < lr.top + 18) { _plListEl.scrollTop -= 6; }
      else if (cy > lr.bottom - 18) { _plListEl.scrollTop += 6; }
    }
    function _plDragClear() {
      _plDragDetach();
      if (_plListEl) {
        var ws = _plListEl.querySelectorAll('.ovmb-prowwrap');
        for (var ci = 0; ci < ws.length; ci++) { ws[ci].classList.remove('ovmb-dragging', 'ovmb-dtop', 'ovmb-dbot'); }
      }
      _plDrag.from = -1; _plDrag.on = false; _plDrag.j = -1; _plDrag.el = null;
    }
    function _plDragEnd(e) {
      if (_plDrag.from < 0) { return; }
      var from = _plDrag.from, on = _plDrag.on, j = _plDrag.j, after = _plDrag.after;
      try { if (on && _plListEl) { _plListEl.releasePointerCapture(e.pointerId); } } catch (_) { }
      _plDragClear();
      if (!on || j < 0) { return; }             // 未达阈值 = 普通点击（click 流程照常）
      _plDragEndAt = Date.now();
      if (!api || !api.move) { return; }
      var ins0 = after ? j + 1 : j;
      var to = ins0 > from ? ins0 - 1 : ins0;
      if (to === from) { return; }
      api.move(from, to);
      if (_plListEl) { _fillPlRows(); setTrack(api.idx || 0); }
    }
    // ── dock 构建（唯一入口：mount 时建一次；此后只做显隐/重排）──
    function _applyDockSide(side) {
      _dockSide = (side === 'left') ? 'left' : 'right';
      try {
        if (dockEl && layout && layout.shell) {
          if (_dockSide === 'left' && layout.main) { layout.shell.insertBefore(dockEl, layout.main); }
          else { layout.shell.appendChild(dockEl); }
        }
      } catch (_) { }
      _ovDockSide = _dockSide;
    }
    function _buildDock() {
      dockEl = document.createElement('div');
      dockEl.className = 'ovmb-dock';
      var head = document.createElement('div');
      head.className = 'ovmb-dhead';
      var ht = document.createElement('span');
      ht.className = 'ovmb-dtitle';
      ht.textContent = _i('shell.overlay.mplist', '播放列表');
      _dockCntEl = document.createElement('span');
      _dockCntEl.className = 'ovmb-dcnt';
      _dockCntEl.textContent = String(api ? api.n : 0);
      // ★ 2026-10-01 q319：列表头「⇄ 切边」按钮整体删除（用户判定无用）——停靠边随记忆保持，无手动入口
      head.appendChild(ht); head.appendChild(_dockCntEl);
      dockEl.appendChild(head);
      _plListEl = document.createElement('div');
      _plListEl.className = 'ovmb-pllist';
      // 指针拖动重排：pointerdown 记源 → 越过阈值（5px）才进入拖动（未达阈值 = 纯点击零干扰；行尾按钮上不启动）
      _plListEl.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) { return; }
        if (e.target && e.target.closest && e.target.closest('.ovmb-pop')) { return; }
        var wrap = (e.target && e.target.closest) ? e.target.closest('.ovmb-prowwrap') : null;
        if (!wrap) { return; }
        _plDrag.from = +wrap.dataset.i; _plDrag.on = false; _plDrag.y0 = e.clientY; _plDrag.el = wrap;
        _plDragAttach();   // 跟随监听挂 document 捕获相位（pointerup 必达；拖动结束自动摘除）
      });
      dockEl.appendChild(_plListEl);
      _applyDockSide(_dockSide);
    }

    // ═══ ★ A-B 循环（2026-09-26 q319）：A/B 点均存在且在播 → currentTime ≥ B 跳回 A ═══
    //   驱动 = rAF 高频（≤1 帧过冲）+ timeupdate 兜底（后台标签 rAF 节流）；拖动进度中不干预（_seeking）；
    //   时间点无跨文件意义 → 状态 per-file（打开即清零，不作会话粘性）。
    var _abA = null, _abB = null, _abRaf = 0;
    function _abRender() {
      var d = mEl.duration, ok = isFinite(d) && d > 0;
      var okA = _abA !== null && ok, okB = _abB !== null && ok;
      var aPct = okA ? Math.max(0, Math.min(100, (_abA / d) * 100)) : 0;
      var bPct = okB ? Math.max(0, Math.min(100, (_abB / d) * 100)) : 0;
      abMarkA.style.display = okA ? 'block' : 'none';
      abMarkB.style.display = okB ? 'block' : 'none';
      if (okA) { abMarkA.style.left = aPct + '%'; }
      if (okB) { abMarkB.style.left = bPct + '%'; }
      abZone.style.display = (okA && okB) ? 'block' : 'none';
      if (okA && okB) { abZone.style.left = aPct + '%'; abZone.style.width = Math.max(0, bPct - aPct) + '%'; }
      abB.classList.toggle('ovmb-arm', _abA !== null && _abB === null);
      abB.classList.toggle('ovmb-on', _abA !== null && _abB !== null);
      abB.title = _abA === null
        ? _i('shell.overlay.mab', 'A-B 循环（快捷键 A）')
        : (_abB === null
          ? _i('shell.overlay.mabA', '标 B 点（A: {t}，快捷键 A）', { t: _ovFmtT(_abA) })
          : _i('shell.overlay.mabAB', '清除 A-B 循环（{a} → {b}，快捷键 A）', { a: _ovFmtT(_abA), b: _ovFmtT(_abB) }));
    }
    function _abCheck() {
      if (_abA === null || _abB === null || _seeking) { return; }
      if (!mEl.paused && !mEl.ended && mEl.currentTime >= _abB - 0.012) {
        try { mEl.currentTime = _abA; } catch (_) { }
      }
    }
    function _abTick() { _abRaf = 0; _abCheck(); _abStart(); }
    function _abStart() {
      if (!_abRaf && _abA !== null && _abB !== null && !mEl.paused && !mEl.ended) {
        _abRaf = requestAnimationFrame(_abTick);
      }
    }
    function _abStop() { if (_abRaf) { cancelAnimationFrame(_abRaf); _abRaf = 0; } }
    function _abCycle() {
      try {
        if (_abA === null) {
          _abA = mEl.currentTime;
          _abRender();
          _toast(_i('shell.overlay.mabSetA', '已标记 A 点：{t}', { t: _ovFmtT(_abA) }));
          return;
        }
        if (_abB === null) {
          var a = _abA, b = mEl.currentTime;
          if (b < a) { var sw = a; a = b; b = sw; }                      // 反向标记 → 交换（区间恒 A<B）
          var _dur = (isFinite(mEl.duration) && mEl.duration > 0) ? mEl.duration : null;
          if (b - a < 0.15) { b = a + 0.15; }                            // 过近 → 撑开最小区间 0.15s
          if (_dur && b > _dur) { b = _dur; if (b - a < 0.15) { a = Math.max(0, b - 0.15); } }
          _abA = a; _abB = b;
          try { mEl.currentTime = a; } catch (_) { }                     // 标记即起循：跳回 A 点
          _abRender(); _abStart();
          _toast(_i('shell.overlay.mabSetB', 'A-B 循环已开启：{a} → {b}', { a: _ovFmtT(a), b: _ovFmtT(b) }));
          return;
        }
        _abA = null; _abB = null;
        _abStop(); _abRender();
        _toast(_i('shell.overlay.mabClear', '已清除 A-B 循环'));
      } catch (_) { }
    }
    abB.addEventListener('click', _abCycle);

    // 播放状态事件（★ emptied 补挂（2026-09-28 q319）：重设 src 打断播放时 Chromium 只发 abort/emptied、不发 pause
    //   ——探针实锤；缺它则图标停在旧态：「切歌后按钮显示还在播放」的一道根因）
    mEl.addEventListener('play', syncPlay);
    mEl.addEventListener('pause', syncPlay);
    mEl.addEventListener('ended', syncPlay);
    mEl.addEventListener('emptied', syncPlay);
    mEl.addEventListener('timeupdate', syncProg);
    mEl.addEventListener('timeupdate', _abCheck);
    mEl.addEventListener('loadedmetadata', syncProg);
    mEl.addEventListener('loadedmetadata', _abRender);
    mEl.addEventListener('durationchange', syncProg);
    mEl.addEventListener('durationchange', _abRender);
    mEl.addEventListener('volumechange', syncVol);
    mEl.addEventListener('play', _abStart);
    mEl.addEventListener('pause', _abStop);
    mEl.addEventListener('ended', _abStop);
    // ★ 播放模式引擎（2026-09-26 q319）：ended → A-B 优先（跳回 A 续循环，显式意图更强）；否则交外部 onEnded（列表/单文件退化裁决）
    mEl.addEventListener('ended', function () {
      if (_abA !== null) {
        try { mEl.currentTime = _abA; } catch (_) { }
        var _ap = mEl.play(); if (_ap && _ap.catch) { _ap.catch(function () { }); }
        return;
      }
      if (api && api.onEnded) { try { api.onEnded(); } catch (_) { } }
    });

    // 按钮
    playB.addEventListener('click', _togglePlay);
    volB.addEventListener('click', function () {
      mEl.muted = !mEl.muted;
      if (!mEl.muted && _volWant === 0) { _setVol(1); }
    });
    volS.addEventListener('pointerdown', function () { _volTipShow(2500); });
    volS.addEventListener('input', function () {
      _setVol(parseFloat(volS.value));
      mEl.muted = _volWant === 0;
      _volTipShow(1200);
    });
    volS.addEventListener('change', function () { _volTipShow(500); });
    rateB.addEventListener('click', _toggleRatePanel);
    loopB.addEventListener('click', _toggleModePanel);
    if (isVid) {
      // 点击画面 = 播放/暂停（原生控件同款手势）
      mEl.addEventListener('click', function () { _togglePlay(); });
    }

    // 拖动进度（指针捕获：拖出条外也跟手）
    var _seeking = false;
    function _seekAt(clientX) {
      var r = seekTrack.getBoundingClientRect();
      if (!r.width) { return; }
      var ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      seekFill.style.width = (ratio * 100) + '%';
      seekDot.style.left = (ratio * 100) + '%';
      var d = mEl.duration;
      if (isFinite(d) && d > 0) {
        curT.textContent = _ovFmtT(ratio * d);
        try { mEl.currentTime = ratio * d; } catch (_) { }
      }
    }
    seek.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) { return; }
      _seeking = true;
      seek.classList.add('ovmb-drag');
      try { seek.setPointerCapture(e.pointerId); } catch (_) { }
      _seekAt(e.clientX);
      e.preventDefault();
    });
    seek.addEventListener('pointermove', function (e) { if (_seeking) { _seekAt(e.clientX); } });
    function _seekEnd(e) {
      if (!_seeking) { return; }
      _seeking = false;
      seek.classList.remove('ovmb-drag');
      try { seek.releasePointerCapture(e.pointerId); } catch (_) { }
    }
    seek.addEventListener('pointerup', _seekEnd);
    seek.addEventListener('pointercancel', _seekEnd);

    // 画中画 + 全屏（仅视频）★ 2026-09-26 v2：失败可见（qoast 携原因，绝不静默吞）
    function _ovFsFail(reason) {
      try { _toast(_i('shell.overlay.mfsFail', '全屏失败') + (reason ? '（' + reason + '）' : ''), 'error'); } catch (_) { }
    }
    function _toggleFs() {
      try {
        if (document.fullscreenElement) {
          var _ex = document.exitFullscreen();
          if (_ex && _ex.catch) { _ex.catch(function () { }); }
          return;
        }
        if (!wrapEl || !wrapEl.requestFullscreen) { _ovFsFail('unsupported'); return; }
        var r = wrapEl.requestFullscreen();
        if (r && r.catch) { r.catch(function (e) { _ovFsFail(e && (e.name || e.message)); }); }
      } catch (e) { _ovFsFail(e && (e.name || e.message)); }
    }
    var _onFsChange = function () {
      if (fsB) { fsB.innerHTML = _ovMediaIcon(document.fullscreenElement === wrapEl ? _OV_MEDIA_ICONS.fsExit : _OV_MEDIA_ICONS.fs); }
    };
    // ★ 逐帧步进（2026-09-26 v2）：暂停并前进/后退一帧；帧率 = rVFC 实测（EMA），未测到回落 30fps
    function _stepFrame(dir) {
      try {
        if (!mEl.paused) { mEl.pause(); }
        var fps = (_ovMediaFps > 1 && _ovMediaFps < 241) ? _ovMediaFps : 30;
        var d = (isFinite(mEl.duration) && mEl.duration > 0) ? mEl.duration : 1e9;
        var nt = mEl.currentTime + dir * (1 / fps);
        mEl.currentTime = Math.max(0, Math.min(nt, d - 0.0005));
      } catch (_) { }
    }

    // ═══ ★ 单帧截图（2026-09-26 q319）：当前帧 → 全分辨率 PNG（canvas 原尺寸）═══
    //   落盘 = HOST.bridge.fs.writeBase64（主进程原子写）；目标 = 源文件同目录（重名自动 _1/_2…绝不覆盖——Roam 风格末尾下划线，2026-09-26 定案）；
    //   转码回放场景基准恒为原始文件（api.getBase），不污染 Cache 产物目录；完成 qoast 带「📂 Roam 定位」（快捷键 S）。
    function _ovShotTc(sec) {
      function z(n, w) { n = String(n); while (n.length < w) { n = '0' + n; } return n; }
      var ms = Math.floor((sec % 1) * 1000);
      return z(Math.floor(sec / 3600), 2) + '-' + z(Math.floor(sec / 60) % 60, 2) + '-' + z(Math.floor(sec) % 60, 2) + '.' + z(ms, 3);
    }
    function _ovShotJoin(dir, name) {
      var sep = (dir.indexOf('\\') >= 0 || dir.indexOf('/') < 0) ? '\\' : '/';
      return dir + (/[\\/]$/.test(dir) ? '' : sep) + name;
    }
    function _ovShotReveal(p) {
      try { if (H.reveal) { H.reveal(p); return; } } catch (_) { }
      try { if (H.bridge && H.bridge.shell && H.bridge.shell.showItemInFolder) { H.bridge.shell.showItemInFolder(p); } } catch (_) { }
    }
    function _ovShot() {
      if (!isVid) { return; }
      function _fail(reason) {
        _toast(_i('shell.overlay.mshotFail', '截图失败') + (reason ? '（' + reason + '）' : ''), 'error');
      }
      var b64 = '';
      try {
        if (!mEl.videoWidth || !mEl.videoHeight) { _fail('not-ready'); return; }
        var cv = document.createElement('canvas');
        cv.width = mEl.videoWidth; cv.height = mEl.videoHeight;
        cv.getContext('2d').drawImage(mEl, 0, 0, cv.width, cv.height);
        var durl = cv.toDataURL('image/png');
        var comma = durl.indexOf(',');
        if (comma < 0 || !durl.slice(comma + 1)) { _fail('encode'); return; }
        b64 = durl.slice(comma + 1);
      } catch (err) { _fail((err && err.name) || 'capture'); return; }
      var srcPath = String(((api && api.getBase) ? api.getBase() : '') || _localPathFromSrc(mEl.src) || '');
      var dir = '', base = '';
      var mm = /^(.*)[\\/]([^\\/]*)$/.exec(srcPath);
      if (mm && mm[1] && mm[2]) { dir = mm[1]; base = mm[2].replace(/\.[^.]*$/, ''); }
      if (!dir) {
        try { if (H.getLastDir) { dir = String(H.getLastDir() || ''); } } catch (_) { }
        base = base || 'screenshot';
      }
      if (!dir || !H.bridge || !H.bridge.fs || !H.bridge.fs.writeBase64) { _fail('no-path'); return; }
      var tc = _ovShotTc(mEl.currentTime || 0);
      function _try(idx) {
        var fname = base + '_' + tc + (idx ? '_' + idx : '') + '.png';
        var target = _ovShotJoin(dir, fname);
        var chk = (H.bridge.fs.exists) ? H.bridge.fs.exists(target) : Promise.resolve(false);
        chk.then(function (ex) {
          if (ex) { if (idx < 99) { _try(idx + 1); } else { _fail('collision'); } return; }
          return H.bridge.fs.writeBase64(target, b64).then(function (ok) {
            if (!ok) { _fail('write'); return; }
            var msg = _i('shell.overlay.mshotSaved', '已保存截图：{name}', { name: fname });
            try {
              _toast(msg, {
                type: 'success', duration: 12000,
                action: { label: _i('shell.dl.roamLocate', '📂 Roam 定位'), onClick: function () { _ovShotReveal(target); } },
              });
              return;
            } catch (_) { }
            _toast(msg, 'success');
          });
        }).catch(function () { _fail('write'); });
      }
      _try(0);
    }
    if (isVid) {
      if (document.pictureInPictureEnabled) {
        pipB = _mBtn(_OV_MEDIA_ICONS.pip, _i('shell.overlay.mpip', '画中画'));
        pipB.addEventListener('click', function () {
          try {
            if (document.pictureInPictureElement) { document.exitPictureInPicture(); }
            else { var pv = mEl.requestPictureInPicture(); if (pv && pv.catch) { pv.catch(function () { }); } }
          } catch (_) { }
        });
      }
      fsB = _mBtn(_OV_MEDIA_ICONS.fs, _i('shell.overlay.mfs', '全屏'));
      fsB.addEventListener('click', _toggleFs);
      document.addEventListener('fullscreenchange', _onFsChange);
      // ★ 帧率实测（rVFC：mediaTime 相邻差 → EMA；无 API 的旧内核自动回落 30fps）——供专属行逐帧按钮使用
      // ★ 单帧截图按钮（2026-09-26 q319）：当前帧 → PNG 落盘源文件旁（快捷键 S）
      shotB = _mBtn(_OV_MEDIA_ICONS.shot, _i('shell.overlay.mshot', '单帧截图（快捷键 S）'));
      shotB.classList.add('ovmb-shot');
      shotB.addEventListener('click', function () { _ovShot(); });
      _ovMediaFps = 0;
      var _vfcLast = 0, _vfcId = 0, _vfcFn = null;
      if (mEl.requestVideoFrameCallback) {
        _vfcFn = function (_now, meta) {
          var mt = meta && meta.mediaTime;
          if (_vfcLast && mt > _vfcLast) {
            var dt = mt - _vfcLast;
            if (dt > 0.002 && dt < 0.2) {
              var fp = 1 / dt;
              if (fp > 5 && fp < 241) { _ovMediaFps = _ovMediaFps ? (_ovMediaFps * 0.6 + fp * 0.4) : fp; }
            }
          }
          _vfcLast = mt;
          try { _vfcId = mEl.requestVideoFrameCallback(_vfcFn); } catch (_) { }
        };
        try { _vfcId = mEl.requestVideoFrameCallback(_vfcFn); } catch (_) { }
      }
    }

    // ═══ ★ 专属播放控制行 v7（2026-10-01 q319 用户定案）：按钮上下两段式（上=快捷键字母加大一号 / 下=图标）+ 每钮可见边界；
    //   播放+停止=中央对恒居中（左右空白相等）；两翼 逐帧（|◀/▶|——底条 ⏮/⏭ 同款 glyph 直复用，百分百等同下方笔触；v8 2026-10-01 用户定案）→ 4 秒（◀◀/▶▶ 双三角重叠）→ 速率（−0.5×/+0.5×）；
    //   停止（■）= 暂停并回到开头；播放/暂停 = 空格（不写键位）；停止无键位；键位簇：空格/QW/12/ZX。旧条不再含播放/单帧按钮。═══
    function _tBtn(inner, title, keycap, cls) {
      var b = document.createElement('button');
      b.className = 'ovmb-tbtn' + (cls ? ' ' + cls : '');
      b.tabIndex = -1;
      b.setAttribute('data-no-cd', '');
      b.innerHTML = (keycap ? '<span class="ovmb-kcap">' + keycap + '</span>' : '') + '<span class="ovmb-tbody">' + inner + '</span>';
      if (title) { b.title = title; }
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      return b;
    }
    function _seekBy(sec) {
      try {
        var dd = (isFinite(mEl.duration) && mEl.duration > 0) ? mEl.duration : 1e9;
        mEl.currentTime = Math.max(0, Math.min(dd, mEl.currentTime + sec));
      } catch (_) { }
    }
    function _rateStep(d) {
      var cur = _ovMediaRate;
      var v = Math.round((cur + d) * 100) / 100;
      if (d < 0 && v < 0.5 && cur >= 0.5) { v = 0.5; }   // 下限 0.5×（低于 0.5 的自定义值不被拉回）
      _applyRate(v);
    }
    function _doStop() {
      try { mEl.pause(); } catch (_) { }
      try { mEl.currentTime = 0; } catch (_) { }
      try { syncPlay(); syncProg(); } catch (_) { }
    }
    var trxRow = document.createElement('div');
    trxRow.className = 'ovmb-trx';
    var slowB = _tBtn('<span class="ovmb-tlab">\u22120.5\u00D7</span>', _i('shell.overlay.mslow', '减速 0.5×（快捷键 Z）'), 'Z', 'ovmb-slow');
    var seekBB = _tBtn(_ovRawIcon(_OV_TRX_ICONS.seekB), _i('shell.overlay.mseekB', '后退 4 秒（快捷键 Q）'), 'Q', 'ovmb-seekb');
    var stepBB = _tBtn(_ovMediaIcon(_OV_MEDIA_ICONS.prev), _i('shell.overlay.mstepB', '后退一帧（快捷键 1）'), '1', 'ovmb-stepb');
    var stopB = _tBtn(_ovRawIcon(_OV_TRX_ICONS.stop), _i('shell.overlay.mstop', '停止（暂停并回到开头）'), '', 'ovmb-stop');
    var stepFB = _tBtn(_ovMediaIcon(_OV_MEDIA_ICONS.next), _i('shell.overlay.mstepF', '前进一帧（快捷键 2）'), '2', 'ovmb-stepf');
    var seekFB = _tBtn(_ovRawIcon(_OV_TRX_ICONS.seekF), _i('shell.overlay.mseekF', '前进 4 秒（快捷键 W）'), 'W', 'ovmb-seekf');
    var fastB = _tBtn('<span class="ovmb-tlab">+0.5\u00D7</span>', _i('shell.overlay.mfast', '加速 0.5×（快捷键 X）'), 'X', 'ovmb-fast');
    slowB.addEventListener('click', function () { _rateStep(-0.5); });
    seekBB.addEventListener('click', function () { _seekBy(-4); });
    stepBB.addEventListener('click', function () { _stepFrame(-1); });
    stopB.addEventListener('click', _doStop);
    stepFB.addEventListener('click', function () { _stepFrame(1); });
    seekFB.addEventListener('click', function () { _seekBy(4); });
    fastB.addEventListener('click', function () { _rateStep(0.5); });
    // ★ 两翼等宽（flex:1）——播放+停止 = 中央对恒居整行正中（对心对称）；左翼右对齐 / 右翼左对齐（皆紧贴中央对）
    //   2026-10-01 q319 定案：停止键自右翼并入中央对 → 两翼内容等宽（Z/Q/1 ↔ 2/W/X）→ 左右空白恒相等（历史 44.5px 左空偏大根治）
    var wingL = document.createElement('div'); wingL.className = 'ovmb-trxl';
    var wingR = document.createElement('div'); wingR.className = 'ovmb-trxr';
    wingL.appendChild(slowB); wingL.appendChild(seekBB); wingL.appendChild(stepBB);
    wingR.appendChild(stepFB); wingR.appendChild(seekFB); wingR.appendChild(fastB);
    trxRow.appendChild(wingL);
    trxRow.appendChild(playB);   // ★ 旧播放按钮对象整体移入（syncPlay 单源不变）
    trxRow.appendChild(stopB);   // ★ 中央对 = [播放·停止]——对心对称（行整体居中优先，play 单体不再独占正中）
    trxRow.appendChild(wingR);

    if (prevB) { bar.appendChild(prevB); }
    if (nextB) { bar.appendChild(nextB); }
    bar.appendChild(curT);
    bar.appendChild(seek);
    bar.appendChild(durT);
    if (posT) { bar.appendChild(posT); }
    bar.appendChild(volB);
    volBox.appendChild(volS); volBox.appendChild(volTip);
    bar.appendChild(volBox);
    bar.appendChild(rateHost);
    bar.appendChild(modeHost);
    if (popB) { bar.appendChild(popB); }
    if (popInB) { bar.appendChild(popInB); }
    if (stowB) { bar.appendChild(stowB); }
    bar.appendChild(abB);
    if (shotB) { bar.appendChild(shotB); }
    if (pipB) { bar.appendChild(pipB); }
    if (fsB) { bar.appendChild(fsB); }

    // ★ 专属播放控制行 + 控制条 = 纵向双条栈（行在上 / 条在下；视频 = 主列底部浮层；音频 = 轻盒内联）
    var stack = document.createElement('div');
    stack.className = 'ovmb-stack' + (isVid ? '' : ' ovmb-stack-inline');
    stack.appendChild(trxRow);
    stack.appendChild(bar);

    // ★ 恒单行紧凑分档（2026-10-01 q319 用户定案）：行永不换行——按可用宽自动选档（t1/t2/t3）
    //   可用宽 = 容器真实可给宽（视频 = min(780, 94% 主列)；音频轻盒 = 92% 主列——与轻盒样式 max-width 同步，改盒样式必须同改）；
    //   选档后闭环自检：仍溢出则逐级降档（防字体/界面缩放环境差异）
    var _trxFitRaf = 0;
    var _trxRO = null;
    var _TRX_TIERS = ['', 'ovmb-t1', 'ovmb-t2', 'ovmb-t3'];
    function _fitTrxRow() {
      if (_trxFitRaf) { return; }
      _trxFitRaf = requestAnimationFrame(function () {
        _trxFitRaf = 0;
        try {
          var _mc = (layout && layout.main) ? layout.main.clientWidth : 0;
          if (!_mc) { return; }
          var _av = isVid ? Math.min(780, _mc * 0.94) : (_mc * 0.92);
          var _idx = _av >= 410 ? 0 : (_av >= 340 ? 1 : (_av >= 298 ? 2 : 3));
          for (var i = _idx; i < _TRX_TIERS.length; i++) {
            var _cn = 'ovmb-trx' + (_TRX_TIERS[i] ? ' ' + _TRX_TIERS[i] : '');
            if (trxRow.className !== _cn) { trxRow.className = _cn; }
            if (trxRow.scrollWidth <= trxRow.clientWidth + 1 || i === _TRX_TIERS.length - 1) { break; }
          }
        } catch (_) { }
      });
    }
    try {
      if (window.ResizeObserver && layout && layout.main) {
        _trxRO = new ResizeObserver(function () { _fitTrxRow(); });
        _trxRO.observe(layout.main);
      }
    } catch (_) { }
    _fitTrxRow();

    // 键盘（空格/1/2/Q/W/Z/X/←→/↑↓/M/L/R/A/S/F——经 api.keys 由宿主全局 keydown 派发）
    function keys(e) {
      // ★ 输入框/可编辑目标内让路（倍速自定义输入——空格/数字/字母不得触发播放控制，2026-09-26 v2）
      var _tg = e.target;
      if (_tg && (_tg.tagName === 'INPUT' || _tg.tagName === 'TEXTAREA' || _tg.tagName === 'SELECT' || _tg.isContentEditable)) { return; }
      // ★ 交互元素让路（2026-09-28 q319）：焦点在按钮/链接上时（主窗口接管态下常见——刚点过工具栏/标签），
      //   空格/方向键仍是该控件的默认激活键——播放器禁抢（防「点完别的控件按空格 → 音乐莫名暂停/被劫持」）
      if (_tg && _tg.closest && _tg.closest('button,a,summary,label,[role="button"],[role="link"]')) { return; }
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      var k = e.key;
      if (k === ' ' || k === 'Spacebar') {
        e.preventDefault(); _togglePlay();
      } else if (k === 'ArrowLeft') {
        e.preventDefault(); _seekBy(-4);
      } else if (k === 'ArrowRight') {
        e.preventDefault(); _seekBy(4);
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        mEl.muted = false;
        _setVol(Math.round((_volWant + 0.05) * 100) / 100);
        _volTipShow(900);
      } else if (k === 'ArrowDown') {
        e.preventDefault();
        _setVol(Math.round((_volWant - 0.05) * 100) / 100);
        _volTipShow(900);
      } else if (k === 'm' || k === 'M') {
        mEl.muted = !mEl.muted;
      } else if (k === 'l' || k === 'L') {
        _cycleLoop();
      } else if (k === 'r' || k === 'R') {
        _toggleShuffle();
      } else if (k === 'a' || k === 'A') {
        _abCycle();
      } else if (isVid && (k === 's' || k === 'S')) {
        _ovShot();
      } else if ((k === 'f' || k === 'F') && isVid) {
        _toggleFs();
      } else if (k === '1') {
        _stepFrame(-1);
      } else if (k === '2') {
        _stepFrame(1);
      } else if (k === 'q' || k === 'Q') {
        _seekBy(-4);
      } else if (k === 'w' || k === 'W') {
        _seekBy(4);
      } else if (k === 'z' || k === 'Z') {
        _rateStep(-0.5);
      } else if (k === 'x' || k === 'X') {
        _rateStep(0.5);
      }
    }

    function cleanup() {
      try { _abStop(); } catch (_) { }
      // ★ 增压图卸载（2026-10-01 q319）：断开增益/源——防共享 ctx 经 destination 强引用链保活（节点泄漏）
      try { if (_volTipTimer) { clearTimeout(_volTipTimer); _volTipTimer = 0; } } catch (_) { }
      try { if (_boostGain) { _boostGain.disconnect(); _boostGain = null; } } catch (_) { }
      try { if (_boostSrc) { _boostSrc.disconnect(); _boostSrc = null; } } catch (_) { }
      try { if (_trxFitRaf) { cancelAnimationFrame(_trxFitRaf); _trxFitRaf = 0; } } catch (_) { }
      try { if (_trxRO) { _trxRO.disconnect(); _trxRO = null; } } catch (_) { }
      try { _closeRatePanel(); } catch (_) { }
      try { _closeModePanel(); } catch (_) { }
      try { _plDragClear(); } catch (_) { }
      try { if (_vfcId) { mEl.cancelVideoFrameCallback(_vfcId); _vfcId = 0; } } catch (_) { }
      try { if (isVid) { document.removeEventListener('fullscreenchange', _onFsChange); } } catch (_) { }
      try { if (wrapEl && document.fullscreenElement === wrapEl) { document.exitFullscreen(); } } catch (_) { }
    }

    // ★ 播放列表协作者接口（2026-09-26 q319）：外部切轨后刷新位置计数；A-B 状态切轨即清零（时间点无跨文件意义）
    function setTrack(n) {
      if (api) { api.idx = n; }
      if (posT) { posT.textContent = (n + 1) + '/' + (api ? api.n : 1); }
      _syncPl();
      _persistTick();
    }
    function resetAB() { _abA = null; _abB = null; _abStop(); _abRender(); }

    // 初始同步
    syncPlay(); syncVol(); syncProg(); syncRate(); syncMode(); _abRender(); _refreshEscapeHook();
    _buildDock();       // dock 一次性构建（挂入壳层行；显隐由 onListChanged 管）
    onListChanged();    // 初始显隐/行渲染（n>1 → dock 立即可见）

    return { bar: stack, cleanup: cleanup, keys: keys, esc: function () { try { return _engEscHook ? !!_engEscHook() : false; } catch (_) { return false; } }, setTrack: setTrack, resetAB: resetAB, onListChanged: onListChanged, syncPlay: syncPlay, setVol: _setVol, getVol: function () { return _volWant; } };
  }



// ═════════ mount：挂载一个播放器实例（DOM + 播放列表机器 + 生命周期） ═════════
function mount(opts) {
  opts = opts || {};
  try { _ensureMediaCss(); } catch (_) { }
  var H = opts.host || HOST || {};   // ★ v5：宿主可由 mount 显式传入（同页多宿主共存——悬浮层 + 窗内播放器卡）
  var _i = function (k, fb, prm) { return _ifor(H, k, fb, prm); };
  var _toast = function (m, o) { _toastFor(H, m, o); };
  var _closeHost = function () { _closeHostFor(H); };
  var _reopenHost = function (p) { _reopenHostFor(H, p); };
  var _persistTick = function () { _persistTickFor(H); };
  var _cont = opts.container || H.rootEl || document.body;
  var _isVid = opts.mode !== 'audio';
  var _autoPlay = opts.autoplay !== false;
  var _startTime = opts.startTime || 0;
  // 初值覆盖（播放器窗持久化恢复；悬浮层默认不传 = 保持会话粘性）
  var _init = opts.initial || {};
  if (typeof _init.rate === 'number' && isFinite(_init.rate)) { _ovMediaRate = Math.round(Math.max(0.0625, Math.min(16, _init.rate)) * 100) / 100; }
  if (_init.loop === 'off' || _init.loop === 'all' || _init.loop === 'one') { _ovMediaLoop = _init.loop; }
  if (typeof _init.shuffle === 'boolean') { _ovMediaShuffle = _init.shuffle; }
  if (_init.dockSide === 'left' || _init.dockSide === 'right') { _ovDockSide = _init.dockSide; }
  // 播放列表上下文（单文件也建列表——统一机器；多文件全新打开 → 列表循环 + 随机关）
  var _plList = (opts.list && opts.list.length) ? opts.list.slice() : null;
  if (!_plList || !_plList.length) {
    _plList = [{ src: opts.src || '', localPath: opts.localPath || _localPathFromSrc(opts.src) || null, name: opts.name || String(opts.localPath || '').split(/[\\/]/).pop() || '' }];
  }
  var _plN = _plList.length;
  var _plIdx = (typeof opts.index === 'number' && opts.index >= 0 && opts.index < _plN) ? opts.index : 0;
  var _actItem = _plList[_plIdx] || null;
  var _curLocalPath = (_actItem && _actItem.localPath) || opts.localPath || null;   // ★ v5 实例局部（同页多实例不串号）
  var _curShotBase = opts.shotBase || _curLocalPath;
  // ★ v6（2026-09-26 q319 用户实测）：显式初值（交接回灌——popOut ↗ / 退回 ↙）禁重置——「整体交接」语义含模式；
  //   仅全新多文件打开（无 initial.loop/shuffle）才强制 列表循环+随机关
  if (_plN > 1 && !opts.isTx && !(opts.initial && (opts.initial.loop !== undefined || typeof opts.initial.shuffle === 'boolean'))) { _ovMediaLoop = 'all'; _ovMediaShuffle = false; }
  _ovTxAbort();
  try { _cont.innerHTML = ''; } catch (_) { }

      // ★ v5 布局（2026-09-26 q319）：壳层行（shell）= 主列（媒体舞台 + 控制条） + 播放列表 dock（侧栏，n>1 恒显）
      var _shell = document.createElement('div');
      _shell.className = 'ovmb-shell';
      var _mainCol = document.createElement('div');
      _mainCol.className = 'ovmb-maincol';
      _shell.appendChild(_mainCol);
      _cont.appendChild(_shell);
      var _layout = { shell: _shell, main: _mainCol };
      var _mEl = document.createElement(_isVid ? 'video' : 'audio');
      _mEl.autoplay = true;
      _mEl.setAttribute('playsinline', '');
      // ★ 2026-09-26：弃用原生控件（⋮ 折叠菜单/系统语言/不可定制/不可加循环）→ 自建控制条 ovmb
      var _vWrap = null, _aBox = null, _aNameEl = null;
      if (_isVid) {
        _vWrap = _mainCol;
        _mEl.style.cssText = 'max-width:100%; max-height:100%; outline:none; ' +
          'border-radius:4px; background:#000; box-shadow:0 4px 32px rgba(0,0,0,0.4);';
        _vWrap.appendChild(_mEl);
      } else {
        // 音频：轻盒（音符 + 文件名 + 自建控制条）居中呈现
        _aBox = document.createElement('div');
        _aBox.style.cssText = 'position:relative; display:flex; flex-direction:column; align-items:center; gap:18px; ' +
          'background:rgba(0,0,0,0.45); border:1px solid rgba(255,255,255,0.12); border-radius:12px; ' +
          'padding:30px 24px; max-width:92%;';   // ★ 2026-10-01：盒放宽（80%→92% + 内边距 40→24）——给专属播放控制行留出单行空间（_fitTrxRow 公式同步）
        var _aGlyph = document.createElement('div');
        _aGlyph.textContent = '\u266A';
        _aGlyph.style.cssText = 'font-size:38px; line-height:1; color:#ffd301;';
        var _aName = document.createElement('div');
        _aNameEl = _aName;
        var _lp = String((_actItem && _actItem.localPath) || opts.localPath || '');
        _aName.textContent = (_actItem && _actItem.name) ? _actItem.name : (_lp ? _lp.split(/[\\/]/).pop() : '');
        _aName.style.cssText = 'color:#dcd8d0; font-size:15px; line-height:1.4; word-break:break-all; text-align:center; max-width:480px;';
        _mEl.style.cssText = 'position:absolute; width:0; height:0; opacity:0; pointer-events:none;';
        _aBox.appendChild(_aGlyph);
        _aBox.appendChild(_aName);
        _aBox.appendChild(_mEl);
        _mainCol.appendChild(_aBox);
      }
      // ★ 自建控制条挂载（视频 = 主列底部浮层；音频 = 轻盒内联）——api 携播放列表上下文（多轨出 ⏮/⏭ + n/N 计数 + dock 边）
      var _plApi = { n: _plN, idx: _plIdx, onEnded: null, onPrev: null, onNext: null, list: _plList, jump: null, onModeChange: null, getState: null, getBase: null, dockSide: (_init.dockSide === 'left' || _init.dockSide === 'right') ? _init.dockSide : (_ovDockSide || 'right') };
      var _barApi = _ovBuildMediaBar(_mEl, _isVid, _shell, _plApi, _layout, H);   // 全屏目标 = 壳层行（dock 随全屏保留）
      (_vWrap || _aBox).appendChild(_barApi.bar);

  // ★ 开局暂停语义（播放器窗恢复场景）：元素 autoplay 属性会被 src 赋值旁路触发 → 显式关掉
  if (!_autoPlay) { try { _mEl.autoplay = false; } catch (_) { } }
  // 音量/静音初值（恢复场景；★ 2026-10-01：volume 支持 >1——经增压机器还原，≤1 与历史零差异）
  if (typeof _init.volume === 'number') { try { _barApi.setVol(_init.volume, true); } catch (_) { } }
  if (typeof _init.muted === 'boolean') { try { _mEl.muted = _init.muted; } catch (_) { } }

      var _txKind = _isVid ? 'video' : 'audio';
      var _txTried = !!opts.isTx;
      var _metaOk = false;
      var _fallTimer = 0;
      var _plSkipLeft = _plN;   // 列表：单轨彻底失败 → 跳下一轨（全轮试完才关播放器）
      function _curLocal() { return _plList ? ((_plList[_plIdx] && _plList[_plIdx].localPath) || null) : _curLocalPath; }
      var _ovMediaFail = function () {
        if (_plList && _plSkipLeft > 1) {
          _plSkipLeft--;
          var _bad = _plList[_plIdx];
          _toast(_i('shell.overlay.mskip', '无法播放，已跳过：{name}', { name: (_bad && _bad.name) || '' }), 'error');
          _advanceTo((_plIdx + 1) % _plN, true);
          return;
        }
        _toast(_i('shell.overlay.mediaFailed', '媒体加载失败，可能格式不受支持或文件已损坏'), 'error');
        try { _closeHost(); } catch (_) { }
      };
      var _ovMediaTx = function () {
        var _file = _curLocal();
        if (_txTried || !_file) { _ovMediaFail(); return; }
          _txTried = true;
        _ovTxRun(_file, _txKind, function (newPath) {
          _reopenHost({ mode: _txKind, src: 'file:///' + newPath, localPath: newPath, list: _plList, index: _plIdx });
        }, _ovMediaFail, H);     };
      // ★ 播放意图显式化（2026-09-28 q319 修复「切歌即暂停/列表循环停摆/按钮态错乱」）：wantPlay 由动作语义传入
      //   —— mount 期冻结的 _autoPlay 只决定「首载」（恢复场景安静启动）；此后一切切轨（点击列表/⏮⏭/播完进位/
      //   跳过坏轨/追加起播）恒续播。图标对齐：Chromium 重设 src 打断播放只发 abort/emptied、不发 pause（探针实锤）
      //   ——每次装载后必须显式 syncPlay()（读元素真值），否则按钮图标永远停在旧态；wantPlay=false 时显式 pause()
      //   保证暂停态落定（幂等无害）。
      function _loadNative(src, isTx, wantPlay) {
        _metaOk = false;
        if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; }
        _mEl.src = src;
        if (wantPlay) {
          try { var _p = _mEl.play(); if (_p && _p.catch) { _p.catch(function () { }); } } catch (_) { }
        } else {
          try { _mEl.pause(); } catch (_) { }
        }
        try { if (_barApi.syncPlay) { _barApi.syncPlay(); } } catch (_) { }
        _persistTick();
        if (!isTx) {
          // 静默卡死兜底：8s 无元数据也无 error → 走转码
          _fallTimer = setTimeout(function () {
            if (!_metaOk) {
              try { _mEl.removeAttribute('src'); _mEl.load(); } catch (_) { }
              _ovMediaTx();
            }
          }, 8000);
        }
      }
      function _replayCur() {
        try { _mEl.currentTime = 0; } catch (_) { }
        try { var _p2 = _mEl.play(); if (_p2 && _p2.catch) { _p2.catch(function () { }); } } catch (_) { }
      }
      // ═══ ★ 随机袋（v2）：随机 = 独立维度——袋 = 本轮未播索引；空袋 + 循环开 = 重洗续播 / 空袋 + 循环关 = 播完停（随机单次）═══
      var _plBag = {};
      function _bagReset() {
        _plBag = {};
        for (var _bi = 0; _bi < _plN; _bi++) { if (_bi !== _plIdx) { _plBag[_bi] = 1; } }
      }
      function _bagPick() {
        var _cand = [];
        for (var _bk in _plBag) { _cand.push(+_bk); }
        return _cand.length ? _cand[Math.floor(Math.random() * _cand.length)] : null;
      }
      function _shuffleNext(manual) {
        var _k = _bagPick();
        if (_k === null && (_ovMediaLoop === 'all' || manual)) { _bagReset(); _k = _bagPick(); }   // 空袋：循环开→重洗；手动 ⏭→必进
        if (_k === null) { return false; }
        _advanceTo(_k, true);
        return true;
      }
      if (_plList && _ovMediaShuffle) { _bagReset(); }
      // 切轨：本地路径/截图基准/文件名/位置计数/A-B 全量对齐该轨（A-B 时间点无跨文件意义 → 切轨即清零）
      function _advanceTo(k, wantPlay) {
        _ovTxAbort();
        _plIdx = k;
        delete _plBag[k];
        _txTried = false;
        var it = _plList[_plIdx];
        _curLocalPath = it.localPath || null;
        _curShotBase = it.localPath || null;
        if (_aNameEl) { _aNameEl.textContent = it.name || String(it.localPath || '').split(/[\\/]/).pop(); }
        if (_barApi.setTrack) { _barApi.setTrack(k); }
        if (_barApi.resetAB) { _barApi.resetAB(); }
        if (_OV_TX_FIRST_EXTS[_ovTxExt(it.localPath || it.src)]) { _ovMediaTx(); return; }
        _loadNative(it.src, false, !!wantPlay);
      }
      // 模式裁决（ended 后；A-B 已由控制条先行拦截）——循环 × 随机 两独立维度
      function _plOnEnded() {
        if (_ovMediaLoop === 'one') { _replayCur(); return; }             // 单曲循环（含单文件）
        if (!_plList || _plN < 2) {                                        // 单文件：循环关=播完停；循环开（列表/单曲同效）=重播
          if (_ovMediaLoop !== 'off') { _replayCur(); }
          return;
        }
        if (_ovMediaShuffle) { _shuffleNext(false); return; }              // 随机：袋中取未播（空袋 → 循环开重洗 / 循环关播完停）
        if (_plIdx < _plN - 1) { _advanceTo(_plIdx + 1, true); return; }    // 顺序下一轨（播完进位恒续播）
        if (_ovMediaLoop === 'all') { _advanceTo(0, true); }                // 尾接首
      }
      function _plPrev() { if (_plList && _plN > 1) { _advanceTo((_plIdx - 1 + _plN) % _plN, true); } }
      function _plNext() {
        if (!_plList || _plN < 2) { return; }                              // 单轨（含移除缩到 1）→ 无跳轨语义
        if (_ovMediaShuffle && _plN > 1) { _shuffleNext(true); return; }   // 随机下手动 ⏭：袋中取（空袋必进）
        _advanceTo((_plIdx + 1) % _plN, true);
      }
      _plApi.onEnded = _plOnEnded; _plApi.onPrev = _plPrev; _plApi.onNext = _plNext;
      _plApi.jump = function (k) {                                        // 列表点击切轨（当前轨零动作）
        if (!_plList || typeof k !== 'number' || k < 0 || k >= _plN || k === _plIdx) { return; }
        _advanceTo(k, true);                                              // 点击选曲 = 明确播放意图（选曲即播，万向播放器语义）
      };
      _plApi.onModeChange = function (dim) {                              // 随机开启 → 袋按当前轨重建
        if (dim === 'shuffle' && _ovMediaShuffle && _plList) { _bagReset(); }
      };
      // ═══ ★ 列表行操作（2026-09-26 q319 v3）：拖动/箭头重排 + 单行移除——重排不打断播放（当前轨索引跟随）；
      //   移除当前轨 → 原位接播切片后同索引（末位回落新末位）；空列表 → 关悬浮层；随机袋按新列表卫生化 ═══
      function _plBagSanitize() {
        for (var _bk in _plBag) { if (+_bk >= _plN || +_bk === _plIdx) { delete _plBag[_bk]; } }
      }
      _plApi.move = function (from, to) {
        if (!_plList || typeof from !== 'number' || typeof to !== 'number') { return; }
        var _n = _plList.length;
        if (from < 0 || from >= _n) { return; }
        to = Math.max(0, Math.min(_n - 1, to));
        if (from === to) { return; }
        var _it = _plList.splice(from, 1)[0];
        _plList.splice(to, 0, _it);
        if (_plIdx === from) { _plIdx = to; }
        else if (from < _plIdx && to >= _plIdx) { _plIdx--; }
        else if (from > _plIdx && to <= _plIdx) { _plIdx++; }
        _plApi.idx = _plIdx;
        _plBagSanitize();
        _persistTick();
      };
      _plApi.remove = function (i) {
        if (!_plList || typeof i !== 'number' || i < 0 || i >= _plList.length) { return; }
        if (i === _plIdx) {                                     // 移除当前轨 → 原位接播（切片后同索引 = 下一轨；末位 → 新末位）
          var _wasPlaying = false;
          try { _wasPlaying = !_mEl.paused && !_mEl.ended; } catch (_) { }
          _plList.splice(i, 1);
          _plN = _plList.length; _plApi.n = _plN;
          if (_plN === 0) { try { _closeHost(); } catch (_) { } return; }
          _plSkipLeft = Math.min(_plSkipLeft, _plN);
          _plBagSanitize();
          _advanceTo(Math.min(i, _plN - 1), _wasPlaying);       // 播放态跟随：在播 → 接播；暂停 → 保持暂停
          return;
        }
        _plList.splice(i, 1);
        _plN = _plList.length; _plApi.n = _plN;
        if (i < _plIdx) { _plIdx--; _plApi.idx = _plIdx; }
        _plSkipLeft = Math.min(_plSkipLeft, _plN);
        _plBagSanitize();
        _persistTick();
      };
      _mEl.addEventListener('error', function () { _ovMediaTx(); });
      _mEl.addEventListener('loadedmetadata', function () {
        _metaOk = true;
        _plSkipLeft = _plN;   // 成功轨 → 重置跳过预算
        if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; }
        if (_startTime > 0) { try { _mEl.currentTime = _startTime; } catch (_) { } _startTime = 0; }
      });

   // 播放状态上报（出声独占 claim 的触发源）+ 音量变更持久化
  _mEl.addEventListener('play', function () { try { if (H.onPlayState) { H.onPlayState(true); } } catch (_) { } });
  _mEl.addEventListener('pause', function () { try { if (H.onPlayState) { H.onPlayState(false); } } catch (_) { } });
  _mEl.addEventListener('volumechange', function () { _persistTick(); });

  // 初始加载（wantPlay 恒 = _autoPlay：恢复场景安静启动；此后切轨由动作语义驱动）：
  // _tx 产物直载 / 首发命中转码组直接转码（状态条进度）/ 否则原生 + 静默卡死兜底
  if (opts.isTx) {
    _loadNative(opts.src, true, _autoPlay);
  } else if (_OV_TX_FIRST_EXTS[_ovTxExt((_actItem && _actItem.localPath) || _curLocalPath || _localPathFromSrc(opts.src) || opts.src)]) {
    _ovMediaTx();
  } else {
    _loadNative(opts.src || ((_actItem && _actItem.src) || ''), false, _autoPlay);
  }

  var _api = {
    keys: _barApi.keys,
    esc: _barApi.esc,
    destroy: function () {
      try { if (_fallTimer) { clearTimeout(_fallTimer); _fallTimer = 0; } } catch (_) { }
      try { _barApi.cleanup(); } catch (_) { }
      try { _mEl.pause(); _mEl.removeAttribute('src'); _mEl.load(); } catch (_) { }
      try { if (H.onPlayState) { H.onPlayState(false); } } catch (_) { }
    },
    // ★ 三入口（暂停/播放/开关）恒补 syncPlay（2026-09-28 q319）：读元素真值——claim 互斥暂停、工作台槽 ⏯ 后图标不落后
    pause: function () { try { _mEl.pause(); } catch (_) { } try { if (_barApi.syncPlay) { _barApi.syncPlay(); } } catch (_) { } },
    // ★ 工作台 Player 槽播控（2026-09-28 q319 v7）：收纳后控制条不可见——槽位 [⏮][⏯][⏭] 唯一播控入口
    play: function () { try { _mEl.play(); } catch (_) { } try { if (_barApi.syncPlay) { _barApi.syncPlay(); } } catch (_) { } },
    toggle: function () { try { if (_mEl.paused) { _mEl.play(); } else { _mEl.pause(); } } catch (_) { } try { if (_barApi.syncPlay) { _barApi.syncPlay(); } } catch (_) { } },
    prev: function () { try { if (_plApi.onPrev) { _plApi.onPrev(); } } catch (_) { } },
    next: function () { try { if (_plApi.onNext) { _plApi.onNext(); } } catch (_) { } },
    isPlaying: function () { try { return !_mEl.paused && !_mEl.ended; } catch (_) { return false; } },
    append: function (items, autoplay) {
      if (!items || !items.length) { return 0; }
      var wasIdle = true;
      try { wasIdle = !!_mEl.paused; } catch (_) { }
      var firstNew = _plList.length;
      for (var i = 0; i < items.length; i++) { if (items[i]) { _plList.push(items[i]); } }
      var added = _plList.length - firstNew;
      _plN = _plList.length; _plApi.n = _plN;
      try { _barApi.onListChanged(); } catch (_) { }
      _persistTick();
      if (wasIdle && autoplay !== false && added > 0) { _advanceTo(firstNew, true); }
      return added;
    },
    getState: function () {
      return {
        mode: _isVid ? 'video' : 'audio',
        list: _plList, index: _plIdx,
        src: _mEl.src || '',
        localPath: (_plList[_plIdx] && _plList[_plIdx].localPath) || _curLocalPath || null,
        time: _mEl.currentTime || 0, paused: !!_mEl.paused,
        volume: _barApi.getVol(), muted: !!_mEl.muted,
        rate: _ovMediaRate, loop: _ovMediaLoop, shuffle: _ovMediaShuffle,
        dockSide: _ovDockSide || 'right'
      };
    }
  };
  _plApi.getState = function () { return _api.getState(); };   // ↗ / ⧈ 交接取整机状态（实例级——同页多实例不串号）
  _plApi.getBase = function () { return _curShotBase || _curLocalPath || ''; };
  return _api;
}

var API = {
  mount: mount,
  txRun: _ovTxRun,
  txAbort: _ovTxAbort,
  extOf: _ovTxExt,
  kindOf: function (p) { var e = _ovTxExt(p); return _AUDIO_EXTS[e] ? 'audio' : 'video'; }
};
window.QQQMediaEngine = {
  version: '1.2',
  configure: function (host) { HOST = host || {}; _ensureMediaCss(); return API; },
  api: API   // 显式宿主直通（同页多宿主——窗内播放器卡用 api.mount({host})，不碰全局 configure）
};
})();
