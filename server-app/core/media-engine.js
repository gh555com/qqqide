// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
//   media-engine.js — 共享媒体引擎（2026-09-26 q319 v5 · 从 shell-overlay.js 抽取）
//   ★ 2026-10-02 单宿主大整改：唯一宿主 = 独立播放器窗（player/player.html，Roam Q 直开、从不复用）；
//   悬浮层/窗内卡/状态栏豆腐块全部废除；悬浮层仅借用转码工具（txRun/extOf——open-image 的 psd/tif 直转码）。
//   禁第二套实现（防漂移）——一切媒体行为（转码兜底/自建控制条/播放列表/A-B/倍速/逐帧/截图/键盘）
//   只在本文修改。★ 宿主注入 = configure(host)（全局兜底）/ mount({host})（逐实例）。
//     host = { bridge, rootEl, i18n(k,fb,params), toast(msg,opts), onClose(), reopen(payload),
//              reveal(path), getLastDir(), onPlayState(playing), onState(), savePref(k,v)? }
//   ★ 2026-10-02 单宿主大整改：popOut/popIn/stow 宿主能力位已整体删除（唯一宿主 = 播放器窗，不再有跨宿主交接）。
//   ★ 播放列表 = 右侧常驻 dock（非弹出面板）：恒显（含单曲——播放列表一直带着）、停靠边恒右、满高拉伸自顶排列（行从最上方打起）；列表头 = 标题 + 随机开关（计数左侧；固定绘制 + 右下角 ✓）+ 计数。
//   mount(opts) → { keys, keysUp, esc(), destroy(), pause(), isPlaying(), append(items,autoplay), getState() }
//     opts = { container, mode:'video'|'audio', src, localPath, shotBase, name, list, index, host,
//              isTx, autoplay, startTime, initial:{rate,loop,shuffle,volume,muted,dockSide} }
// ============================================================================
(function () {
  'use strict';
  var HOST = null;          // 默认宿主（configure 注入；悬浮层/播放器窗各用各的上下文）
  var _ovDockSide = 'right';   // 播放列表 dock 位置（恒右——2026-10-02 定案；旧 ⇄ 切边/左停靠分支已整体删除）
  var _AUDIO_EXTS = { '.mp3': 1, '.wav': 1, '.flac': 1, '.m4a': 1, '.aac': 1, '.ogg': 1, '.oga': 1, '.opus': 1, '.weba': 1, '.wma': 1, '.aiff': 1, '.aif': 1, '.ape': 1, '.ac3': 1, '.mka': 1, '.amr': 1, '.au': 1 };

  var _ovMediaCss =     // ★ 窄宽换行（v6，2026-09-26 q319 用户实测）：播放器窗偏窄时控制条尾部按钮（音量滑杆/倍速/模式/A-B）落在 maincol 外被 overflow 裁掉
    //   ——实测 600px 窗裁 4 个 / 460px 裁 5 个 / 视频 640px 裁 6 个（「功能键都没了」实锤）；flex-wrap 换行 = 任何宽度零静默裁切（宽窗零变化）
    '.ovmb{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);z-index:5;display:flex;align-items:center;justify-content:center;gap:4px;row-gap:6px;flex-wrap:wrap;' +
    'padding:7px 10px;border-radius:12px;background:rgba(15,15,15,0.84);border:1px solid rgba(255,255,255,0.14);' +
    'box-shadow:0 6px 24px rgba(0,0,0,0.45);user-select:none;font-family:system-ui,-apple-system,sans-serif;' +
    'width:min(760px,94%);box-sizing:border-box}' +
    // ★ v15 布局（2026-10-02 q319 用户定案）：根列 = 进度行（顶部整行：时间-滑条-时间；进度条一切按钮迁出）+ 壳层行；
    //   控制栈恒为舞台底部浮层（按钮覆于播放画面之上——视频与音频同规，轻盒内联已废）
    '.ovmb-rootcol{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0}' +
    '.ovmb-progrow{display:flex;align-items:center;gap:10px;flex:0 0 auto;height:30px;padding:0 12px;box-sizing:border-box;background:rgba(255,255,255,0.035);border-bottom:1px solid rgba(255,255,255,0.07);user-select:none}' +
    '.ovmb-progrow .ovmb-seek{height:100%}' +
    '.ovmb-scrim{position:absolute;left:0;right:0;bottom:0;height:170px;pointer-events:none;z-index:4;background:linear-gradient(to top, rgba(0,0,0,0.5), rgba(0,0,0,0))}' +
    // ★ 播放列表 dock（2026-10-02 q319 定案）：恒显于右侧（含单曲）——满高拉伸自顶排列（行从最上方打起；旧「n≤1 隐藏 / 竖直居中 / 左停靠」整体删除）
    // ★ v6 宽度契约（2026-09-26 用户实测）：旧 150px 下限 → 歌名可见宽仅 10~28px 全截断（「歌名完全看不到」实锤）；
    //   190/38%/300 + 行内空间收窄（padding 3 · gap 5 · mk 9 · idx 12）= 歌名可读；禁改回小下限
    '.ovmb-shell{display:flex;flex:1 1 auto;width:100%;min-width:0;min-height:0}' +
    '.ovmb-maincol{flex:1 1 auto;min-width:0;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
    '.ovmb-abox{position:relative;flex:1 1 auto;align-self:stretch;margin:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:24px 24px 104px;min-height:0;min-width:0;box-sizing:border-box}' +
    '.ovmb-dock{flex:0 0 auto;align-self:stretch;width:clamp(190px,38%,300px);display:none;flex-direction:column;margin:0 12px;box-sizing:border-box;' +
    'background:rgba(16,16,16,0.86);border:1px solid rgba(255,255,255,0.14);border-radius:11px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,0.35)}' +
    '.ovmb-dhead{display:flex;align-items:center;gap:6px;padding:1px 2px 7px;flex:0 0 auto}' +
    '.ovmb-dcnt{font-size:11px;color:#a8a49b;flex:0 0 auto}' +
    // ★ 列表头循环/随机双开关（2026-10-02 q319 用户定案）：位置 = 计数左侧（循环在随机左）；固定绘制（glyph 恒原样——按钮本体零颜色变化）
    //   + 右下角 ✓ 角标（pin 同款；仅此角标区分开/关）——循环/随机唯一 UI（模式弹层整体已删）。通用类 ovmb-dsw（两开关共用）
    '.ovmb-dsw{position:relative;display:flex;align-items:center;justify-content:center;width:22px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;color:#a8a49b;outline:none;flex:0 0 auto;transition:background .1s,color .1s}' +
    '.ovmb-dsw:hover{background:rgba(255,255,255,0.14);color:#fff}' +
    '.ovmb-dsw svg{display:block;width:14px;height:14px;pointer-events:none}' +
    '.ovmb-dswck{position:absolute;right:-2px;bottom:-3px;font-size:9px;font-weight:700;line-height:1;color:#ffd301;display:none;text-shadow:0 0 2px rgba(0,0,0,.85);pointer-events:none}' +
    '.ovmb-dsw.ovmb-dsw-on .ovmb-dswck{display:block}' +
    // ★ 2026-10-02 q319 v14：dock 头部导航组（标题「播放列表」废除）——[< P][◎追踪][N >] 三按钮；
    //   N/P = 纯文字（Tahoma 非加粗·大写·金色=快捷键标注——N/P 亦是真快捷键）；< > = 纯文字箭头恒中性色（color:inherit——禁发金/禁 SVG 三角/字母图标）
    '.ovmb-dnav{flex:1 1 auto;display:flex;align-items:center;gap:4px;min-width:0}' +
    '.ovmb-dnp{display:flex;align-items:center;justify-content:center;gap:2px;height:18px;padding:0 5px;border:none;border-radius:4px;background:transparent;color:#a8a49b;outline:none;flex:0 0 auto;transition:background .1s}' +
    '.ovmb-dnp:hover{background:rgba(255,255,255,0.14)}' +
    '.ovmb-dnp:disabled{opacity:.35;background:transparent}' +
    '.ovmb-npl{font-family:Tahoma,Verdana,sans-serif;font-weight:400;font-size:14px;line-height:1;color:#ffd301}' +
    '.ovmb-chev{font-family:Tahoma,Verdana,sans-serif;font-weight:400;font-size:13px;line-height:1;color:inherit}' +

    // ★ 可见边界（2026-10-01 q319 用户定案）：底部条按钮恒浅边框 + 淡底色——点选范围一眼可见（禁回 border:none 透明底）
    '.ovmb-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,0.16);box-sizing:border-box;' +
    'border-radius:7px;background:rgba(255,255,255,0.05);color:#e8e6e0;flex:0 0 auto;outline:none;transition:background .12s,border-color .12s}' +
    '.ovmb-btn:hover{background:rgba(255,255,255,0.14);border-color:rgba(255,255,255,0.28)}' +
    '.ovmb-btn.ovmb-on{color:#ffd301;background:rgba(255,211,1,0.16);border-color:rgba(255,211,1,0.5)}' +
    '.ovmb-rate{width:auto;min-width:42px;padding:0 6px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}' +
    '.ovmb-time{font-size:12px;color:#cfcbc2;flex:0 0 auto;font-variant-numeric:tabular-nums;text-align:center;min-width:36px}' +
    '.ovmb-seek{position:relative;flex:1 1 auto;height:20px;display:flex;align-items:center;min-width:50px}' +
    // ★ 进度条直角（2026-10-02 q319 用户定案）：轨道/填充零圆角（旧 2px 药丸端废除）；圆点手柄保留（hover 拖拽抓取点）
    '.ovmb-seek-track{position:absolute;left:0;right:0;height:4px;border-radius:0;background:rgba(255,255,255,0.22)}' +
    '.ovmb-seek-fill{height:100%;width:0%;background:#ffd301;border-radius:0}' +
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
    // ★ v9（2026-10-02 q319 用户定案）：动作提示浮读（跳秒/逐帧/倍速——按住连按实时刷新；同刻恒一枚，连按只刷新不堆积）
    '.ovmb-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);z-index:12;pointer-events:none;' +
    'padding:6px 14px;border-radius:9px;background:rgba(15,15,15,0.88);border:1px solid rgba(255,255,255,0.22);color:#f2efe8;' +
    'font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:0;transition:opacity .14s,transform .14s;' +
    'box-shadow:0 6px 22px rgba(0,0,0,0.5);user-select:none}' +
    '.ovmb-hint.ovmb-hon{opacity:1;transform:translate(-50%,-50%) scale(1)}' +
    '.ovmb-rootcol:fullscreen{width:100%;height:100%;max-width:none;max-height:none;background:#000}' +
    '.ovmb-rootcol:fullscreen video{max-width:100vw;max-height:100vh}' +
    '.ovmb-ratehost{position:relative;display:flex;flex:0 0 auto}' +
    '.ovmb-pos{font-size:11px;color:#b9b5ac;flex:0 0 auto;font-variant-numeric:tabular-nums;padding:0 2px;white-space:nowrap}' +
    // ★ 播放列表 dock 列表容器（2026-09-26 v5）：弹性吃满 dock 高度 + 内部滚动；当前轨金色高亮
    // ★ 播放列表滚动块 = qh 滚动真理机器接入（2026-10-02 q319 用户定案）：隐形滑轨（零轨道绘制，仅 8px 透明命中区）+
    //   常态 2px 无圆角细条（右距 6px——贴内容缘；原 5px 收半）/ hover 变粗贴边（8px）/ 点击滑轨任意位置即跳 / 拖拽 / 滚轮转发；
    //   gutter 8px 预留（padding-right——行内容与行尾按钮永不与滑轨区重叠）；原生态滚动条隐藏；滚屏与滑轨为兄弟，同挂不滚父容器（ovmb-plwrap）
    '.ovmb-plwrap{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}' +
    '.ovmb-pllist{display:flex;flex-direction:column;gap:2px;overflow-y:auto;min-height:0;flex:1 1 auto;padding-right:8px;scrollbar-width:none}' +
    '.ovmb-pllist::-webkit-scrollbar{display:none;width:0;height:0}' +
    '.ovmb-plsb{position:absolute;right:0;top:0;bottom:0;width:8px;z-index:50;display:none}' +
    '.ovmb-plsb-thumb{position:absolute;right:6px;width:2px;min-height:24px;border-radius:0;background:rgba(150,150,150,0.5);' +
    'transition:width .1s ease,right .1s ease}' +
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
  // ★ 媒体类型判定唯一入口（2026-10-02）：扩展名 → 'audio'|'video'——跨类型切轨/转码 kind/宿主 mode 三处共用
  function _ovKindOf(p) { var e = _ovTxExt(p); return _AUDIO_EXTS[e] ? 'audio' : 'video'; }
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
  //   倍速 = 点击展开面板（0.5~4 预设单按钮网格 + 自定义倍速输入·确认/回车；非 1× 金色高亮）；
  //   循环 + 随机 = 列表头双开关（固定绘制 + 右下角 ✓ 角标 = 唯一状态信号；L 键切循环 / R 键切随机——唯一 UI，2026-10-02）；
  //   循环 = 二元（开 = 列表循环[单列表退化 = 重播] / 关 = 顺序播完停）——旧三态「关/列表循环/单曲循环」合并删除（列表恒显：单曲循环 ≡ 单列表循环）；倍速/循环/随机会话内粘性（重开下一个文件保持）；
  //   按钮 data-no-cd 跳过全局冷却护盾（准许连点）；会话清理经 _stopMedia 统一执行（close/切换全覆盖）。
  //   ★ v9（2026-10-02 q319 用户定案）：八合一按钮按住连按（450ms 后连发）+ 动作浮读（跳秒/逐帧/倍速——连按实时刷新、恒显当前倍速）；面板用词「自定义倍速」。
  var _OV_MEDIA_RATE_PRESETS = [0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4];   // 面板预设（每步一个按钮；2026-10-01 q319 用户定案：3.5× 移除、0.5~1 间增 0.75×）
  var _ovMediaRate = 1;         // 会话粘性（支持任意自定义值）
  // （逐帧帧率 _ovMediaFps / Esc 前置钩子 _engEscHook —— v5 下沉为控制条实例局部变量，同页多实例互不串号）
  // ★ 播放模式 v3（2026-10-02 q319 用户定案）：循环 = 二元开关（开 = 列表循环[单列表退化 = 重播] / 关 = 顺序播完停）
  //   —— 旧三态「关/列表循环/单曲循环」合并（列表恒显：单曲循环 ≡ 单列表循环，独立档位删除）；随机 = 并列独立维度（袋制）；
  //   两维任意组合（顺序单次 / 顺序循环 / 随机单次 / 随机循环）；会话粘性；多文件列表打开时重置为 循环=开 + 随机=关；存量 'one' 归一 'all'
  var _ovMediaLoop = 'off';       // 'off' | 'all'（二元；'one' 已废除）
  var _ovMediaShuffle = false;    // 随机维度（与循环并列）
var _ovMediaFollow = false;     // ★ 追踪（2026-10-02 v14）：开 = 切轨自动居中当前所播文件（含挂载即定位）；关（默认）= 列表永不自动滚（切轨/任何时候都不帮用户滚，列表恒停原位）
  function _ovLoopName(v) {
    return v === 'all' ? _i('shell.overlay.mOn', '开') : _i('shell.overlay.mOff', '关');
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
    // ★ 居中追踪按钮（2026-10-02 q319 v14 定案）：圆环 + 中心点（打靶感）——点击 = 当前所播文件跳转居中 + 追踪开关（右下角 ✓）
    bullseye: '<circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-width="2.1"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/>',
    // ★ 上一首/下一首（2026-10-02 q319 v14 定案）：整体迁入 dock 头部 = < P / N > 纯文字按钮（Tahoma 非加粗；N/P 金色=快捷键标注；< > 中性色）
    //   ——禁 SVG 三角/字母图标（底条两钮同步废除）
    shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
    shot: 'M9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z',
    pip: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
    fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z'
  };
  // ★ 专属播放控制行图标（v8 2026-10-01 q319 用户定案）：逐帧 = |◀/▶| 竖线+三角（纯色直角——竖线在外、尖角朝竖线；
  //   该 glyph = _OV_MEDIA_ICONS.prev/next——逐帧保留竖线款〔底条 上一首/下一首 已于 2026-10-02 迁入 dock 头部为纯文字按钮〕）；快退/进 = 双三角重叠；停止 = 实心方块（微圆角 rx=2——2026-10-02 用户定案）
  function _ovRawIcon(inner) {
    return '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" style="display:block;pointer-events:none">' + inner + '</svg>';
  }
  var _OV_TRX_ICONS = {
    seekB: '<path d="M16.5 4v12L8.5 10z"/><path d="M11.5 4v12L3.5 10z"/>',
    seekF: '<path d="M3.5 4v12L11.5 10z"/><path d="M8.5 4v12L16.5 10z"/>',
    stop: '<rect x="2.5" y="2.5" width="15" height="15" rx="2"/>'
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
    bar.className = 'ovmb';

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
    // ★ 循环/随机按钮已迁列表头双开关（2026-10-02 q319：底条循环钮 + 模式弹层整体删除——dock 头部恒显 = 唯一 UI）

    // ★ A-B 循环按钮（2026-09-26 q319）：三态循环——首点标 A → 次点标 B 起循（跳回 A）→ 再点清除；A/B 字各自金色指示状态
    var abB = document.createElement('button');
    abB.className = 'ovmb-btn ovmb-ab';
    abB.tabIndex = -1;
    abB.setAttribute('data-no-cd', '');
    abB.addEventListener('mousedown', function (e) { e.preventDefault(); });
    abB.innerHTML = '<span class="ovmb-aba">A</span>-<span class="ovmb-abb">B</span>';
    var pipB = null, fsB = null, shotB = null, posT = null;
    // ★ 位置计数（n/N）——仅底条保留；上一首/下一首按钮已迁 dock 头部（2026-10-02 v14：文字 < P / N > + N/P 真快捷键）
    {
      posT = document.createElement('span');
      posT.className = 'ovmb-pos';
      posT.textContent = (api.idx + 1) + '/' + api.n;
      if (!(api && api.n > 1)) { posT.style.display = 'none'; }
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
    // ★ 倍速面板（2026-09-26 v2 用户定案）：点击 [1×] 在按钮上方展开——0.5~4 预设单按钮网格（每步一个按钮）+ 自定义倍速（确认/回车任意值）
    var _panel = null, _panelDocFn = null;
    function _applyRate(v) {
      if (!isFinite(v)) { return; }
      v = Math.round(Math.max(0.0625, Math.min(16, v)) * 100) / 100;
      _ovMediaRate = v;
      mEl.playbackRate = v;
      mEl.defaultPlaybackRate = v;
      syncRate();
      _hintRate();   // ★ v9：倍速切换浮读（预设/自定义/Z·X 键/连按 同源——恒显当前倍速）
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

    // ★ 2026-10-02 v10：浮层面板开启期拖拽带让路——拖拽区（宿主头部条/播放区空背景）在 OS 层被当标题栏吞点击，
    //   面板开着时点它收不到任何 DOM 事件（「点面板外任何地方关闭」在拖拽带上失效）；html.ovmb-floatopen 让宿主 CSS
    //   把拖拽带临时降级 no-drag——开启即置位、关闭/Esc/外点即复位（宿主侧样式契约 = player.html）。
    function _setFloatOpen(on) {
      try {
        document.documentElement.classList.toggle('ovmb-floatopen', !!on);
        // ★ Chromium 拖拽区重算只在「property 元素增删」时发生（纯类切换不触发——探针实测）：
        //   换一枚零尺寸隐形探针（显式 no-drag）强制重算——拖拽带让路即时生效（开/关双向）。
        var _d = document.documentElement;
        var _old = document.getElementById('qqq-appregion-nudge');
        if (_old && _old.parentNode) { _old.parentNode.removeChild(_old); }
        var _m = document.createElement('span');
        _m.id = 'qqq-appregion-nudge';
        _m.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;-webkit-app-region:no-drag;';
        _d.appendChild(_m);
      } catch (_) { }
    }

    function _closeRatePanel() {
      if (_panelDocFn) { document.removeEventListener('pointerdown', _panelDocFn, true); _panelDocFn = null; }
      if (_panel && _panel.parentNode) { _panel.parentNode.removeChild(_panel); }
      _panel = null;
      _setFloatOpen(false);
      _refreshEscapeHook();
    }
    function _toggleRatePanel() {
      if (_panel) { _closeRatePanel(); return; }
      var pn = document.createElement('div');
      pn.className = 'ovmb-ratepanel';
      for (var ri = 0; ri < _OV_MEDIA_RATE_PRESETS.length; ri++) {
        var rb = document.createElement('button');
        rb.className = 'ovmb-rbtn' + (Math.abs(_OV_MEDIA_RATE_PRESETS[ri] - _ovMediaRate) < 0.001 ? ' ovmb-on' : '');
        rb.tabIndex = -1;
        rb.setAttribute('data-no-cd', '');
        rb.innerHTML = _ovRateHTML(_OV_MEDIA_RATE_PRESETS[ri]);
        rb.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 焦点卫生（面板按钮不留焦点）
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
      inp.placeholder = _i('shell.overlay.mspeedCustom', '自定义倍速');
      inp.setAttribute('data-no-cd', '');
      var okB = document.createElement('button');
      okB.className = 'ovmb-rok'; okB.tabIndex = -1;
      okB.setAttribute('data-no-cd', '');
      okB.textContent = _i('shell.overlay.mspeedOk', '确认');
      okB.addEventListener('mousedown', function (e) { e.preventDefault(); });
      okB.addEventListener('click', function () { _applyRate(parseFloat(inp.value)); _closeRatePanel(); });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); _applyRate(parseFloat(inp.value)); _closeRatePanel(); }
      });
      row.appendChild(inp); row.appendChild(okB);
      pn.appendChild(row);
      rateHost.appendChild(pn);
      _placeFloatPanel(pn, rateHost);
      _panel = pn;
      _setFloatOpen(true);
      _panelDocFn = function (e) { if (!rateHost.contains(e.target)) { _closeRatePanel(); } };
      document.addEventListener('pointerdown', _panelDocFn, true);
      _refreshEscapeHook();
      try { inp.focus(); } catch (_) { }
    }
    // ═══ ★ 循环/随机开关机器 v3（2026-10-02 q319 用户定案）：唯一 UI = 列表头双开关（底条循环钮 + 模式弹层整体删除）═══
    //   循环 = 二元（开/关）；随机 = 二元（开/关）；外观 = 固定绘制 + 右下角 ✓（按钮本体零颜色变化）——dock 未建时同步静默
    function _refreshEscapeHook() {
      _engEscHook = function () {
        if (_panel) { _closeRatePanel(); return true; }
        return false;
      };
    }
    function syncMode() {
      _syncLoopBtn();
      _syncShufBtn();
    }
    // 维度写入唯一收敛点（开关点击 / L·R 键共走）：写状态 → 刷新外观 → 通知外部（随机开启时重建随机袋）
    function _applyLoop(v) {
      _ovMediaLoop = (v === 'all') ? 'all' : 'off'; syncMode();
      _persistTick();
      if (api && api.onModeChange) { try { api.onModeChange('loop'); } catch (_) { } }
    }
    function _applyShuffle(v) {
      _ovMediaShuffle = !!v; syncMode();
      _persistTick();
      if (api && api.onModeChange) { try { api.onModeChange('shuffle'); } catch (_) { } }
    }
    function _cycleLoop() {
      _applyLoop(_ovMediaLoop === 'off' ? 'all' : 'off');
      _toast(_i('shell.overlay.mlooplab', '循环') + '：' + _ovLoopName(_ovMediaLoop));
    }
    function _toggleShuffle() {
      _applyShuffle(!_ovMediaShuffle);
      _toast(_i('shell.overlay.mshuflab', '随机') + '：' + _ovShufName(_ovMediaShuffle));
    }
    // ★ 列表头双开关同步（2026-10-02 q319）：右下角 ✓ 角标 = 唯一状态信号（固定绘制；按钮本体零颜色变化）
    function _syncLoopBtn() {
      if (!_dockLoopB) { return; }
      _dockLoopB.classList.toggle('ovmb-dsw-on', _ovMediaLoop !== 'off');
      _dockLoopB.title = _i('shell.overlay.mlooplab', '循环') + '：' + _ovLoopName(_ovMediaLoop) + ' (L)';
    }
    function _syncShufBtn() {
      if (!_dockShufB) { return; }
      _dockShufB.classList.toggle('ovmb-dsw-on', _ovMediaShuffle);
      _dockShufB.title = _i('shell.overlay.mshuflab', '随机') + '：' + _ovShufName(_ovMediaShuffle) + ' (R)';
    }
    // ★ 追踪机器（2026-10-02 v14 用户定案）：点打靶◎ = 当前所播文件跳转居中 + 追踪开关（右下角 ✓ = 开启）
    //   追踪开 = 此后一切切轨自动居中跟随（含挂载即定位）；关 = 不追踪、不帮用户滚（默认——列表恒停原位）
    function _toggleFollow() {
      _ovMediaFollow = !_ovMediaFollow;
      _syncFollowBtn();
      _persistTick();
      if (_ovMediaFollow) { _centerCurRow(); }
      _toast(_i('shell.overlay.mtrack', '追踪') + '：' + _ovShufName(_ovMediaFollow));
    }
    function _syncFollowBtn() {
      if (!_dockFollowB) { return; }
      _dockFollowB.classList.toggle('ovmb-dsw-on', _ovMediaFollow);
      _dockFollowB.title = _i('shell.overlay.mtrack', '追踪') + '：' + _ovShufName(_ovMediaFollow);
    }
    // ═══ ★ 播放列表 → 右侧常驻 dock（2026-10-02 q319 定案）：恒显（含单曲）、恒右、满高自顶排列（行从最上方打起）；═══
    //   序号 + 文件名 + 行尾三钮（上移/下移/移除）；拖动 = 指针拖拽重排（阈值 5px，未达阈值零干扰）；
    //   当前轨 ▶ 金色高亮；默认永不自动滚（列表恒停原位——2026-10-02 v14；仅追踪开启时居中跟随）；点击任意行切轨（拖动余波点击自动抑制）。
    var dockEl = null, _plListEl = null, _dockCntEl = null, _dockLoopB = null, _dockShufB = null, _dockPrevB = null, _dockFollowB = null, _dockNextB = null;
    var _dockSide = 'right';   // 停靠边恒右（2026-10-02 定案）
    var _plDrag = { from: -1, on: false, y0: 0, j: -1, after: false, el: null };
    var _plDragEndAt = 0;   // 拖动收尾余波点击抑制（<400ms 内行点击忽略）
    // ★ 居中机器（2026-10-02 v14）：把行滚到列表可视区正中（恒只滚列表自身——禁挪外部容器；浏览器自动夹边界）
    function _centerDockRow(rowEl) {
      try {
        var _le = _plListEl;
        if (!_le || !rowEl) { return; }
        var _lr = _le.getBoundingClientRect(), _rr = rowEl.getBoundingClientRect();
        _le.scrollTop += Math.round((_rr.top - _lr.top) - (_le.clientHeight - _rr.height) / 2);
      } catch (_) { }
    }
    function _centerCurRow() {
      if (!_plListEl || !api) { return; }
      var rows = _plListEl.querySelectorAll('.ovmb-prowwrap');
      if (rows[api.idx || 0]) { _centerDockRow(rows[api.idx || 0]); }
    }
    function _syncPl() {
      if (!_plListEl || !api || !api.list) { return; }
      var rows = _plListEl.querySelectorAll('.ovmb-prowwrap');
      var cur = api.idx || 0;
      for (var pi = 0; pi < rows.length; pi++) {
        var isCur = (pi === cur);
        rows[pi].classList.toggle('ovmb-cur', isCur);
        var mk = rows[pi].querySelector('.ovmb-pmark');
        if (mk) { mk.textContent = isCur ? '\u25B6' : ''; }
        // ★ 2026-10-02 v14 定案：默认永不自动滚（列表恒停原位——切轨/任何时候都不帮用户滚，旧「滚入视野」已删）；
        //   仅追踪开启时把当前所播文件居中（切轨跟随 + 挂载即定位）
        if (isCur && _ovMediaFollow) { _centerDockRow(rows[pi]); }
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
    // 行操作执行：外部列表变更（api.move/api.remove）→ dock 行重建 + 计数/高亮对齐（dock 恒显；移除最后一轨由 api.remove 关宿主）
    function _plRowOp(op, idx) {
      if (!api || !api.list) { return; }
      if (op === 'up' && api.move) { api.move(idx, idx - 1); }
      else if (op === 'down' && api.move) { api.move(idx, idx + 1); }
      else if (op === 'del' && api.remove) { api.remove(idx); }
      onListChanged();
    }
    function onListChanged() {
      var many = !!(api && api.n > 1);
      // ★ dock 头部 N/P（2026-10-02 v14）：单轨禁用（位移语义消失）——恒显不留布局跳变
      if (_dockPrevB) { _dockPrevB.disabled = !many; }
      if (_dockNextB) { _dockNextB.disabled = !many; }
      if (posT) {
        posT.style.display = many ? '' : 'none';
        if (api) { posT.textContent = ((api.idx || 0) + 1) + '/' + api.n; }
      }
      if (dockEl) {
        dockEl.style.display = 'flex';   // ★ 恒显（含单曲——播放列表一直带着；2026-10-02 用户定案）
        if (_dockCntEl) { _dockCntEl.textContent = String((api && api.n) || 0); }
      }
      try { _plDragClear(); } catch (_) { }
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
    //   停靠边恒右（2026-10-02 定案）：dock 恒挂壳层行尾（主列之后）——旧 left 分支 + ⇄ 切边已整体删除
    function _applyDockSide() {
      _dockSide = 'right';
      try {
        if (dockEl && layout && layout.shell) { layout.shell.appendChild(dockEl); }
      } catch (_) { }
      _ovDockSide = 'right';
    }
    function _buildDock() {
      dockEl = document.createElement('div');
      dockEl.className = 'ovmb-dock';
      var head = document.createElement('div');
      head.className = 'ovmb-dhead';
      _dockCntEl = document.createElement('span');
      _dockCntEl.className = 'ovmb-dcnt';
      _dockCntEl.textContent = String(api ? api.n : 0);
      // ★ 2026-10-01 q319：列表头「⇄ 切边」按钮整体删除（用户判定无用）——停靠边随记忆保持，无手动入口
      // ★ 2026-10-02 q319：列表头循环/随机双开关（计数左侧：循环在随机左；固定绘制 + 右下角 ✓ 角标——pin 同款，按钮本体零颜色变化）
      function _dockSwBtn(glyph, title, fn) {
        var b = document.createElement('button');
        b.className = 'ovmb-dsw';
        b.tabIndex = -1;
        b.setAttribute('data-no-cd', '');
        b.title = title;
        b.innerHTML = _ovMediaIcon(glyph);
        var ck = document.createElement('span');
        ck.className = 'ovmb-dswck';
        ck.textContent = '\u2713';
        b.appendChild(ck);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 焦点卫生
        b.addEventListener('click', fn);
        return b;
      }
      _dockLoopB = _dockSwBtn(_OV_MEDIA_ICONS.repeat, _i('shell.overlay.mlooplab', '循环'), function () { _cycleLoop(); });      // 与 L 键同源
      _dockShufB = _dockSwBtn(_OV_MEDIA_ICONS.shuffle, _i('shell.overlay.mshuflab', '随机'), function () { _toggleShuffle(); });   // 与 R 键同源
      // ★ 2026-10-02 q319 v14：头部导航组（标题「播放列表」废除）——[< P] [◎追踪] [N >]
      //   N/P = 纯文字按钮（Tahoma 非加粗·大写·金色=快捷键标注——N/P 亦是真快捷键）；< > = 纯文字箭头恒中性色
      function _dockNavBtn(html, title, fn) {
        var b = document.createElement('button');
        b.className = 'ovmb-dnp';
        b.tabIndex = -1;
        b.setAttribute('data-no-cd', '');
        b.title = title;
        b.innerHTML = html;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 焦点卫生
        b.addEventListener('click', fn);
        return b;
      }
      _dockPrevB = _dockNavBtn('<span class="ovmb-chev">&lt;</span><span class="ovmb-npl">P</span>', _i('shell.overlay.mprev', '上一个') + ' (P)', function () { if (api.onPrev) { api.onPrev(); } });
      _dockFollowB = _dockSwBtn(_OV_MEDIA_ICONS.bullseye, _i('shell.overlay.mtrack', '追踪') + '：' + _ovShufName(_ovMediaFollow), function () { _toggleFollow(); });
      _dockNextB = _dockNavBtn('<span class="ovmb-npl">N</span><span class="ovmb-chev">&gt;</span>', _i('shell.overlay.mnext', '下一个') + ' (N)', function () { if (api.onNext) { api.onNext(); } });
      var _dnav = document.createElement('span');
      _dnav.className = 'ovmb-dnav';
      _dnav.appendChild(_dockPrevB); _dnav.appendChild(_dockFollowB); _dnav.appendChild(_dockNextB);
      head.appendChild(_dnav); head.appendChild(_dockLoopB); head.appendChild(_dockShufB); head.appendChild(_dockCntEl);
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
      // ★ 自定义滚动块（2026-10-02 q319 用户定案）= qh 滚动真理机器接入：隐形滑轨（零轨道绘制，仅 8px 透明命中区）+
      //   常态 2px 无圆角细条（右距 6px——贴内容缘；原 5px 收半）/ hover 变粗贴边（8px）/ 点击滑轨任意位置即跳 /
      //   拖拽跟手（指针捕获 + document 捕获相位）/ 滚轮转发；滚屏与滑轨为兄弟，同挂不滚父容器 _plWrap
      var _plWrap = document.createElement('div');
      _plWrap.className = 'ovmb-plwrap';
      var _plSb = document.createElement('div');
      _plSb.className = 'ovmb-plsb';
      var _plSbThumb = document.createElement('div');
      _plSbThumb.className = 'ovmb-plsb-thumb';
      var _plSbDrag = false, _plSbY0 = 0, _plSbS0 = 0;
      function _plSbSync() {
        var sh = _plListEl.scrollHeight, ch = _plListEl.clientHeight;
        if (!ch || sh <= ch) { _plSb.style.display = 'none'; return; }
        _plSb.style.display = 'block';
        var th = Math.max(24, (ch / sh) * ch);
        _plSbThumb.style.height = th + 'px';
        _plSbThumb.style.top = ((_plListEl.scrollTop / (sh - ch)) * (ch - th)) + 'px';
      }
      _plSb.addEventListener('mouseenter', function () { _plSbThumb.style.width = '8px'; _plSbThumb.style.right = '0'; });
      _plSb.addEventListener('mouseleave', function () {
        if (_plSbDrag) { return; }
        _plSbThumb.style.width = '2px'; _plSbThumb.style.right = '6px';
      });
      // 滑轨点击任意位置 → 滑块立即跳到该位置（滚屏同步跳转；仅非滑块区域）
      _plSb.addEventListener('pointerdown', function (e) {
        if (e.target === _plSbThumb || e.button !== 0) { return; }
        var sh = _plListEl.scrollHeight, ch = _plListEl.clientHeight;
        if (sh <= ch) { return; }
        var ratio = (e.clientY - _plSb.getBoundingClientRect().top) / ch;
        _plListEl.scrollTop = Math.max(0, Math.min(sh - ch, Math.round(ratio * (sh - ch))));
        e.preventDefault();
      });
      // 滚轮转发（滑轨遮挡事件后，滚轮在本区域照常滚屏）
      _plSb.addEventListener('wheel', function (e) {
        var sh = _plListEl.scrollHeight, ch = _plListEl.clientHeight;
        if (sh <= ch) { return; }
        var d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        _plListEl.scrollTop += d;
        e.preventDefault();
      }, { passive: false });
      // 拖拽（指针捕获 + document 捕获相位；pointercancel 兑底复位）
      function _plSbMove(e) {
        if (!_plSbDrag) { return; }
        var sh = _plListEl.scrollHeight, ch = _plListEl.clientHeight;
        if (sh <= ch) { return; }
        var th = Math.max(24, (ch / sh) * ch);
        var ratio = (e.clientY - _plSbY0) / (ch - th);
        _plListEl.scrollTop = Math.max(0, Math.min(sh - ch, _plSbS0 + ratio * (sh - ch)));
        if (e.cancelable) { e.preventDefault(); }
      }
      function _plSbDetach() {
        document.removeEventListener('pointermove', _plSbMove, true);
        document.removeEventListener('pointerup', _plSbDrop, true);
        document.removeEventListener('pointercancel', _plSbCancel, true);
      }
      function _plSbDrop(e) {
        if (!_plSbDrag) { return; }
        _plSbDrag = false;
        _plSbDetach();
        var at = (e && e.clientX != null) ? document.elementFromPoint(e.clientX, e.clientY) : null;
        if (at && _plSb.contains(at)) { _plSbThumb.style.width = '8px'; _plSbThumb.style.right = '0'; }
        else { _plSbThumb.style.width = '2px'; _plSbThumb.style.right = '6px'; }
      }
      function _plSbCancel() {
        if (!_plSbDrag) { return; }
        _plSbDrag = false;
        _plSbDetach();
        _plSbThumb.style.width = '2px'; _plSbThumb.style.right = '6px';
      }
      _plSbThumb.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) { return; }
        _plSbDrag = true; _plSbY0 = e.clientY; _plSbS0 = _plListEl.scrollTop;
        _plSbThumb.style.width = '8px'; _plSbThumb.style.right = '0';   // 抓住即粗（拖拽全程保持）
        try { _plSbThumb.setPointerCapture(e.pointerId); } catch (_) { }
        document.addEventListener('pointermove', _plSbMove, true);
        document.addEventListener('pointerup', _plSbDrop, true);
        document.addEventListener('pointercancel', _plSbCancel, true);
        e.preventDefault(); e.stopPropagation();
      });
      _plListEl.addEventListener('scroll', _plSbSync);
      new MutationObserver(function () { setTimeout(_plSbSync, 30); }).observe(_plListEl, { childList: true });
      try { new ResizeObserver(_plSbSync).observe(_plListEl); } catch (_) { }
      setTimeout(_plSbSync, 50);   // 首帧同步（构建早于布局完成）
      _plSb.appendChild(_plSbThumb);
      _plWrap.appendChild(_plSb);
      _plWrap.appendChild(_plListEl);
      dockEl.appendChild(_plWrap);
      _applyDockSide();
      _syncLoopBtn(); _syncShufBtn(); _syncFollowBtn();   // 初始角标/标题对齐（syncMode 首调先于 dock 构建——此处补同步）
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
        var _cur = mEl.currentTime;
        var _nt = Math.max(0, Math.min(_cur + dir * (1 / fps), d - 0.0005));
        mEl.currentTime = _nt;
        // ★ v9（2026-10-02 q319）：逐帧浮读（贴边夹紧未动 → 不提示）；连按恒刷新
        if (Math.abs(_nt - _cur) > 0.0002) {
          _hintShow(dir < 0 ? _i('shell.overlay.mhStepB', '往回退了一帧') : _i('shell.overlay.mhStepF', '往前进了一帧'));
        }
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
        var _cur = mEl.currentTime;
        var _nt = Math.max(0, Math.min(dd, _cur + sec));
        mEl.currentTime = _nt;
        // ★ v9（2026-10-02 q319）：跳秒浮读——实际位移 >0 才提示（贴边夹紧不误报）；连按恒刷新
        if (Math.abs(_nt - _cur) > 0.01) {
          _hintShow(sec < 0 ? _i('shell.overlay.mhSeekB', '往回跳了 4 秒') : _i('shell.overlay.mhSeekF', '往前跳了 4 秒'));
        }
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
    // ★ v9（2026-10-02 q319 用户定案）：按住连按机器——450ms 后进入连发（每 iv ms 一次：逐帧 130 / 跳秒 220 / 倍速 180）；
    //   松手/取消/窗口失焦/30s 硬顶即停；连发过的残尾 click 吞掉（松手不额外多走一步）；短按单击 = 原 click 语义零变化。
    //   松手丢事件防线（F33 卡拖拽同款三层）：窗口捕获相位 pointerup/pointercancel + pointermove 见 buttons==0 补收尾 + setPointerCapture 兜底。
    function _bindHold(btn, fn, iv) {
      var HOLD_DELAY = 450, HOLD_CAP = 30000;
      var t1 = 0, t2 = 0, cap = 0, fires = 0, swallow = false;
      function _mv(e) { if (!e || e.buttons === 0) { _stop(); } }
      function _stop() {
        if (t1) { clearTimeout(t1); t1 = 0; }
        if (t2) { clearInterval(t2); t2 = 0; }
        if (cap) { clearTimeout(cap); cap = 0; }
        try {
          window.removeEventListener('pointerup', _stop, true);
          window.removeEventListener('pointercancel', _stop, true);
          window.removeEventListener('pointermove', _mv, true);
          window.removeEventListener('blur', _stop, true);
        } catch (_) { }
        if (fires > 0) { swallow = true; setTimeout(function () { swallow = false; }, 600); }
      }
      btn.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) { return; }
        swallow = false; fires = 0;
        if (t1) { clearTimeout(t1); t1 = 0; }
        if (t2) { clearInterval(t2); t2 = 0; }
        try { btn.setPointerCapture(e.pointerId); } catch (_) { }
        t1 = setTimeout(function () {
          t1 = 0;
          fires++; try { fn(); } catch (_) { }
          t2 = setInterval(function () { fires++; try { fn(); } catch (_) { } }, iv);
        }, HOLD_DELAY);
        cap = setTimeout(_stop, HOLD_CAP);
        try {
          window.addEventListener('pointerup', _stop, true);
          window.addEventListener('pointercancel', _stop, true);
          window.addEventListener('pointermove', _mv, true);
          window.addEventListener('blur', _stop, true);
        } catch (_) { }
      });
      btn.addEventListener('click', function () {
        if (swallow) { swallow = false; return; }
        try { fn(); } catch (_) { }
      });
    }
    _bindHold(slowB, function () { _rateStep(-0.5); }, 180);
    _bindHold(seekBB, function () { _seekBy(-4); }, 220);
    _bindHold(stepBB, function () { _stepFrame(-1); }, 130);
    stopB.addEventListener('click', _doStop);
    _bindHold(stepFB, function () { _stepFrame(1); }, 130);
    _bindHold(seekFB, function () { _seekBy(4); }, 220);
    _bindHold(fastB, function () { _rateStep(0.5); }, 180);
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

    // ★ v15（2026-10-02 q319 用户定案）：进度条 = 专属顶部整行（时间两端 + 滑条吃满）——一切按钮不再与进度同行
    var _progSlot = (layout && layout.prog) || bar;
    _progSlot.appendChild(curT);
    _progSlot.appendChild(seek);
    _progSlot.appendChild(durT);
    if (posT) { bar.appendChild(posT); }
    bar.appendChild(volB);
    volBox.appendChild(volS); volBox.appendChild(volTip);
    bar.appendChild(volBox);
    bar.appendChild(rateHost);
    bar.appendChild(abB);
    if (shotB) { bar.appendChild(shotB); }
    if (pipB) { bar.appendChild(pipB); }
    if (fsB) { bar.appendChild(fsB); }

    // ★ 专属播放控制行 + 控制条 = 纵向双条栈（行在上 / 条在下）——恒为主列底部浮层（按钮覆于播放画面之上；v15 起音频/视频同规）
    var stack = document.createElement('div');
    stack.className = 'ovmb-stack';
    stack.appendChild(trxRow);
    stack.appendChild(bar);

    // ★ v9（2026-10-02 q319）：动作提示浮读层（跳秒/逐帧/倍速——按住连按实时刷新）——挂主列中央，全窗口单枚、禁堆积
    var hintEl = document.createElement('div');
    hintEl.className = 'ovmb-hint';
    ((layout && layout.main) || stack).appendChild(hintEl);
    var _hintTimer = 0;
    function _hintShow(text) {
      try {
        hintEl.textContent = text;
        hintEl.classList.add('ovmb-hon');
        if (_hintTimer) { clearTimeout(_hintTimer); }
        _hintTimer = setTimeout(function () { try { hintEl.classList.remove('ovmb-hon'); } catch (_) { } }, 1100);
      } catch (_) { }
    }
    function _hintRate() {
      var s = _i('shell.overlay.mhRate', '播放倍速：{0}');
      _hintShow(String(s).replace('{0}', _ovFmtRate(_ovMediaRate) + '\u00D7'));
    }

    // ★ 恒单行紧凑分档（2026-10-01 q319 用户定案）：行永不换行——按可用宽自动选档（t1/t2/t3）
    //   可用宽 = min(780, 94% 主列)——视频/音频同式（v15 起控制栈同挂主列底部浮层，轻盒特例已废）；
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
          var _av = Math.min(780, _mc * 0.94);
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

    // ★ 编队和弦机器状态（2026-10-02 q319 用户定案 v2）——【空格先按住 → 槽位键按下】= 编队召唤和弦。
    //   down=空格按住中 / toggle=本次按住仍有权切换播放 / fired=本次按住已构成和弦 / sup=被和弦吃掉的槽位键表。
    var _chord = { down: false, toggle: false, fired: false, sup: {} };
    var _SLOT_CODES = { Digit1: 1, Digit2: 1, KeyQ: 1, KeyW: 1, KeyA: 1, KeyS: 1, KeyZ: 1, KeyX: 1 };
    function _chordReset() { _chord.down = false; _chord.toggle = false; _chord.fired = false; _chord.sup = {}; }
    function _chordVis() { try { if (document.hidden) { _chordReset(); } } catch (_) { } }
    try { window.addEventListener('blur', _chordReset); } catch (_) { }
    try { document.addEventListener('visibilitychange', _chordVis); } catch (_) { }

    // 键盘（空格/1/2/Q/W/Z/X/←→/↑↓/M/L/R/A/S/F/N/P——经 api.keys 由宿主全局 keydown 派发；keyup 走 keysUp）
    function keys(e) {
      // ★ 输入框/可编辑目标内让路（倍速自定义输入——空格/数字/字母不得触发播放控制，2026-09-26 v2）
      var _tg = e.target;
      if (_tg && (_tg.tagName === 'INPUT' || _tg.tagName === 'TEXTAREA' || _tg.tagName === 'SELECT' || _tg.isContentEditable)) { return; }
      // ★ 交互元素让路（2026-09-28 q319；2026-10-02 v10 收窄）：焦点在按钮/链接上时仅让「控件激活键」（空格/回车/方向键——
      //   它们仍是该控件的默认键，播放器禁抢）；字母·数字快捷键（Q/W/Z/X/1/2/M/L/R/A/S/F）恒归播放器——
      //   旧全量 return 在焦点滞留按钮时（点过头部按钮未失焦）把整套快捷键静默杀死 + 空格反而激活按钮（编队下拉事故）。
      if (_tg && _tg.closest && _tg.closest('button,a,summary,label,[role="button"],[role="link"]')) {
        var _ck = e.key;
        if (_ck === ' ' || _ck === 'Spacebar' || _ck === 'Enter' ||
          _ck === 'ArrowLeft' || _ck === 'ArrowRight' || _ck === 'ArrowUp' || _ck === 'ArrowDown') { return; }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      var k = e.key;
      // ★ 编队和弦机器（2026-10-02 q319 v2）——空格先按住不放、再按槽位键 = 编队召唤和弦：
      //   和弦意图期间播放器零响应（八个槽位键全屏蔽——含连发与「空格已放、键未松」；空格松键不切换）。
      //   空格点按 = 松键时刻播放/暂停（响应延迟换和弦 100% 纯净：起和弦零播放副作用）；失焦/隐藏即复位。
      if (e.code === 'Space' || k === ' ' || k === 'Spacebar') {
        e.preventDefault();
        if (e.repeat) { return; }
        _chord.down = true; _chord.toggle = true; _chord.fired = false;
        return;
      }
      if (_chord.sup[e.code]) { return; }                       // 被和弦吃掉的槽位键：keyup 前恒屏蔽（含 repeat）
      if (!e.repeat && _chord.down && _SLOT_CODES[e.code]) {    // 空格按住期间「新按下」槽位键 = 和弦（先按后放的键其连发不算新按下——与 broker 物理降沿同构）
        _chord.sup[e.code] = true; _chord.fired = true;
        return;
      }
      if (k === 'ArrowLeft') {
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
      } else if (k === 'p' || k === 'P') {          // ★ N/P = 上/下一首快捷键（2026-10-02 v14：与 dock 头 N/P 按钮同源；连发抑制）
        if (!e.repeat && api && api.onPrev) { try { api.onPrev(); } catch (_) { } }
      } else if (k === 'n' || k === 'N') {
        if (!e.repeat && api && api.onNext) { try { api.onNext(); } catch (_) { } }
      }
    }

    // ★ 和弦机器 keyup 半场（2026-10-02 q319 v2）：空格松键 = 播放/暂停生效时刻（本次按住未构成和弦才生效）；
    //   被屏蔽槽位键的 keyup 仅清屏蔽表（不触达任何播放动作）。
    function keysUp(e) {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        var _wasDown = _chord.down, _wasTog = _chord.toggle, _wasFire = _chord.fired;
        _chord.down = false; _chord.toggle = false; _chord.fired = false;
        if (_wasDown && _wasTog && !_wasFire) { try { _togglePlay(); } catch (_) { } }
        return;
      }
      if (_chord.sup[e.code]) { delete _chord.sup[e.code]; }
    }

    function cleanup() {
      try { _abStop(); } catch (_) { }
      // ★ 增压图卸载（2026-10-01 q319）：断开增益/源——防共享 ctx 经 destination 强引用链保活（节点泄漏）
      try { if (_volTipTimer) { clearTimeout(_volTipTimer); _volTipTimer = 0; } } catch (_) { }
      try { if (_hintTimer) { clearTimeout(_hintTimer); _hintTimer = 0; } } catch (_) { }
      try { if (_boostGain) { _boostGain.disconnect(); _boostGain = null; } } catch (_) { }
      try { if (_boostSrc) { _boostSrc.disconnect(); _boostSrc = null; } } catch (_) { }
      try { if (_trxFitRaf) { cancelAnimationFrame(_trxFitRaf); _trxFitRaf = 0; } } catch (_) { }
      try { if (_trxRO) { _trxRO.disconnect(); _trxRO = null; } } catch (_) { }
      try { _closeRatePanel(); } catch (_) { }
      try { _plDragClear(); } catch (_) { }
      try { window.removeEventListener('blur', _chordReset); } catch (_) { }
      try { document.removeEventListener('visibilitychange', _chordVis); } catch (_) { }
      try { _chordReset(); } catch (_) { }
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
    _buildDock();       // dock 一次性构建（挂入壳层行尾；恒显）
    onListChanged();    // 初始行渲染（恒显——含单曲）

    return { bar: stack, cleanup: cleanup, keys: keys, keysUp: keysUp, esc: function () { try { return _engEscHook ? !!_engEscHook() : false; } catch (_) { return false; } }, setTrack: setTrack, resetAB: resetAB, onListChanged: onListChanged, syncPlay: syncPlay, setVol: _setVol, getVol: function () { return _volWant; } };
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
  var _instKind = _isVid ? 'video' : 'audio';   // ★ 实例形态（跨类型切轨判据——2026-10-02）
  var _playIntent = _autoPlay;                  // ★ 当前装载播放意图（转码重开/跨类型重开带回——禁丢暂停态）
  var _startTime = opts.startTime || 0;
  // 初值覆盖（播放器窗持久化恢复；悬浮层默认不传 = 保持会话粘性）
  var _init = opts.initial || {};
  if (typeof _init.rate === 'number' && isFinite(_init.rate)) { _ovMediaRate = Math.round(Math.max(0.0625, Math.min(16, _init.rate)) * 100) / 100; }
  if (_init.loop === 'all' || _init.loop === 'one') { _ovMediaLoop = 'all'; }   // 存量 'one' 归一 'all'（单曲循环档已合并——2026-10-02）
  else if (_init.loop === 'off') { _ovMediaLoop = 'off'; }
  if (typeof _init.shuffle === 'boolean') { _ovMediaShuffle = _init.shuffle; }
  if (typeof _init.follow === 'boolean') { _ovMediaFollow = _init.follow; }   // ★ 追踪（v14）——会话恢复
  // ★ dock 停靠边恒右（2026-10-02 定案）：旧 init.dockSide 初值覆盖已删——存量会话残留 'left' 不再生效
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

      // ★ v5 布局（2026-09-26 q319）· v15 重构（2026-10-02 q319 用户定案）：根列 = 进度行（顶部整行）+ 壳层行（主列 | dock）；
      //   进度条迁出控制条（专属一行）；控制栈 = 主列底部浮层——按钮恒覆于播放画面之上（视频/音频同规）
      var _rootCol = document.createElement('div');
      _rootCol.className = 'ovmb-rootcol';
      var _progRow = document.createElement('div');
      _progRow.className = 'ovmb-progrow';
      var _shell = document.createElement('div');
      _shell.className = 'ovmb-shell';
      var _mainCol = document.createElement('div');
      _mainCol.className = 'ovmb-maincol';
      _shell.appendChild(_mainCol);
      _rootCol.appendChild(_progRow);
      _rootCol.appendChild(_shell);
      _cont.appendChild(_rootCol);
      var _layout = { shell: _shell, main: _mainCol, prog: _progRow, root: _rootCol };
      var _mEl = document.createElement(_isVid ? 'video' : 'audio');
      _mEl.autoplay = true;
      _mEl.setAttribute('playsinline', '');
      // ★ 2026-09-26：弃用原生控件（⋮ 折叠菜单/系统语言/不可定制/不可加循环）→ 自建控制条 ovmb
      var _vWrap = null, _aBox = null, _aNameEl = null;
      if (_isVid) {
        // ★ v15：视频 = 满铺舞台（画面即播放显示本体——进度行/控制浮层叠于其上；object-fit:contain 保比例）
        _vWrap = _mainCol;
        _mEl.style.cssText = 'width:100%; height:100%; object-fit:contain; outline:none; background:#000;';
        _vWrap.appendChild(_mEl);
      } else {
        // 音频：轻盒 = 满铺舞台（音符 + 文件名居中、下方让位控制浮层）——按钮恒覆于盒面之上（v15 定案；样式类 .ovmb-abox）
        _aBox = document.createElement('div');
        _aBox.className = 'ovmb-abox';
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
      // ★ 自建控制条挂载（恒为主列底部浮层——视频/音频同规；v15）——api 携播放列表上下文（n/N 计数 + dock）
      var _plApi = { n: _plN, idx: _plIdx, onEnded: null, onPrev: null, onNext: null, list: _plList, jump: null, onModeChange: null, getState: null, getBase: null, dockSide: 'right' };
      var _barApi = _ovBuildMediaBar(_mEl, _isVid, _rootCol, _plApi, _layout, H);   // 全屏目标 = 根列（进度行 + 舞台 + dock 随全屏保留）
      if (_isVid) {   // ★ v15：舞台底部柔化 scrim（浮层按钮可读性）——纯装饰 pointer-events:none
        var _scrim = document.createElement('div');
        _scrim.className = 'ovmb-scrim';
        _mainCol.appendChild(_scrim);
      }
      _mainCol.appendChild(_barApi.bar);

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
          // ★ 2026-10-02：转码重开携全量状态（isTx 显式——历史由宿主硬编码；播放意图/倍速/模式/音量/dock 边回灌——历史遗漏致重开后音量/暂停态丢失）
          _reopenHost({
            mode: _txKind, src: 'file:///' + newPath, localPath: newPath, list: _plList, index: _plIdx, isTx: true,
            paused: !_playIntent,
            rate: _ovMediaRate, loop: _ovMediaLoop, shuffle: _ovMediaShuffle, follow: _ovMediaFollow,
            volume: (_barApi && _barApi.getVol) ? _barApi.getVol() : 1, muted: !!_mEl.muted, dockSide: _ovDockSide || 'right'
          });
        }, _ovMediaFail, H);     };
      // ★ 播放意图显式化（2026-09-28 q319 修复「切歌即暂停/列表循环停摆/按钮态错乱」）：wantPlay 由动作语义传入
      //   —— mount 期冻结的 _autoPlay 只决定「首载」（恢复场景安静启动）；此后一切切轨（点击列表/⏮⏭/播完进位/
      //   跳过坏轨/追加起播）恒续播。图标对齐：Chromium 重设 src 打断播放只发 abort/emptied、不发 pause（探针实锤）
      //   ——每次装载后必须显式 syncPlay()（读元素真值），否则按钮图标永远停在旧态；wantPlay=false 时显式 pause()
      //   保证暂停态落定（幂等无害）。
      function _loadNative(src, isTx, wantPlay) {
        _playIntent = !!wantPlay;
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
        // ★ 跨类型切轨（2026-10-02 q319 用户定案：音/视频混合播放列表）：audio 元素播不了视频画面、video 元素不产音符盒——
        //   类型变化 → 宿主整体重建（H.reopen 携 mode/list/index + 播放意图 + 倍速/模式/音量/dock 边全量回灌）；
        //   同类型零开销直载（既有路径原样）。三宿主（悬浮层/播放器窗/窗内卡）同契约。
        var _wantKind = _ovKindOf(it.localPath || it.src || '');
        if (_wantKind !== _instKind) {
          _playIntent = !!wantPlay;
          _reopenHost({
            mode: _wantKind, src: it.src, localPath: it.localPath, list: _plList, index: _plIdx,
            paused: !wantPlay,
            rate: _ovMediaRate, loop: _ovMediaLoop, shuffle: _ovMediaShuffle, follow: _ovMediaFollow,
            volume: (_barApi && _barApi.getVol) ? _barApi.getVol() : 1, muted: !!_mEl.muted, dockSide: _ovDockSide || 'right'
          });
          return;
        }
        _playIntent = !!wantPlay;
        if (_OV_TX_FIRST_EXTS[_ovTxExt(it.localPath || it.src)]) { _ovMediaTx(); return; }
        _loadNative(it.src, false, !!wantPlay);
      }
      // 模式裁决（ended 后；A-B 已由控制条先行拦截）——循环 × 随机 两独立维度
      function _plOnEnded() {
        if (!_plList || _plN < 2) {                                        // 单列表：循环关=播完停；循环开=重播（= 旧单曲循环等价物）
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
    keysUp: _barApi.keysUp,
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
        rate: _ovMediaRate, loop: _ovMediaLoop, shuffle: _ovMediaShuffle, follow: _ovMediaFollow,
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
  kindOf: function (p) { return _ovKindOf(p); }
};
window.QQQMediaEngine = {
  version: '1.2',
  configure: function (host) { HOST = host || {}; _ensureMediaCss(); return API; },
  api: API   // 显式宿主直通（同页多宿主——窗内播放器卡用 api.mount({host})，不碰全局 configure）
};
})();
