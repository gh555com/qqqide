// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// launcher.c — qqqide 原生启动器（Win32 API，零外部依赖）
//
// ★ Bootstrap Config 架构（2026-07-18）
//   唯一硬编码: CONFIG_URL → 下载 launcher-config.json → 一切行为由配置驱动
//   配置可随时在服务器更新，用户永不需要重新下载绿色包。
//   配置缓存到本地，离线时用缓存+内置默认值兜底。
//
// 非阻塞 100% 托管更新：
//   ① 加载配置（缓存→服务器→默认值）→ 立即启动 joker.exe → 用户先用着
//   ② 后台线程 → 按配置检查服务器 → 下载 r.next → 写 .version-next
//   ③ 下次启动 → 检测暂存更新 → 删旧 gh555.com/ → 解压 → 100% 精确一致
//
// 编译：build.bat（一键：windres + gcc → qqqide.exe，带 shell/icon.ico 图标）
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <commctrl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <process.h>
#include <tlhelp32.h>

// ── WinHTTP redirect (MinGW headers may not define) ──
#ifndef WINHTTP_OPTION_REDIRECT_POLICY
#define WINHTTP_OPTION_REDIRECT_POLICY        88
#define WINHTTP_OPTION_REDIRECT_POLICY_NEVER   0
#define WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS  1
#endif

// ── 窗口常量 ──
#define WW 420
#define WH 240

// ── 颜色（Solarized Light） ──
#define COL_BG      RGB(0xfd, 0xf6, 0xe3)
#define COL_TITLE   RGB(0x07, 0x36, 0x42)
#define COL_STATUS  RGB(0x58, 0x6e, 0x75)
#define COL_DOT     RGB(0x85, 0x99, 0x00)
#define COL_ERR     RGB(0xdc, 0x32, 0x2f)
#define COL_BAR_BG  RGB(0xee, 0xe8, 0xd5)
#define COL_BAR_FG  RGB(0xcb, 0x4b, 0x16)

// ── 状态机 ──
enum { PHASE_INIT, PHASE_LAUNCHING, PHASE_WAITING, PHASE_DONE, PHASE_ERROR };

#define ERROR_CLOSE_TICKS 12

// ═══════════════════════════════════════════════════════════════
// ★ Bootstrap Config — 唯一硬编码 URL，其余一切由配置驱动
// ═══════════════════════════════════════════════════════════════
#define CONFIG_HOST  L"gh555.com"
#define CONFIG_PATH  L"/dl/qqqide-up/launcher-config.json"

// ── 配置结构体 ──
typedef struct {
    char update_host[128];
    char latest_path[256];
    char r_path[256];
    int  use_https;
    int  follow_redirect;
    int  timeout_sec;
    int  retry;
    char joker_exe[256];
    char first_run_r[128];
} LauncherConfig;

// ── 内置默认值（与服务端 launcher-config.json 保持一致） ──
static const LauncherConfig DEFAULT_CFG = {
    "gh555.com",
    "/dl/qqqide-up/latest.txt",
    "/dl/qqqide-up/r",
    1,  // use_https
    1,  // follow_redirect
    30, // timeout_sec
    3,  // retry
    "gh555.com/joker.exe",
    "r"
};

static LauncherConfig g_cfg;
static int g_cfgLoaded = 0;

// ── 全局状态 ──
static int  g_phase   = PHASE_INIT;
static int  g_err     = 0;
static int  g_pct     = 0;
static char g_status[128] = "";
static int  g_showStatusText = 0;

static HWND    g_hwnd           = NULL;
static HANDLE  g_hProcess       = NULL;
static DWORD   g_jokerPid       = 0;
static HANDLE  g_hUpdateThread  = NULL;
static volatile LONG g_updateRunning = 0;
static HANDLE  g_hApplyThread   = NULL;
static volatile LONG g_applyRunning  = 0;
static WCHAR   g_exeDir[MAX_PATH] = {0};
static int     g_tickCount      = 0;
static int     g_closeCountdown = 0;

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

static int fileExistsW(const WCHAR *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static void setStatus(const char *s, int isErr) {
    strncpy(g_status, s, sizeof(g_status) - 1);
    g_err = isErr;
    if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
}

// ── 通过 PID 查找 joker.exe 的主窗口 ──
typedef struct { DWORD pid; HWND found; } FindWindowCtx;
static BOOL CALLBACK findWindowByPid(HWND hwnd, LPARAM lParam) {
    FindWindowCtx *ctx = (FindWindowCtx*)lParam;
    DWORD wpid = 0;
    GetWindowThreadProcessId(hwnd, &wpid);
    if (wpid != ctx->pid) return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;
    LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if (!(style & WS_CAPTION) && !(style & WS_POPUP)) return TRUE;
    RECT rc;
    GetClientRect(hwnd, &rc);
    if (rc.right < 200 || rc.bottom < 100) return TRUE;
    ctx->found = hwnd;
    return FALSE;
}
static HWND findJokerMainWindow(DWORD pid) {
    FindWindowCtx ctx = { pid, NULL };
    EnumWindows(findWindowByPid, (LPARAM)&ctx);
    return ctx.found;
}

static void pumpMessages(void) {
    MSG m;
    while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
}

static int readFileText(const WCHAR *path, char *buf, int bufSize) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD rd = 0;
    ReadFile(h, buf, bufSize - 1, &rd, NULL);
    CloseHandle(h);
    if (rd == 0) return 0;
    buf[rd] = '\0';
    char *nl = strchr(buf, '\n'); if (nl) *nl = '\0';
    nl = strchr(buf, '\r'); if (nl) *nl = '\0';
    while (rd > 0 && (buf[rd-1] == ' ' || buf[rd-1] == '\t')) buf[--rd] = '\0';
    return (int)strlen(buf);
}

static void writeFileText(const WCHAR *path, const char *text) {
    HANDLE h = CreateFileW(path, GENERIC_WRITE, 0, NULL,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD wr = 0;
    WriteFile(h, text, (DWORD)strlen(text), &wr, NULL);
    CloseHandle(h);
}

static int readLocalVersion(const WCHAR *exeDir, char *verBuf, int bufSize) {
    WCHAR vPath[MAX_PATH];
    swprintf(vPath, MAX_PATH, L"%s\\gh555.com\\.version", exeDir);
    return readFileText(vPath, verBuf, bufSize);
}

static void writeLocalVersion(const WCHAR *exeDir, const char *ver) {
    WCHAR ghDir[MAX_PATH], vPath[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);
    CreateDirectoryW(ghDir, NULL);
    swprintf(vPath, MAX_PATH, L"%s\\gh555.com\\.version", exeDir);
    writeFileText(vPath, ver);
}

// ═══════════════════════════════════════════════════════════════
// 极简 JSON 解析器 — 仅解析 launcher-config.json（一层对象）
// 语法: {"key": "str", "key2": true, "key3": 123}
// ═══════════════════════════════════════════════════════════════

static void skipWhitespace(const char **p) {
    while (**p == ' ' || **p == '\t' || **p == '\n' || **p == '\r') (*p)++;
}

static int parseJsonString(const char **p, char *out, int outSize) {
    skipWhitespace(p);
    if (**p != '"') return 0;
    (*p)++;
    int i = 0;
    while (**p && **p != '"' && i < outSize - 1) {
        if (**p == '\\') { (*p)++; if (**p) { out[i++] = **p; (*p)++; } }
        else { out[i++] = **p; (*p)++; }
    }
    out[i] = '\0';
    if (**p == '"') (*p)++;
    return 1;
}

static int parseJsonBool(const char **p, int *val) {
    skipWhitespace(p);
    if (strncmp(*p, "true", 4) == 0) { *val = 1; (*p) += 4; return 1; }
    if (strncmp(*p, "false", 5) == 0) { *val = 0; (*p) += 5; return 1; }
    return 0;
}

static int parseJsonInt(const char **p, int *val) {
    skipWhitespace(p);
    int sign = 1;
    if (**p == '-') { sign = -1; (*p)++; }
    if (**p < '0' || **p > '9') return 0;
    *val = 0;
    while (**p >= '0' && **p <= '9') { *val = (*val * 10) + (**p - '0'); (*p)++; }
    *val *= sign;
    return 1;
}

// 解析 launcher-config.json → 填入 cfg
static int parseConfig(const char *json, LauncherConfig *cfg) {
    const char *p = json;
    skipWhitespace(&p);
    if (*p != '{') return 0;
    p++;

    while (1) {
        skipWhitespace(&p);
        if (*p == '}') { p++; break; }
        if (*p == ',') { p++; continue; }
        if (*p == '\0') break;

        char key[64];
        if (!parseJsonString(&p, key, sizeof(key))) return 0;
        skipWhitespace(&p);
        if (*p != ':') return 0;
        p++;

        // ── 根据 key 解析 value ──
        if (strcmp(key, "update_host") == 0) {
            skipWhitespace(&p); parseJsonString(&p, cfg->update_host, sizeof(cfg->update_host));
        } else if (strcmp(key, "latest_path") == 0) {
            skipWhitespace(&p); parseJsonString(&p, cfg->latest_path, sizeof(cfg->latest_path));
        } else if (strcmp(key, "r_path") == 0) {
            skipWhitespace(&p); parseJsonString(&p, cfg->r_path, sizeof(cfg->r_path));
        } else if (strcmp(key, "use_https") == 0) {
            parseJsonBool(&p, &cfg->use_https);
        } else if (strcmp(key, "follow_redirect") == 0) {
            parseJsonBool(&p, &cfg->follow_redirect);
        } else if (strcmp(key, "timeout_sec") == 0) {
            parseJsonInt(&p, &cfg->timeout_sec);
        } else if (strcmp(key, "retry") == 0) {
            parseJsonInt(&p, &cfg->retry);
        } else if (strcmp(key, "joker_exe") == 0) {
            skipWhitespace(&p); parseJsonString(&p, cfg->joker_exe, sizeof(cfg->joker_exe));
        } else if (strcmp(key, "first_run_r") == 0) {
            skipWhitespace(&p); parseJsonString(&p, cfg->first_run_r, sizeof(cfg->first_run_r));
        } else {
            // 跳过未知 key → 向前兼容（未来加新字段不崩溃）
            skipWhitespace(&p);
            if (*p == '"') { char dummy[256]; parseJsonString(&p, dummy, sizeof(dummy)); }
            else if (*p == 't' || *p == 'f') { int dummy; parseJsonBool(&p, &dummy); }
            else if ((*p >= '0' && *p <= '9') || *p == '-') { int dummy; parseJsonInt(&p, &dummy); }
            else if (*p == '{') { int depth = 1; p++; while (*p && depth > 0) { if (*p == '{') depth++; if (*p == '}') depth--; p++; } }
            else { p++; }
        }
    }
    return 1;
}

// ═══════════════════════════════════════════════════════════════
// 配置加载管线：本地缓存 → 服务器 → 默认值
// ═══════════════════════════════════════════════════════════════

static void loadConfigFromBuf(const char *buf, int len, LauncherConfig *cfg) {
    // 从默认值开始（零值字段被默认覆盖）
    memcpy(cfg, &DEFAULT_CFG, sizeof(LauncherConfig));
    if (len > 0 && buf[0] == '{') {
        parseConfig(buf, cfg);
    }
}

// 尝试从本地缓存加载配置（新位置优先，旧位置兼容）
static int loadCachedConfig(const WCHAR *exeDir, LauncherConfig *cfg) {
    WCHAR cfgPath[MAX_PATH];
    char buf[4096];
    int len;
    // 1. 新位置: gh555.com\Data\launcher-config.json
    swprintf(cfgPath, MAX_PATH, L"%s\\gh555.com\\Data\\launcher-config.json", exeDir);
    len = readFileText(cfgPath, buf, sizeof(buf));
    if (len > 0) { loadConfigFromBuf(buf, len, cfg); return 1; }
    // 2. 旧位置兼容: 根目录 launcher-config.json
    swprintf(cfgPath, MAX_PATH, L"%s\\launcher-config.json", exeDir);
    len = readFileText(cfgPath, buf, sizeof(buf));
    if (len > 0) { loadConfigFromBuf(buf, len, cfg); return 1; }
    return 0;
}

// 保存配置到本地缓存（新位置 gh555.com\Data\）
static void saveCachedConfig(const WCHAR *exeDir, const char *json, int len) {
    WCHAR cfgPath[MAX_PATH];
    swprintf(cfgPath, MAX_PATH, L"%s\\gh555.com\\Data\\launcher-config.json", exeDir);
    // 确保父目录存在
    WCHAR dir[MAX_PATH];
    wcscpy(dir, cfgPath);
    for (WCHAR *p = dir; *p; p++) {
        if (*p == L'\\') { *p = L'\0'; CreateDirectoryW(dir, NULL); *p = L'\\'; }
    }
    // 原子写：先写临时文件，再重命名
    WCHAR tmpPath[MAX_PATH];
    swprintf(tmpPath, MAX_PATH, L"%s\\gh555.com\\Data\\launcher-config.tmp", exeDir);
    HANDLE h = CreateFileW(tmpPath, GENERIC_WRITE, 0, NULL,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD wr = 0;
    WriteFile(h, json, len, &wr, NULL);
    CloseHandle(h);
    DeleteFileW(cfgPath);
    MoveFileW(tmpPath, cfgPath);
}

// 从服务器下载配置（返回 JSON 字符串长度，失败返回 0）
static int fetchConfigFromServer(char *buf, int bufSize) {
    HINTERNET hSession = WinHttpOpen(L"qqqide-launcher/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return 0;

    HINTERNET hConnect = WinHttpConnect(hSession, CONFIG_HOST,
        INTERNET_DEFAULT_HTTPS_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return 0; }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", CONFIG_PATH, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        WINHTTP_FLAG_SECURE);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return 0; }

    DWORD timeout = 15000;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_CONNECT_TIMEOUT, &timeout, sizeof(timeout));
    WinHttpSetOption(hRequest, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));
    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));

    if (!WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return 0;
    }
    if (!WinHttpReceiveResponse(hRequest, NULL)) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return 0;
    }

    DWORD statusCode = 0, statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return 0;
    }

    int total = 0;
    DWORD avail = 0, rd = 0;
    while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
        DWORD toRead = avail;
        if (total + (int)toRead >= bufSize) toRead = bufSize - total - 1;
        if (toRead == 0) break;
        if (!WinHttpReadData(hRequest, buf + total, toRead, &rd)) break;
        total += rd;
        if (total >= bufSize - 1) break;
    }
    buf[total] = '\0';
    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return total;
}

// 主配置加载: 缓存 → 服务器 → 默认值
static void loadConfig(const WCHAR *exeDir) {
    // ① 先尝试本地缓存（最快，离线可用）
    if (loadCachedConfig(exeDir, &g_cfg)) {
        g_cfgLoaded = 1;
    } else {
        // ② 无缓存 → 用默认值先顶着
        memcpy(&g_cfg, &DEFAULT_CFG, sizeof(LauncherConfig));
        g_cfgLoaded = 1;
    }

    // ③ 尝试从服务器拉取最新配置（非阻塞，失败用现有值）
    char cfgBuf[4096];
    int cfgLen = fetchConfigFromServer(cfgBuf, sizeof(cfgBuf));
    if (cfgLen > 0 && cfgBuf[0] == '{') {
        // 合并：从默认值开始，服务器值覆盖
        LauncherConfig newCfg;
        memcpy(&newCfg, &DEFAULT_CFG, sizeof(LauncherConfig));
        if (parseConfig(cfgBuf, &newCfg)) {
            memcpy(&g_cfg, &newCfg, sizeof(LauncherConfig));
            saveCachedConfig(exeDir, cfgBuf, cfgLen);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// WinHTTP 下载（参数由配置驱动）
// ═══════════════════════════════════════════════════════════════

static void toWide(const char *src, WCHAR *dst, int dstMax) {
    MultiByteToWideChar(CP_UTF8, 0, src, -1, dst, dstMax);
}

// 下载字符串到内存
static int downloadToString(const char *host, const char *path,
                             char *buf, int bufSize, int useHttps) {
    WCHAR wHost[256], wPath[512];
    toWide(host, wHost, 256);
    toWide(path, wPath, 512);

    HINTERNET hSession = WinHttpOpen(L"qqqide-launcher/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return -1;

    HINTERNET hConnect = WinHttpConnect(hSession, wHost,
        useHttps ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return -1; }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", wPath, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        useHttps ? WINHTTP_FLAG_SECURE : 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    DWORD timeout = (DWORD)(g_cfg.timeout_sec * 1000);
    WinHttpSetOption(hRequest, WINHTTP_OPTION_CONNECT_TIMEOUT, &timeout, sizeof(timeout));
    WinHttpSetOption(hRequest, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));

    if (g_cfg.follow_redirect) {
        DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
        WinHttpSetOption(hRequest, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));
    }

    BOOL ok = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
    if (!ok) { WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    ok = WinHttpReceiveResponse(hRequest, NULL);
    if (!ok) { WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    DWORD statusCode = 0, statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return -1;
    }

    int total = 0;
    DWORD avail = 0, rd = 0;
    while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
        DWORD toRead = avail;
        if (total + (int)toRead >= bufSize) toRead = bufSize - total - 1;
        if (toRead == 0) break;
        if (!WinHttpReadData(hRequest, buf + total, toRead, &rd)) break;
        total += rd;
        if (total >= bufSize - 1) break;
    }
    buf[total] = '\0';
    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return total;
}

// 下载文件到磁盘
static int downloadFile(const char *host, const char *path,
                         const WCHAR *dest, int useHttps) {
    WCHAR wHost[256], wPath[512];
    toWide(host, wHost, 256);
    toWide(path, wPath, 512);

    HINTERNET hSession = WinHttpOpen(L"qqqide-launcher/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return -1;

    HINTERNET hConnect = WinHttpConnect(hSession, wHost,
        useHttps ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return -1; }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", wPath, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        useHttps ? WINHTTP_FLAG_SECURE : 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    DWORD timeout = 60000; // 文件下载固定 60s
    WinHttpSetOption(hRequest, WINHTTP_OPTION_CONNECT_TIMEOUT, &timeout, sizeof(timeout));
    WinHttpSetOption(hRequest, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));

    if (g_cfg.follow_redirect) {
        DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
        WinHttpSetOption(hRequest, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));
    }

    BOOL ok = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
    if (!ok) { WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    ok = WinHttpReceiveResponse(hRequest, NULL);
    if (!ok) { WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    DWORD statusCode = 0, statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return -1;
    }

    DWORD contentLen = 0, clSize = sizeof(contentLen);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &contentLen, &clSize, WINHTTP_NO_HEADER_INDEX);

    HANDLE hFile = CreateFileW(dest, GENERIC_WRITE, 0, NULL,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return -1;
    }

    DWORD totalDownloaded = 0, avail = 0, rd = 0;
    char buf[65536];
    while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
        DWORD toRead = avail > sizeof(buf) ? sizeof(buf) : avail;
        if (!WinHttpReadData(hRequest, buf, toRead, &rd)) break;
        DWORD wr = 0;
        WriteFile(hFile, buf, rd, &wr, NULL);
        totalDownloaded += rd;
        if (contentLen > 0) {
            int pct = (int)((unsigned long long)totalDownloaded * 100 / contentLen);
            if (pct > g_pct && pct <= 100) {
                g_pct = pct;
                if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
            }
        }
        pumpMessages();
    }
    CloseHandle(hFile);
    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);

    if (contentLen > 0 && totalDownloaded < contentLen * 0.99) return -1;
    return totalDownloaded > 0 ? 0 : -1;
}

// ═══════════════════════════════════════════════════════════════
// 更新逻辑（参数全部来自 g_cfg）
// ═══════════════════════════════════════════════════════════════

// 检查服务器更新 → 1=需更新, 0=已最新, -1=失败
static int checkForUpdate(const WCHAR *exeDir, char *serverVer, int svSize) {
    char serverBuf[64] = {0};
    int len = downloadToString(g_cfg.update_host, g_cfg.latest_path,
        serverBuf, sizeof(serverBuf), g_cfg.use_https);
    if (len <= 0) {
        // HTTP 兜底（配置可能关了 https）
        if (g_cfg.use_https) {
            len = downloadToString(g_cfg.update_host, g_cfg.latest_path,
                serverBuf, sizeof(serverBuf), 0);
        }
    }
    if (len <= 0) return -1;

    char *nl = strchr(serverBuf, '\n'); if (nl) *nl = '\0';
    nl = strchr(serverBuf, '\r'); if (nl) *nl = '\0';
    while (len > 0 && (serverBuf[len-1] == ' ' || serverBuf[len-1] == '\t')) serverBuf[--len] = '\0';
    if (len == 0) return -1;
    strncpy(serverVer, serverBuf, svSize - 1);

    char localVer[64] = {0};
    int localLen = readLocalVersion(exeDir, localVer, sizeof(localVer));
    if (localLen == 0) return 1;
    if (strcmp(localVer, serverVer) != 0) return 1;
    return 0;
}

// ═══════════════════════════════════════════════════════════════
// 解压 / 目录操作
// ═══════════════════════════════════════════════════════════════

static int removeDir(const WCHAR *dir) {
    WCHAR searchPath[MAX_PATH];
    swprintf(searchPath, MAX_PATH, L"%s\\*", dir);
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) {
        RemoveDirectoryW(dir);
        return 0;
    }
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR full[MAX_PATH];
        swprintf(full, MAX_PATH, L"%s\\%s", dir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            removeDir(full);
        } else {
            SetFileAttributesW(full, FILE_ATTRIBUTE_NORMAL);
            for (int r = 0; r < 5; r++) {
                if (DeleteFileW(full)) break;
                Sleep(200);
            }
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    RemoveDirectoryW(dir);
    return 0;
}

static int extractPayload(const WCHAR *rPath, const WCHAR *exeDir) {
    if (!fileExistsW(rPath)) {
        setStatus("missing payload file", 1);
        return -1;
    }
    WCHAR cmdLine[1024];
    swprintf(cmdLine, 1024, L"\"%s\" -y", rPath);
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {0};
    if (!CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
        CREATE_NO_WINDOW, NULL, exeDir, &si, &pi)) {
        char buf[64];
        snprintf(buf, sizeof(buf), "extract fail (err=%lu)", GetLastError());
        setStatus(buf, 1);
        return -1;
    }
    CloseHandle(pi.hThread);
    g_pct = 10;
    setStatus("extracting…", 0);
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    DWORD ec = STILL_ACTIVE;
    int ticks = 0;
    while (ec == STILL_ACTIVE) {
        Sleep(250);
        if (GetExitCodeProcess(pi.hProcess, &ec) && ec == STILL_ACTIVE) {
            ticks++;
            if (ticks < 36 && ticks % 4 == 0 && g_pct < 90) {
                g_pct += 9;
                if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
            }
        }
    }
    CloseHandle(pi.hProcess);
    if (ec != 0) { setStatus("extract error", 1); return -1; }

    // 验证 joker.exe 存在
    WCHAR check[MAX_PATH];
    WCHAR wJoker[256];
    toWide(g_cfg.joker_exe, wJoker, 256);
    swprintf(check, MAX_PATH, L"%s\\%s", exeDir, wJoker);
    if (!fileExistsW(check)) { setStatus("extract incomplete", 1); return -1; }

    // 清理 r 文件
    for (int retry = 0; retry < 5; retry++) {
        if (DeleteFileW(rPath)) break;
        Sleep(400);
    }
    if (fileExistsW(rPath)) {
        Sleep(2000);
        for (int retry = 0; retry < 5; retry++) {
            if (DeleteFileW(rPath)) break;
            Sleep(500);
        }
    }
    if (fileExistsW(rPath)) MoveFileExW(rPath, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    return 0;
}

static int downloadAndExtractUpdate(const WCHAR *exeDir, const char *newVer) {
    g_showStatusText = 1;
    setStatus("downloading update…", 0);
    g_pct = 0;
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }

    WCHAR rPath[MAX_PATH];
    swprintf(rPath, MAX_PATH, L"%s\\r", exeDir);
    DeleteFileW(rPath);

    int result = downloadFile(g_cfg.update_host, g_cfg.r_path, rPath, g_cfg.use_https);
    if (result != 0 && g_cfg.use_https) {
        DeleteFileW(rPath);
        setStatus("retry HTTP…", 0);
        if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
        result = downloadFile(g_cfg.update_host, g_cfg.r_path, rPath, 0);
    }
    if (result != 0) { setStatus("download failed", 1); DeleteFileW(rPath); return -1; }

    setStatus("cleaning old version…", 0);
    g_pct = 95;
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    WCHAR ghDir[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);

    // ★ 保存用户数据
    WCHAR dataDir[MAX_PATH], backupDir[MAX_PATH];
    swprintf(dataDir, MAX_PATH, L"%s\\Data", ghDir);
    swprintf(backupDir, MAX_PATH, L"%s\\Data.backup", exeDir);
    removeDir(backupDir);
    int hasBackup = MoveFileW(dataDir, backupDir);

    removeDir(ghDir);

    if (extractPayload(rPath, exeDir) != 0) {
        if (hasBackup) MoveFileW(backupDir, dataDir);
        return -1;
    }

    // ★ 恢复用户数据
    if (hasBackup) {
        removeDir(dataDir);
        MoveFileW(backupDir, dataDir);
    }
    writeLocalVersion(exeDir, newVer);

    g_pct = 100;
    setStatus("update complete", 0);
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    Sleep(300);
    return 0;
}

// ★ 快速交换：gh555.com-next → gh555.com（原子 rename，<1s）
static int applySwapIfReady(const WCHAR *exeDir) {
    WCHAR swapReady[MAX_PATH];
    swprintf(swapReady, MAX_PATH, L"%s\\.swap-ready", exeDir);
    if (!fileExistsW(swapReady)) return 0;

    WCHAR ghDir[MAX_PATH], ghOld[MAX_PATH], ghNext[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);
    swprintf(ghOld, MAX_PATH, L"%s\\gh555.com-old", exeDir);
    swprintf(ghNext, MAX_PATH, L"%s\\gh555.com-next", exeDir);

    if (!fileExistsW(ghNext)) { DeleteFileW(swapReady); return 0; }

    // ★ 保存用户数据
    WCHAR dataDir[MAX_PATH], backupDir[MAX_PATH];
    swprintf(dataDir, MAX_PATH, L"%s\\Data", ghDir);
    swprintf(backupDir, MAX_PATH, L"%s\\Data.backup", exeDir);
    removeDir(backupDir);
    int hasBackup = 0;
    if (fileExistsW(dataDir)) {
        hasBackup = (MoveFileW(dataDir, backupDir) != 0);
    }

    // 原子交换
    removeDir(ghOld);
    if (!MoveFileW(ghDir, ghOld)) {
        if (hasBackup) MoveFileW(backupDir, dataDir);
        return -1;
    }
    if (!MoveFileW(ghNext, ghDir)) {
        MoveFileW(ghOld, ghDir);
        if (hasBackup) MoveFileW(backupDir, dataDir);
        return -1;
    }

    // ★ 恢复用户数据
    if (hasBackup) {
        removeDir(dataDir);
        MoveFileW(backupDir, dataDir);
    }

    removeDir(ghOld);
    DeleteFileW(swapReady);
    return 1;
}

static int applyStagedUpdate(const WCHAR *exeDir) {
    WCHAR rNext[MAX_PATH], vNext[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", exeDir);
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", exeDir);
    if (!fileExistsW(rNext) || !fileExistsW(vNext)) return 0;

    char newVer[64] = {0};
    int rd = readFileText(vNext, newVer, sizeof(newVer));
    if (rd <= 0) { DeleteFileW(rNext); return 0; }

    g_showStatusText = 1;
    setStatus("Core update, ~3 min", 0);
    g_pct = 5;
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }

    WCHAR ghDir[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);

    // ★ 保存用户数据
    WCHAR dataDir[MAX_PATH], backupDir[MAX_PATH];
    swprintf(dataDir, MAX_PATH, L"%s\\Data", ghDir);
    swprintf(backupDir, MAX_PATH, L"%s\\Data.backup", exeDir);
    removeDir(backupDir);
    int hasBackup = MoveFileW(dataDir, backupDir);

    removeDir(ghDir);

    // 用 r.next 解压
    WCHAR cmdLine[1024];
    swprintf(cmdLine, 1024, L"\"%s\" -y", rNext);
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {0};
    if (!CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
        CREATE_NO_WINDOW, NULL, exeDir, &si, &pi)) {
        if (hasBackup) MoveFileW(backupDir, dataDir);
        DeleteFileW(rNext); DeleteFileW(vNext);
        return -1;
    }
    CloseHandle(pi.hThread);
    DWORD ec = STILL_ACTIVE;
    int ticks = 0;
    while (ec == STILL_ACTIVE) {
        Sleep(250);
        if (GetExitCodeProcess(pi.hProcess, &ec) && ec == STILL_ACTIVE) {
            ticks++;
            if (ticks < 36 && ticks % 4 == 0 && g_pct < 95) {
                g_pct += 10;
                if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
            }
        }
    }
    CloseHandle(pi.hProcess);
    if (ec != 0) {
        if (hasBackup) MoveFileW(backupDir, dataDir);
        DeleteFileW(rNext); DeleteFileW(vNext); return -1;
    }

    // 验证
    WCHAR check[MAX_PATH];
    WCHAR wJoker[256];
    toWide(g_cfg.joker_exe, wJoker, 256);
    swprintf(check, MAX_PATH, L"%s\\%s", exeDir, wJoker);
    if (!fileExistsW(check)) {
        if (hasBackup) MoveFileW(backupDir, dataDir);
        DeleteFileW(rNext); DeleteFileW(vNext); return -1;
    }

    // ★ 恢复用户数据
    if (hasBackup) {
        removeDir(dataDir);
        MoveFileW(backupDir, dataDir);
    }

    writeLocalVersion(exeDir, newVer);
    DeleteFileW(rNext);
    DeleteFileW(vNext);

    g_pct = 100;
    setStatus("update applied", 0);
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    Sleep(200);
    return 0;
}

// ★ 后台解压线程 — 将 r.next 解压到 gh555.com-next/（不阻塞用户使用 IDE）
static unsigned __stdcall backgroundApplyUpdate(void *param) {
    InterlockedExchange(&g_applyRunning, 1);
    WCHAR *exeDir = (WCHAR *)param;

    WCHAR rNext[MAX_PATH], vNext[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", exeDir);
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", exeDir);

    if (!fileExistsW(rNext) || !fileExistsW(vNext)) {
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }

    char newVer[64] = {0};
    int rd = readFileText(vNext, newVer, sizeof(newVer));
    if (rd <= 0) { DeleteFileW(rNext); DeleteFileW(vNext); InterlockedExchange(&g_applyRunning, 0); return 0; }

    // 创建临时解压目录
    WCHAR tmpDir[MAX_PATH], ghNext[MAX_PATH];
    swprintf(tmpDir, MAX_PATH, L"%s\\_swap_tmp", exeDir);
    swprintf(ghNext, MAX_PATH, L"%s\\gh555.com-next", exeDir);

    removeDir(ghNext);
    removeDir(tmpDir);
    CreateDirectoryW(tmpDir, NULL);

    // 解压 r.next → tmpDir
    WCHAR cmdLine[1024];
    swprintf(cmdLine, 1024, L"\"%s\" -y", rNext);
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {0};
    if (!CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
        CREATE_NO_WINDOW, NULL, tmpDir, &si, &pi)) {
        removeDir(tmpDir);
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD ec = 0;
    GetExitCodeProcess(pi.hProcess, &ec);
    CloseHandle(pi.hProcess);

    if (ec != 0) { removeDir(tmpDir); InterlockedExchange(&g_applyRunning, 0); return 0; }

    // 移出解压出的 gh555.com → gh555.com-next
    WCHAR extractedGh[MAX_PATH];
    swprintf(extractedGh, MAX_PATH, L"%s\\gh555.com", tmpDir);
    if (!fileExistsW(extractedGh)) {
        removeDir(tmpDir);
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }

    if (!MoveFileW(extractedGh, ghNext)) {
        removeDir(tmpDir); removeDir(ghNext);
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }
    removeDir(tmpDir);

    // 写版本号
    WCHAR vPath[MAX_PATH];
    swprintf(vPath, MAX_PATH, L"%s\\.version", ghNext);
    writeFileText(vPath, newVer);

    // 写 .swap-ready → 下次启动原子交换
    WCHAR swapReady[MAX_PATH];
    swprintf(swapReady, MAX_PATH, L"%s\\.swap-ready", exeDir);
    writeFileText(swapReady, newVer);

    // 清理暂存文件
    DeleteFileW(rNext);
    DeleteFileW(vNext);

    InterlockedExchange(&g_applyRunning, 0);

    // 通知主线程：如果启动器已隐藏，可以关闭了
    if (g_hwnd) PostMessageW(g_hwnd, WM_USER + 1, 0, 0);

    return 0;
}

// ── 后台更新线程 ──
static unsigned __stdcall backgroundUpdateProc(void *param) {
    InterlockedExchange(&g_updateRunning, 1);

    char serverVer[64] = {0};
    int len = downloadToString(g_cfg.update_host, g_cfg.latest_path,
        serverVer, sizeof(serverVer), g_cfg.use_https);
    if (len <= 0 && g_cfg.use_https) {
        len = downloadToString(g_cfg.update_host, g_cfg.latest_path,
            serverVer, sizeof(serverVer), 0);
    }
    if (len <= 0) { InterlockedExchange(&g_updateRunning, 0); return 0; }

    char *nl = strchr(serverVer, '\n'); if (nl) *nl = '\0';
    nl = strchr(serverVer, '\r'); if (nl) *nl = '\0';
    while (len > 0 && (serverVer[len-1] == ' ' || serverVer[len-1] == '\t')) serverVer[--len] = '\0';
    if (len == 0) { InterlockedExchange(&g_updateRunning, 0); return 0; }

    char localVer[64] = {0};
    int localLen = readLocalVersion(g_exeDir, localVer, sizeof(localVer));
    if (localLen > 0 && strcmp(localVer, serverVer) == 0) {
        InterlockedExchange(&g_updateRunning, 0); return 0;
    }

    // 下载到暂存
    WCHAR rNext[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", g_exeDir);
    DeleteFileW(rNext);

    int result = downloadFile(g_cfg.update_host, g_cfg.r_path, rNext, g_cfg.use_https);
    if (result != 0 && g_cfg.use_https) {
        DeleteFileW(rNext);
        result = downloadFile(g_cfg.update_host, g_cfg.r_path, rNext, 0);
    }
    if (result != 0) { DeleteFileW(rNext); InterlockedExchange(&g_updateRunning, 0); return 0; }

    // 写 .version-next
    WCHAR vNext[MAX_PATH];
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", g_exeDir);
    writeFileText(vNext, serverVer);

    InterlockedExchange(&g_updateRunning, 0);
    return 0;
}

// ═══════════════════════════════════════════════════════════════
// 窗口 + 启动
// ═══════════════════════════════════════════════════════════════

static void centerWindow(HWND hwnd) {
    RECT rc; GetWindowRect(hwnd, &rc);
    int sw = GetSystemMetrics(SM_CXSCREEN);
    int sh = GetSystemMetrics(SM_CYSCREEN);
    int x = (sw - (rc.right - rc.left)) / 2;
    int y = (sh - (rc.bottom - rc.top)) / 2 - 40;
    SetWindowPos(hwnd, NULL, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
}

static int launchCore(void) {
    WCHAR exePath[MAX_PATH], exeDir[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);
    wcscpy(exeDir, exePath);
    WCHAR *p = wcsrchr(exeDir, L'\\');
    if (p) *p = L'\0';

    WCHAR corePath[MAX_PATH];
    WCHAR wJoker[256];
    toWide(g_cfg.joker_exe, wJoker, 256);
    swprintf(corePath, MAX_PATH, L"%s\\%s", exeDir, wJoker);

    if (GetFileAttributesW(corePath) == INVALID_FILE_ATTRIBUTES) {
        setStatus("joker.exe not found", 1);
        return -1;
    }

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {0};
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOW;

    if (!CreateProcessW(corePath, NULL, NULL, NULL, FALSE,
        0, NULL, exeDir, &si, &pi)) {
        char buf[64];
        snprintf(buf, sizeof(buf), "start fail (err=%lu)", GetLastError());
        setStatus(buf, 1);
        return -1;
    }
    CloseHandle(pi.hThread);
    g_hProcess = pi.hProcess;
    g_jokerPid = pi.dwProcessId;
    return 0;
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
    switch (msg) {
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        HBRUSH bg = CreateSolidBrush(COL_BG);
        RECT rc; GetClientRect(hwnd, &rc);
        FillRect(hdc, &rc, bg);
        DeleteObject(bg);
        SetBkMode(hdc, TRANSPARENT);

        // ★ 只显示 qqqide 标题 + 进度条 + 百分比
        HFONT hTitle = CreateFontW(28, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
            PROOF_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        HFONT hOld = (HFONT)SelectObject(hdc, hTitle);
        SetTextColor(hdc, COL_TITLE);
        RECT tr = {0, 55, WW, 105};
        DrawTextW(hdc, L"qqqide", -1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(hdc, hOld);
        DeleteObject(hTitle);

        RECT barBg = {60, 140, WW - 60, 148};
        HBRUSH hBarBg = CreateSolidBrush(COL_BAR_BG);
        FillRect(hdc, &barBg, hBarBg);
        DeleteObject(hBarBg);

        int barW = barBg.right - barBg.left;
        int fillW = (g_pct > 0) ? (barW * g_pct / 100) : 0;
        if (fillW > barW) fillW = barW;
        if (fillW > 0) {
            RECT barFg = {barBg.left, barBg.top, barBg.left + fillW, barBg.bottom};
            HBRUSH hBarFg = CreateSolidBrush(COL_BAR_FG);
            FillRect(hdc, &barFg, hBarFg);
            DeleteObject(hBarFg);
        }
        char pctText[16];
        snprintf(pctText, sizeof(pctText), "%d%%", g_pct);
        SetTextColor(hdc, COL_STATUS);
        RECT pr = {60, 152, WW - 60, 172};
        WCHAR wPct[16];
        MultiByteToWideChar(CP_UTF8, 0, pctText, -1, wPct, 16);
        DrawTextW(hdc, wPct, -1, &pr, DT_CENTER | DT_VCENTER);

        // 状态文字 — 仅内核更新时显示（普通启动 g_showStatusText=0）
        if (g_showStatusText && g_status[0]) {
            HFONT hStatus = CreateFontW(14, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                PROOF_QUALITY, DEFAULT_PITCH, L"Segoe UI");
            HFONT hOld2 = (HFONT)SelectObject(hdc, hStatus);
            SetTextColor(hdc, COL_STATUS);
            RECT sr = {40, 115, WW - 40, 135};
            WCHAR wStatus[128];
            MultiByteToWideChar(CP_UTF8, 0, g_status, -1, wStatus, 128);
            DrawTextW(hdc, wStatus, -1, &sr, DT_CENTER | DT_VCENTER);
            SelectObject(hdc, hOld2);
            DeleteObject(hStatus);
        }

        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_TIMER: {
        g_tickCount++;

        switch (g_phase) {
        case PHASE_INIT:
            if (g_tickCount >= 1) {
                g_pct = 0;
                g_phase = PHASE_LAUNCHING;
                if (launchCore() != 0) {
                    g_phase = PHASE_ERROR;
                    g_closeCountdown = ERROR_CLOSE_TICKS;
                }
            }
            break;

        case PHASE_LAUNCHING:
            if (!g_hUpdateThread) {
                g_hUpdateThread = (HANDLE)_beginthreadex(NULL, 0, backgroundUpdateProc, NULL, 0, NULL);
            }
            // ★ 后台解压 r.next → gh555.com-next/（不阻塞，用户已在 IDE 中工作）
            if (!g_hApplyThread) {
                WCHAR rNextPath[MAX_PATH];
                swprintf(rNextPath, MAX_PATH, L"%s\\r.next", g_exeDir);
                if (fileExistsW(rNextPath)) {
                    g_hApplyThread = (HANDLE)_beginthreadex(NULL, 0, backgroundApplyUpdate, g_exeDir, 0, NULL);
                }
            }
            if (g_tickCount <= 20 && g_tickCount % 4 == 0 && g_pct < 60) {
                g_pct += 8;
            }
            if (g_tickCount >= 6) {
                g_phase = PHASE_WAITING;
            }
            break;

        case PHASE_WAITING: {
            // ★ 核心：检测 joker.exe 的主窗口是否出现
            int applyBusy = (InterlockedCompareExchange(&g_applyRunning, 0, 0) != 0);

            // 方式1：通过 PID 查找 joker 的可见窗口
            if (g_jokerPid != 0) {
                HWND jwnd = findJokerMainWindow(g_jokerPid);
                if (jwnd != NULL) {
                    if (applyBusy) {
                        // 后台还在解压 → 隐藏窗口，进程继续跑
                        ShowWindow(hwnd, SW_HIDE);
                    } else {
                        g_phase = PHASE_DONE;
                        PostMessageW(hwnd, WM_CLOSE, 0, 0);
                        return 0;
                    }
                }
            }

            // 方式2：loading-status 兜底（"ready" 信号）
            if (!applyBusy) {
                WCHAR candidates[2][MAX_PATH];
                WCHAR myDir[MAX_PATH];
                GetModuleFileNameW(NULL, myDir, MAX_PATH);
                WCHAR *slash = wcsrchr(myDir, L'\\');
                if (slash) *slash = L'\0';
                swprintf(candidates[0], MAX_PATH, L"%s\\gh555.com\\loading-status", myDir);
                swprintf(candidates[1], MAX_PATH, L"%s\\loading-status", myDir);
                for (int ci = 0; ci < 2; ci++) {
                    char buf[256] = {0};
                    int rd = readFileText(candidates[ci], buf, sizeof(buf));
                    if (rd > 0 && strcmp(buf, "ready") == 0) {
                        g_phase = PHASE_DONE;
                        PostMessageW(hwnd, WM_CLOSE, 0, 0);
                        return 0;
                    }
                    if (rd > 0) {
                        char *pipe2 = strchr(buf, '|');
                        if (pipe2) {
                            *pipe2 = '\0';
                            int p = atoi(buf);
                            if (p > g_pct && p <= 100) g_pct = p;
                        }
                    }
                }
            }

            // 方式3：joker.exe 进程退出 → 关闭
            if (g_hProcess) {
                DWORD ec = 0;
                if (GetExitCodeProcess(g_hProcess, &ec) && ec != STILL_ACTIVE) {
                    g_phase = PHASE_ERROR;
                    g_closeCountdown = ERROR_CLOSE_TICKS;
                }
            }

            // 方式4：超时 30s → joker 还在跑就静默关闭（仅当无后台任务时）
            if (g_tickCount >= 120 && g_phase == PHASE_WAITING) {
                if (!applyBusy) {
                    if (g_hProcess) {
                        DWORD ec = 0;
                        if (GetExitCodeProcess(g_hProcess, &ec) && ec == STILL_ACTIVE) {
                            g_phase = PHASE_DONE;
                            PostMessageW(hwnd, WM_CLOSE, 0, 0);
                            return 0;
                        }
                    }
                    g_phase = PHASE_ERROR;
                    g_closeCountdown = ERROR_CLOSE_TICKS;
                }
            }
            break;
        }

        case PHASE_ERROR:
            if (g_closeCountdown > 0) {
                g_closeCountdown--;
                if (g_closeCountdown == 0) {
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    return 0;
                }
            }
            break;

        case PHASE_DONE:
            break;
        }
        InvalidateRect(hwnd, NULL, TRUE);
        return 0;
    }

    case WM_LBUTTONDOWN:
        SendMessage(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
        return 0;

    case WM_USER + 1:
        // ★ 后台解压完成 → 如果窗口已隐藏，关闭进程
        if (!IsWindowVisible(hwnd)) {
            g_phase = PHASE_DONE;
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        return 0;

    default:
        return DefWindowProcW(hwnd, msg, w, l);
    }
}

// ═══════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════

int WINAPI WinMain(HINSTANCE hi, HINSTANCE, LPSTR, int nShow) {
    INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&icc);

    const WCHAR CLASS[] = L"QqqIdeLauncher";
    WNDCLASSEXW wc = {
        .cbSize        = sizeof(wc),
        .style         = CS_HREDRAW | CS_VREDRAW,
        .lpfnWndProc   = WndProc,
        .hInstance     = hi,
        .hCursor       = LoadCursor(NULL, IDC_ARROW),
        .hbrBackground = NULL,
        .lpszClassName = CLASS,
    };
    if (!RegisterClassExW(&wc)) return 1;

    // ★ 检测僵尸窗口：如果已有启动器窗口，强杀后重启
    HWND existing = FindWindowW(CLASS, NULL);
    if (existing) {
        PostMessageW(existing, WM_CLOSE, 0, 0);
        for (int i = 0; i < 20; i++) {
            Sleep(100);
            if (!IsWindow(existing)) break;
        }
        if (IsWindow(existing)) {
            DWORD pid = 0;
            GetWindowThreadProcessId(existing, &pid);
            if (pid != GetCurrentProcessId()) {
                HANDLE hp = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
                if (hp) { TerminateProcess(hp, 0); CloseHandle(hp); }
            }
            DestroyWindow(existing);
        }
        // 不 return — 继续正常启动
    }

    g_hwnd = CreateWindowExW(0, CLASS, L"qqqide",
        WS_POPUP | WS_BORDER, 0, 0, WW, WH, NULL, NULL, hi, NULL);
    if (!g_hwnd) return 1;
    centerWindow(g_hwnd);

    // ── 确定工作目录 ──
    WCHAR myDir[MAX_PATH];
    GetModuleFileNameW(NULL, myDir, MAX_PATH);
    WCHAR *s = wcsrchr(myDir, L'\\');
    if (s) *s = L'\0';
    wcscpy(g_exeDir, myDir);

    // ★ 加载配置（缓存 → 服务器 → 默认值）
    //   注意：服务器拉取在这里做（启动前），因为需要 host/path 等配置。
    //   但网络失败不阻塞——缓存或默认值兜底。
    loadConfig(myDir);

    // ── 检查 joker.exe ──
    WCHAR jokerPath[MAX_PATH];
    WCHAR wJoker[256];
    toWide(g_cfg.joker_exe, wJoker, 256);
    swprintf(jokerPath, MAX_PATH, L"%s\\%s", myDir, wJoker);
    int jokerExists = fileExistsW(jokerPath);

    // ── 首次运行 / 恢复：joker.exe 不存在 → 解压 r ──
    if (!jokerExists) {
        ShowWindow(g_hwnd, SW_SHOW);
        UpdateWindow(g_hwnd);

        WCHAR rPath[MAX_PATH];
        WCHAR wFirstR[128];
        toWide(g_cfg.first_run_r, wFirstR, 128);
        swprintf(rPath, MAX_PATH, L"%s\\%s", myDir, wFirstR);

        if (!fileExistsW(rPath)) {
            // 本地无 r → 从服务器下载
            setStatus("downloading components…", 0);
            InvalidateRect(g_hwnd, NULL, TRUE);
            UpdateWindow(g_hwnd);
            pumpMessages();

            int dlRc = downloadFile(g_cfg.update_host, g_cfg.r_path, rPath, g_cfg.use_https);
            if (dlRc != 0 && g_cfg.use_https) {
                dlRc = downloadFile(g_cfg.update_host, g_cfg.r_path, rPath, 0);
            }
            if (dlRc != 0 || !fileExistsW(rPath)) {
                setStatus("download failed", 1);
            } else {
                if (extractPayload(rPath, myDir) == 0) {
                    g_pct = 100;
                    setStatus("ready", 0);
                    InvalidateRect(g_hwnd, NULL, TRUE);
                    UpdateWindow(g_hwnd);
                    Sleep(300);
                }
            }
        } else {
            if (extractPayload(rPath, myDir) == 0) {
                g_pct = 100;
                setStatus("ready", 0);
                InvalidateRect(g_hwnd, NULL, TRUE);
                UpdateWindow(g_hwnd);
                Sleep(300);
            }
        }
    } else {
        // ── 已安装 → 快速交换（如果有 .swap-ready）+ 清理残留 ──
        // ★ applySwapIfReady: 检测上次后台解压的 gh555.com-next，原子 rename（<1s）
        applySwapIfReady(myDir);

        ShowWindow(g_hwnd, SW_SHOW);
        UpdateWindow(g_hwnd);

        // 清理残留 r
        WCHAR rPath[MAX_PATH];
        WCHAR wFirstR[128];
        toWide(g_cfg.first_run_r, wFirstR, 128);
        swprintf(rPath, MAX_PATH, L"%s\\%s", myDir, wFirstR);
        for (int retry = 0; retry < 6; retry++) {
            if (!fileExistsW(rPath)) break;
            if (DeleteFileW(rPath)) break;
            Sleep(300);
        }
        if (fileExistsW(rPath)) MoveFileExW(rPath, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    }

    // 清除上次残留的 loading-status
    {
        WCHAR cleanPath[MAX_PATH];
        swprintf(cleanPath, MAX_PATH, L"%s\\gh555.com\\loading-status", myDir);
        DeleteFileW(cleanPath);
        swprintf(cleanPath, MAX_PATH, L"%s\\loading-status", myDir);
        DeleteFileW(cleanPath);
    }

    setStatus("starting…", 0);
    g_pct = 0;
    SetTimer(g_hwnd, 1, 250, NULL);
    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    // 清理
    if (g_hApplyThread) {
        DWORD waitResult = WaitForSingleObject(g_hApplyThread, 120000);
        if (waitResult == WAIT_TIMEOUT) TerminateThread(g_hApplyThread, 0);
        CloseHandle(g_hApplyThread);
    }
    if (g_hUpdateThread) {
        DWORD waitResult = WaitForSingleObject(g_hUpdateThread, 120000);
        if (waitResult == WAIT_TIMEOUT) TerminateThread(g_hUpdateThread, 0);
        CloseHandle(g_hUpdateThread);
    }
    {
        WCHAR rPath[MAX_PATH];
        WCHAR wFirstR[128];
        toWide(g_cfg.first_run_r, wFirstR, 128);
        swprintf(rPath, MAX_PATH, L"%s\\%s", g_exeDir, wFirstR);
        for (int i = 0; i < 3; i++) {
            if (!fileExistsW(rPath)) break;
            DeleteFileW(rPath);
            Sleep(300);
        }
        if (fileExistsW(rPath)) MoveFileExW(rPath, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    }
    if (g_hProcess) CloseHandle(g_hProcess);
    return 0;
}
