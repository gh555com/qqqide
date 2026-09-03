// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// qqq-links.js — 服务器下发超链接（唯一入口）
//
// 真理源: 服务器静态文件 /static/qqqide/client-links.json（CN nginx，改动即生效）
//   运维控制台: gaea/cf/qqqide/服务器下发超链接.py（PySide2，改完 SFTP 直写服务器）
// 兜底: 拉取失败/服务器未配置 → FALLBACK_LINKS（客户端唯一兜底，见下方双写同步点）
// 双线路 URL 双主备（direct-cn → www），与 guard-meta.js 同源模式。
// 加载点: server-app/index.html（主窗口）；goods iframe 经 parent.QQQLinks 读取。
// ============================================================================

; (function () {
    'use strict';

    var _URLS = [
        'https://direct-cn.gh555.com/static/qqqide/client-links.json',
        'https://www.gh555.com/static/qqqide/client-links.json'
    ];

    // ★ 客户端兜底表 — 双写同步点 A
    // 新增/修改 key 必须同步:
    //   gaea/cf/qqqide/服务器下发超链接.py  DEFAULT_LINKS（运维控制台出厂兜底值）
    var FALLBACK_LINKS = {
        // 首次启动弹窗「借由 Roam 你可以快速操作文件，包括删除」跳转的教学视频
        'roam_delete_video': 'https://www.bilibili.com/video/BV1PD826SEMT'
    };

    var _links = null;   // 服务器拉取成功后的 {key: url}（部分配置 = 服务器真理，缺失 key 自动回退兜底）
    var _loading = false;
    var _keyRe = /^[A-Za-z0-9_.-]{1,64}$/;

    // 只放行 http/https，杜绝 javascript:/data: 等注入形态
    function _validUrl(v) {
        if (typeof v !== 'string' || !v) return null;
        try {
            var u = new URL(v, 'https://gh555.com/');
            return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
        } catch (e) { return null; }
    }

    // 逐条清洗：key 白名单形态 + value 协议校验；脏条目静默丢弃
    function _clean(obj) {
        if (!obj || typeof obj !== 'object') return null;
        var out = null;
        var ks = Object.keys(obj);
        for (var i = 0; i < ks.length; i++) {
            var k = ks[i];
            var u = _validUrl(obj[k]);
            if (_keyRe.test(k) && u) {
                if (!out) out = {};
                out[k] = u;
            }
        }
        return out; // 合法空对象 {} 也算服务器真理（全 key 回退兜底），仅非对象/解析失败视为拉取失败
    }

    function _refresh() {
        if (_loading) return;
        _loading = true;
        (function _try(i) {
            if (i >= _URLS.length) { _loading = false; return; }
            fetch(_URLS[i] + '?_=' + Date.now(), { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (j) {
                    var c = _clean(j);
                    if (c !== null) {
                        _links = c;
                    } else {
                        _try(i + 1); // 本线路坏 → 换备线
                    }
                    _loading = false;
                })
                .catch(function () { _try(i + 1); });
        })(0);
    }

    // 取单条: 服务器优先，缺 key 回退兜底；两者皆无 → null（调用方自行隐藏链接）
    function url(key) {
        if (_links && Object.prototype.hasOwnProperty.call(_links, key)) return _links[key];
        return FALLBACK_LINKS[key] || null;
    }

    // 合并视图（服务器值覆盖兜底），供展示/调试
    function all() {
        var out = {};
        var k;
        for (k in FALLBACK_LINKS) if (Object.prototype.hasOwnProperty.call(FALLBACK_LINKS, k)) out[k] = FALLBACK_LINKS[k];
        if (_links) for (k in _links) if (Object.prototype.hasOwnProperty.call(_links, k)) out[k] = _links[k];
        return out;
    }

    window.QQQLinks = {
        url: url,
        all: all,
        refresh: _refresh,
        FALLBACK: FALLBACK_LINKS
    };

    _refresh(); // 启动即异步拉取，不阻塞任何路径
})();
