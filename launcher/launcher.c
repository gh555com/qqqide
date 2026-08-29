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
#include <winreg.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <process.h>
#include <tlhelp32.h>
#include <restartmanager.h>
#include <stdarg.h>
#include "ed25519.h"   // Ed25519 验签（2026-08-27，TweetNaCl 公有领域裁剪）

// ── WinHTTP redirect (MinGW headers may not define) ──
#ifndef WINHTTP_OPTION_REDIRECT_POLICY
#define WINHTTP_OPTION_REDIRECT_POLICY        88
#define WINHTTP_OPTION_REDIRECT_POLICY_NEVER   0
#define WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS  1
#endif

// ── WinHTTP TLS 1.2 — Win7 默认仅 TLS 1.0，现代 CDN 要求 1.2+ ──
#ifndef WINHTTP_OPTION_SECURE_PROTOCOLS
#define WINHTTP_OPTION_SECURE_PROTOCOLS 84
#endif
#ifndef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1
#define WINHTTP_FLAG_SECURE_PROTOCOL_TLS1  0x00000080
#endif
#ifndef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_1
#define WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_1 0x00000200
#endif
#ifndef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2
#define WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 0x00000800
#endif

// 启用 TLS 1.0/1.1/1.2（Win7 需 KB3140245 才完整支持 1.2；低版本系统忽略不支持的协议标志）
static void enableTls12(HINTERNET hRequest) {
    DWORD protos = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1 |
                   WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_1 |
                   WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_SECURE_PROTOCOLS, &protos, sizeof(protos));
}

// ── 窗口常量 ──
#define WW 420
#define WH 240

// ── 启动器自身版本（2026-08-10 重构: 版本 = versions.json 清单编号）──
//   pack.js 读取此常量写入 versions.json 的 launcher 字段（精确矩阵的一员）。
//   启动器版本变更只能随 r 分发（launcher-next.exe 三明治替换）。
#define LAUNCHER_VERSION "20260828.1"

// ── Ed25519 验证公钥（2026-08-27 签名验证安全防线）──
//   唯一硬编码信任根: 服务器一切下载物（r / units.json）必须带此公钥可验证的签名。
//   私钥离线加密保管（gaea/cf/qqqide/keys/sign_key.bin + 口令），公钥随启动器二进制分发。
//   攻击者入侵 CDN/发布流程无私钥 = 造不出合法签名 = 投毒被拒。
static const u8 SIGN_PUBKEY[32] = {
    0x82, 0xa6, 0x1e, 0x3a, 0xe4, 0xd3, 0x0b, 0x47, 0x01, 0x5e, 0xf6, 0x52, 0xb6, 0x87, 0x84, 0x15,
    0xb2, 0x13, 0xc2, 0x5b, 0x27, 0x2d, 0xb7, 0xdd, 0x05, 0x07, 0xbf, 0xc4, 0xdd, 0xc3, 0x94, 0x6d
};

// ── 颜色（Solarized Light） ──
#define COL_BG      RGB(0xfd, 0xf6, 0xe3)
#define COL_TITLE   RGB(0x07, 0x36, 0x42)
#define COL_STATUS  RGB(0x58, 0x6e, 0x75)
#define COL_DOT     RGB(0x85, 0x99, 0x00)
#define COL_ERR     RGB(0xdc, 0x32, 0x2f)
#define COL_BAR_BG  RGB(0xee, 0xe8, 0xd5)
#define COL_BAR_FG  RGB(0xe6, 0x9f, 0x00)  // 橙黄（原 0xcb4b16 偏红）

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
    char units_path[256];
    int  units_enabled;
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
    "/dl/qqqide-up/units.json",
    1,  // units_enabled — 单元增量传输（B 方案），失败自动回退全量 r
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


static HWND    g_hwnd           = NULL;
static HANDLE  g_hProcess       = NULL;
static DWORD   g_jokerPid       = 0;
static HANDLE  g_hUpdateThread  = NULL;
static volatile LONG g_updateRunning = 0;
static HANDLE  g_hApplyThread   = NULL;
static volatile LONG g_applyRunning  = 0;
static int     g_applyLaunches  = 0;
static WCHAR   g_exeDir[MAX_PATH] = {0};
static int     g_tickCount      = 0;
static int     g_closeCountdown = 0;

// ═══════════════════════════════════════════════════════════════
// Q 记录 — 系统环境变量兜底 Python 路径（每次启动重写，仅维护一条）
// ═══════════════════════════════════════════════════════════════

static void writeQRecord(const WCHAR *exeDir) {
    WCHAR pyDir[MAX_PATH];
    // 打包模式: gh555.com\resources\app\engines\python
    swprintf(pyDir, MAX_PATH, L"%s\\gh555.com\\resources\\app\\engines\\python", exeDir);
    // dev 模式(无 gh555.com): 项目根 engines\python
    if (GetFileAttributesW(pyDir) == INVALID_FILE_ATTRIBUTES) {
        swprintf(pyDir, MAX_PATH, L"%s\\engines\\python", exeDir);
    }

    // ★ 同步本进程环境（joker/python 子进程继承）——父 shell 传入的陈旧值不污染进程树
    SetEnvironmentVariableW(L"QQQIDE_PYTHON_DIR", pyDir);

    HKEY hkey;
    LONG rc = RegOpenKeyExW(HKEY_CURRENT_USER, L"Environment", 0, KEY_SET_VALUE, &hkey);
    if (rc != ERROR_SUCCESS) {
        rc = RegCreateKeyExW(HKEY_CURRENT_USER, L"Environment", 0, NULL,
            REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &hkey, NULL);
        if (rc != ERROR_SUCCESS) return;
    }
    RegSetValueExW(hkey, L"QQQIDE_PYTHON_DIR", 0, REG_SZ,
        (BYTE*)pyDir, (DWORD)((wcslen(pyDir) + 1) * sizeof(WCHAR)));
    RegCloseKey(hkey);

    // 广播变更，使 Explorer / 新 cmd 立即感知
    SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0,
        (LPARAM)L"Environment", SMTO_ABORTIFHUNG, 5000, NULL);
}

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

// ── 进程名检测（用于交换守卫：joker 在跑绝不动 gh555.com 目录）──
static int isProcessRunning(const WCHAR *name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    int found = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, name) == 0) { found = 1; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return found;
}

// ── 把已运行的 joker 主窗口带到前台（单实例兜底，防双开）──
static void bringJokerToFront(const WCHAR *name) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, name) == 0) {
                HWND w = findJokerMainWindow(pe.th32ProcessID);
                if (w) {
                    ShowWindow(w, SW_RESTORE);
                    SetForegroundWindow(w);
                    break;
                }
            }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
}

static void pumpMessages(void) {
    MSG m;
    while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
}

// 原始读取（保留换行，供 JSON 解析；readFileText 会截断到首行）
static int readFileRaw(const WCHAR *path, char *buf, int bufSize) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD rd = 0;
    ReadFile(h, buf, bufSize - 1, &rd, NULL);
    CloseHandle(h);
    if (rd == 0) return 0;
    buf[rd] = '\0';
    return (int)rd;
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

// ═══════════════════════════════════════════════════════════════
// ★ 交换/更新日志（2026-08-10）: gh555.com/Data/launcher-swap.log
//   记录交换/解压/下载/增量装配每一步（含 GetLastError）——
//   「卡版本/更新无反应」时一眼定位根因（F44 事故：交换失败无任何痕迹）。
//   - 日志在用户 Data 内 → 随交换备份恢复、跨更新保留
//   - 上限 256KB 超限重置（保留最新）；日志失败静默，绝不阻塞更新主流程
//   - 交换中途 Data 路径漂移（→Data.backup）→ 落盘按可达性探测：
//     gh555.com\Data → Data.backup → 包根（gh555.com-old\Data 不写，会被删除丢日志）
// ═══════════════════════════════════════════════════════════════
#define SWAP_LOG_MAX (256 * 1024)

static int swapLogWriteTo(const WCHAR *path, const char *line) {
    // 超限重置（保留最新日志）
    HANDLE hq = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hq != INVALID_HANDLE_VALUE) {
        LARGE_INTEGER sz;
        if (GetFileSizeEx(hq, &sz) && sz.QuadPart > SWAP_LOG_MAX) {
            CloseHandle(hq);
            DeleteFileW(path);
        } else {
            CloseHandle(hq);
        }
    }
    HANDLE h = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD wr = 0;
    WriteFile(h, line, (DWORD)strlen(line), &wr, NULL);
    CloseHandle(h);
    return 1;
}

// 落盘：gh555.com\Data → Data.backup → 包根，逐路径尝试（包根恒可写）
static void swapLogPersist(const WCHAR *exeDir, const char *line) {
    WCHAR paths[3][MAX_PATH];
    swprintf(paths[0], MAX_PATH, L"%s\\gh555.com\\Data\\launcher-swap.log", exeDir);
    swprintf(paths[1], MAX_PATH, L"%s\\Data.backup\\launcher-swap.log", exeDir);
    swprintf(paths[2], MAX_PATH, L"%s\\launcher-swap.log", exeDir);
    for (int i = 0; i < 3; i++) {
        WCHAR dir[MAX_PATH];
        wcsncpy(dir, paths[i], MAX_PATH - 1); dir[MAX_PATH - 1] = L'\0';
        WCHAR *slash = wcsrchr(dir, L'\\');
        if (slash) { *slash = L'\0'; CreateDirectoryW(dir, NULL); }
        if (swapLogWriteTo(paths[i], line)) return;
    }
}

static void swapLogLine(char *line, int lineSize, const char *fmt, va_list ap) {
    SYSTEMTIME st;
    GetLocalTime(&st);
    int off = snprintf(line, lineSize, "[%04d-%02d-%02dT%02d:%02d:%02d] ",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    if (off < 0 || off >= lineSize) off = 0;
    vsnprintf(line + off, lineSize - off, fmt, ap);
    int n = (int)strlen(line);
    if (n > 0 && line[n - 1] != '\n' && n < lineSize - 1) { line[n] = '\n'; line[n + 1] = '\0'; }
}

// 直接落盘（后台线程：下载/解压/增量装配）
static void swapLogNow(const WCHAR *exeDir, const char *fmt, ...) {
    char line[1024];
    va_list ap;
    va_start(ap, fmt);
    swapLogLine(line, sizeof(line), fmt, ap);
    va_end(ap);
    swapLogPersist(exeDir, line);
}

// 内存累积（applySwapIfReady：交换中途 Data 路径漂移，函数尾统一落盘保证日志完整）
static void swapLogAppend(char *buf, int bufSize, const char *fmt, ...) {
    int len = (int)strlen(buf);
    if (len >= bufSize - 512) return;
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    swapLogLine(line, sizeof(line), fmt, ap);
    va_end(ap);
    strncat(buf, line, bufSize - strlen(buf) - 1);
}

static void swapLogFlush(const WCHAR *exeDir, const char *buf) {
    if (!buf || !buf[0]) return;
    swapLogPersist(exeDir, buf);
}

// ★ 唯一版本权威（2026-08-10 重构）：versions.json 的 "id" 字段 = 清单编号。
//   版本 = 精确组件矩阵（launcher/shell/webapp/rank），随 r 冻结分发，任何组件升降级
//   只能换 r。旧 .version 文件已废弃（过渡期仅由 pack.js 为旧启动器双写）。
static int parseJsonString(const char **p, char *out, int outSize); // 前置声明（定义在后）

// 从任意路径的 versions.json 提取 "id" 字段（live 与 next 共用）
static int readManifestIdFile(const WCHAR *vPath, char *verBuf, int bufSize) {
    char json[4096];
    int len = readFileRaw(vPath, json, sizeof(json));
    if (len <= 0) return 0;
    const char *p = strstr(json, "\"id\"");
    if (!p) return 0;
    p += 4;                       // 跳过 "id"
    while (*p && *p != ':') p++;  // 到冒号
    if (*p != ':') return 0;
    p++;
    if (!parseJsonString(&p, verBuf, bufSize)) return 0;
    return (int)strlen(verBuf) > 0;
}

static int readLocalVersion(const WCHAR *exeDir, char *verBuf, int bufSize) {
    WCHAR vPath[MAX_PATH];
    swprintf(vPath, MAX_PATH, L"%s\\gh555.com\\versions.json", exeDir);
    return readManifestIdFile(vPath, verBuf, bufSize);
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
        } else if (strcmp(key, "units_path") == 0) {
            skipWhitespace(&p); parseJsonString(&p, cfg->units_path, sizeof(cfg->units_path));
        } else if (strcmp(key, "units_enabled") == 0) {
            parseJsonBool(&p, &cfg->units_enabled);
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
    enableTls12(hRequest);

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

    enableTls12(hRequest);

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

    enableTls12(hRequest);

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

// ── Ed25519 签名验证工具（2026-08-27 安全防线）──────────────────
//   读取文件全部内容（上限 512MB，覆盖 r 载荷尺寸）
static u8 *readFileAlloc(const WCHAR *path, size_t *outLen) {
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return NULL;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(h, &sz) || sz.QuadPart <= 0 || sz.QuadPart > 512LL * 1024 * 1024) {
        CloseHandle(h); return NULL;
    }
    u8 *buf = (u8 *)malloc((size_t)sz.QuadPart);
    if (!buf) { CloseHandle(h); return NULL; }
    DWORD rd = 0, total = 0;
    while (total < (DWORD)sz.QuadPart) {
        if (!ReadFile(h, buf + total, (DWORD)sz.QuadPart - total, &rd, NULL) || rd == 0) {
            free(buf); CloseHandle(h); return NULL;
        }
        total += rd;
    }
    CloseHandle(h);
    *outLen = (size_t)sz.QuadPart;
    return buf;
}

// 内存验签: data + 64B 签名 + 内嵌公钥。返回 0 = 有效
// ★ m 与 sm 必须不重叠（TweetNaCl crypto_sign_open 会向 m 写 R||pk 中间态，
//   同址时覆盖 sm 的 S 段 → 验证恒失败，2026-08-27 实锤）
static int verifySignedBuf(const u8 *data, size_t dataLen, const u8 *sig, int sigLen) {
    if (!data || sigLen != 64 || dataLen == 0) return -1;
    u8 *sm = (u8 *)malloc(dataLen + 64);
    if (!sm) return -1;
    u8 *m = (u8 *)malloc(dataLen);
    if (!m) { free(sm); return -1; }
    memcpy(sm, sig, 64);
    memcpy(sm + 64, data, dataLen);
    u64 mlen = 0;
    int rc = crypto_sign_open(m, &mlen, sm, dataLen + 64, SIGN_PUBKEY);
    free(m);
    free(sm);
    return rc == 0 ? 0 : -1;
}

// 文件验签: filePath 内容 + sigPath 64B 签名。返回 0 = 有效
static int verifySignedFile(const WCHAR *filePath, const WCHAR *sigPath) {
    u8 sig[64];
    if (readFileRaw(sigPath, (char *)sig, sizeof(sig)) != 64) return -1;
    size_t dataLen = 0;
    u8 *data = readFileAlloc(filePath, &dataLen);
    if (!data) return -1;
    int rc = verifySignedBuf(data, dataLen, sig, 64);
    free(data);
    return rc;
}

// 文件 sha512 hex（128 字符小写）
static void sha512FileHex(const WCHAR *path, char *hexOut) {
    size_t len = 0;
    u8 *data = readFileAlloc(path, &len);
    hexOut[0] = '\0';
    if (!data) return;
    u8 h[64];
    crypto_hash(h, data, len);
    free(data);
    for (int i = 0; i < 64; i++) sprintf(hexOut + i * 2, "%02x", h[i]);
    hexOut[128] = '\0';
}

// 文件 sha512 与期望 hex 比对。返回 1 = 匹配
static int fileSha512Matches(const WCHAR *path, const char *expectedHex) {
    char actual[129];
    sha512FileHex(path, actual);
    return actual[0] != '\0' && _stricmp(actual, expectedHex) == 0;
}

// ═══════════════════════════════════════════════════════════════
// 更新逻辑（参数全部来自 g_cfg）
// ═══════════════════════════════════════════════════════════════

// ★ 语义版本比较（2026-08-09 防反向升级修复）: 按数字段比较 "0.2.335" vs "0.2.332"
//   返回 1=a>b, 0=a==b, -1=a<b；非数字字符按 0 计；任一侧空 → 相等（保守，防降级）
static int compareVersion(const char *a, const char *b) {
    if (!a || !b) return 0;
    while (*a || *b) {
        long na = 0, nb = 0;
        while (*a && *a != '.') { if (*a >= '0' && *a <= '9') na = na * 10 + (*a - '0'); a++; }
        while (*b && *b != '.') { if (*b >= '0' && *b <= '9') nb = nb * 10 + (*b - '0'); b++; }
        if (na != nb) return na > nb ? 1 : -1;
        if (*a) a++;
        if (*b) b++;
    }
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


// ★ 启动器自替换（三明治）: gh555.com/launcher-next.exe → 根 qqqide.exe
//   运行中 exe 可 rename 不可 overwrite → 先改名旧 → 复制新 → 下次启动用新版。
//   失败（AV 锁等）→ 保留 launcher-next.exe，每次启动重试直到成功
//   （防启动器与载荷永久版本分裂）；next 与现运行 exe 内容相同 → 跳过并清理。
static int filesEqualW(const WCHAR *a, const WCHAR *b) {
    HANDLE ha = CreateFileW(a, GENERIC_READ, FILE_SHARE_READ, NULL,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (ha == INVALID_HANDLE_VALUE) return 0;
    HANDLE hb = CreateFileW(b, GENERIC_READ, FILE_SHARE_READ, NULL,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hb == INVALID_HANDLE_VALUE) { CloseHandle(ha); return 0; }
    LARGE_INTEGER sa, sb;
    int same = 0;
    if (GetFileSizeEx(ha, &sa) && GetFileSizeEx(hb, &sb) && sa.QuadPart == sb.QuadPart) {
        char bufa[65536], bufb[65536];
        same = 1;
        for (;;) {
            DWORD ra = 0, rb = 0;
            BOOL oka = ReadFile(ha, bufa, sizeof(bufa), &ra, NULL);
            BOOL okb = ReadFile(hb, bufb, sizeof(bufb), &rb, NULL);
            if (!oka || !okb || ra != rb || (ra > 0 && memcmp(bufa, bufb, ra) != 0)) { same = 0; break; }
            if (ra == 0) break;
        }
    }
    CloseHandle(ha); CloseHandle(hb);
    return same;
}

static void tryLauncherSelfReplace(const WCHAR *exeDir) {
    WCHAR newLauncher[MAX_PATH], oldLauncher[MAX_PATH], rootLauncher[MAX_PATH];
    swprintf(newLauncher, MAX_PATH, L"%s\\gh555.com\\launcher-next.exe", exeDir);
    if (!fileExistsW(newLauncher)) return;
    swprintf(oldLauncher, MAX_PATH, L"%s\\qqqide.old.exe", exeDir);
    swprintf(rootLauncher, MAX_PATH, L"%s\\qqqide.exe", exeDir);
    if (filesEqualW(newLauncher, rootLauncher)) {
        DeleteFileW(newLauncher);   // 已是同版启动器 → 无需替换
        return;
    }
    DeleteFileW(oldLauncher);
    if (MoveFileW(rootLauncher, oldLauncher)) {
        if (CopyFileW(newLauncher, rootLauncher, FALSE)) {
            DeleteFileW(oldLauncher);
            DeleteFileW(newLauncher);
        } else {
            // 复制失败 → 恢复旧启动器，绝不丢失入口；next 保留，下次启动重试
            MoveFileW(oldLauncher, rootLauncher);
        }
    }
    // MoveFileW 失败（AV 锁运行中 exe）→ 保留 newLauncher，下次启动重试
}

// ★ 交换前清场（2026-08-14）: 枚举全系统进程，可执行文件路径位于本包内（exeDir\ 前缀）
//   的一律 TerminateProcess——py-broker / goods / ghrun 崩溃残留的 cwd 或映像句柄会锁死
//   gh555.com 目录 → 交换 rename 必失败。路径前缀精确判定，绝不误杀他包/系统进程。
static void killStalePackProcesses(const WCHAR *exeDir) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return;
    DWORD selfPid = GetCurrentProcessId();
    size_t dirLen = wcslen(exeDir);
    int killed = 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == 0 || pe.th32ProcessID == selfPid) continue;
            HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
            if (!h) continue;
            WCHAR imgPath[MAX_PATH];
            DWORD sz = MAX_PATH;
            if (QueryFullProcessImageNameW(h, 0, imgPath, &sz) &&
                dirLen > 0 && _wcsnicmp(imgPath, exeDir, dirLen) == 0 &&
                imgPath[dirLen] == L'\\') {
                TerminateProcess(h, 0);
                WaitForSingleObject(h, 2000);
                killed++;
            }
            CloseHandle(h);
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    if (killed > 0) Sleep(800);   // 等全部映像/目录句柄释放
}

// ★ 轮换旧槽（2026-08-14）: gh555.com-old 被占用删不掉 → 下次交换改用 -1/-2/-3 槽。
//   旧垃圾永不阻塞后续升级（客户 332 卡升级同源事故）。cleanup 每启动清全部槽。
static void oldSlotPath(const WCHAR *exeDir, int idx, WCHAR *out, int cap) {
    if (idx == 0) swprintf(out, cap, L"%s\\gh555.com-old", exeDir);
    else swprintf(out, cap, L"%s\\gh555.com-old-%d", exeDir, idx);
}
static int findFreeOldSlot(const WCHAR *exeDir, WCHAR *out, int cap) {
    for (int i = 0; i < 100; i++) {
        WCHAR cand[MAX_PATH];
        oldSlotPath(exeDir, i, cand, MAX_PATH);
        if (!fileExistsW(cand)) { swprintf(out, cap, L"%s", cand); return 1; }
    }
    return 0;
}

// ★ 锁持有者诊断（2026-08-16）: swap 失败时用 Restart Manager 查出谁在锁 gh555.com，
//   进程名+PID 直接写进 swap 日志——「err=5 盲猜」时代终结。
static void logLockHolders(const WCHAR *dirPath, char *logBuf, int bufSize) {
    DWORD session = 0;
    WCHAR key[64] = L"qqqide-swap";
    if (RmStartSession(&session, 0, key) != ERROR_SUCCESS) return;
    LPCWSTR resources[] = { dirPath };
    if (RmRegisterResources(session, 1, resources, 0, NULL, 0, NULL) != ERROR_SUCCESS) {
        RmEndSession(session);
        return;
    }
    UINT nInfo = 16;
    UINT nInfoNeeded = 0;
    DWORD reason = 0;
    RM_PROCESS_INFO info[16];
    DWORD rc = RmGetList(session, &nInfoNeeded, &nInfo, info, &reason);
    if (rc == ERROR_SUCCESS && nInfo > 0) {
        for (UINT i = 0; i < nInfo && i < 16; i++) {
            char msg[256];
            snprintf(msg, sizeof(msg), "  lock-holder[%u]: pid=%lu app=%.60ls type=%lu",
                i, (unsigned long)info[i].Process.dwProcessId,
                info[i].strAppName, (unsigned long)info[i].ApplicationType);
            swapLogAppend(logBuf, bufSize, "%s", msg);
        }
    } else if (rc == ERROR_MORE_DATA) {
        swapLogAppend(logBuf, bufSize, "  lock-holders: >%u processes (truncated)", nInfo);
    }
    RmEndSession(session);
}

// ★ 终极兜底（2026-08-14，2026-08-16 去重）: rename 被 AV/残留占用锁死 → 注册
//   PendingFileRenameOperations。★ 去重守卫：已注册过（.pending-reboot 标记存在）
//   → 返回 2 跳过，防止注册表积压重复条目（16 组 = 16 次来回改名 → 重启连锁损坏安装）。
//   注册成功 → 写 .pending-reboot 标记，swap 成功/放弃时清除。
static int registerSwapPendingReboot(const WCHAR *exeDir, const WCHAR *ghDir, const WCHAR *ghOld, const WCHAR *ghNext) {
    WCHAR marker[MAX_PATH];
    swprintf(marker, MAX_PATH, L"%s\\.pending-reboot", exeDir);
    if (fileExistsW(marker)) return 2;
    DWORD flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_DELAY_UNTIL_REBOOT;
    if (!MoveFileExW(ghDir, ghOld, flags)) return 0;
    if (!MoveFileExW(ghNext, ghDir, flags)) return 0;
    writeFileText(marker, "1");
    return 1;
}

// ★ 旧槽 Data 救援（2026-08-14）: pending 执行后 / 异常中断后，用户 Data 可能躺在 old 槽里。
//   两步搬回（先移出出厂 Data 再改名，rename 到非空目录必失败）；任一步失败保留现场
//   下次启动重试；含 Data 的槽永不删除（数据零丢失）。
static int tryRestoreDataFromOldSlots(const WCHAR *exeDir, const WCHAR *ghDir, char *logBuf, int bufSize) {
    int done = 1;
    for (int i = 0; i < 100; i++) {
        WCHAR slot[MAX_PATH], slotData[MAX_PATH], dataDir[MAX_PATH], dataNew[MAX_PATH];
        oldSlotPath(exeDir, i, slot, MAX_PATH);
        if (!fileExistsW(slot)) continue;
        swprintf(slotData, MAX_PATH, L"%s\\Data", slot);
        if (!fileExistsW(slotData)) { removeDir(slot); continue; }
        swprintf(dataDir, MAX_PATH, L"%s\\Data", ghDir);
        swprintf(dataNew, MAX_PATH, L"%s\\Data.new", ghDir);
        if (fileExistsW(dataNew)) {
            // 上次搬回中断: Data.new 已就位 → 继续推进
            if (fileExistsW(dataDir) && !removeDir(dataDir)) { done = 0; continue; }
            if (!MoveFileW(dataNew, dataDir)) { done = 0; continue; }
            removeDir(slot);
            swapLogAppend(logBuf, bufSize, "data rescue: old-slot-%d Data -> gh555.com/Data", i);
            continue;
        }
        if (fileExistsW(dataDir)) {
            if (!MoveFileW(slotData, dataNew)) { done = 0; continue; }
            if (!removeDir(dataDir)) { done = 0; continue; }   // Data.new 保留，下次继续
            if (!MoveFileW(dataNew, dataDir)) { done = 0; continue; }
            removeDir(slot);
            swapLogAppend(logBuf, bufSize, "data rescue: old-slot-%d Data -> gh555.com/Data", i);
        } else {
            if (!MoveFileW(slotData, dataDir)) { done = 0; continue; }
            removeDir(slot);
            swapLogAppend(logBuf, bufSize, "data rescue: old-slot-%d Data -> gh555.com/Data", i);
        }
    }
    return done;
}

// ★ 快速交换：gh555.com-next → gh555.com（原子 rename，<1s）
// ★★ 铁律（2026-08-06）: joker 还在跑 → 绝不交换，保留 .swap-ready 等下次启动。
//    前台进程不可被更新杀灭；交换只在用户完全退出后、下次启动时发生。
// ★ 升级失败计数（2026-08-14）: 连续解压失败 ≥3 次 → 写 gh555.com/update-failed.txt
//   （壳层启动读此文件弹窗暴露，杜绝「无限静默循环」——客户 40 次循环实锤）。
//   任何成功（extract OK / swap OK / 幂等跳过）→ 清零。
static void applyFailMark(const WCHAR *exeDir) {
    WCHAR fPath[MAX_PATH];
    swprintf(fPath, MAX_PATH, L"%s\\.apply-fails", exeDir);
    char buf[32] = {0};
    int n = 0;
    if (readFileText(fPath, buf, sizeof(buf)) > 0) n = atoi(buf);
    n++;
    char nb[32];
    snprintf(nb, sizeof(nb), "%d", n);
    writeFileText(fPath, nb);
    if (n >= 3) {
        WCHAR markPath[MAX_PATH];
        swprintf(markPath, MAX_PATH, L"%s\\gh555.com\\update-failed.txt", exeDir);
        writeFileText(markPath, nb);
    }
}

static void applyFailClear(const WCHAR *exeDir) {
    WCHAR fPath[MAX_PATH], markPath[MAX_PATH];
    swprintf(fPath, MAX_PATH, L"%s\\.apply-fails", exeDir);
    swprintf(markPath, MAX_PATH, L"%s\\gh555.com\\update-failed.txt", exeDir);
    DeleteFileW(fPath);
    DeleteFileW(markPath);
}

static int applySwapIfReady(const WCHAR *exeDir) {
    char logBuf[4096] = {0};
    WCHAR swapReady[MAX_PATH];
    swprintf(swapReady, MAX_PATH, L"%s\\.swap-ready", exeDir);
    if (!fileExistsW(swapReady)) return 0;

    // 记录待交换版本（.swap-ready 内容 = 目标清单编号）与 live 版本
    char pendVer[64] = {0}, liveVer[64] = {0};
    readFileText(swapReady, pendVer, sizeof(pendVer));
    readLocalVersion(exeDir, liveVer, sizeof(liveVer));
    swapLogAppend(logBuf, sizeof(logBuf), "swap begin: pending=%s live=%s",
        pendVer[0] ? pendVer : "?", liveVer[0] ? liveVer : "?");

    WCHAR ghDir[MAX_PATH], ghOldSlot[MAX_PATH], ghNext[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);
    swprintf(ghNext, MAX_PATH, L"%s\\gh555.com-next", exeDir);
    ghOldSlot[0] = L'\0';

    // ★ 崩溃恢复（2026-08-06）: 上次交换中途失败 → gh555.com 缺失但 old 槽/Data.backup 残留
    //   先还原，杜绝「找不到 gh555.com」类故障。含 Data 的槽优先还原。
    {
        WCHAR dataDir[MAX_PATH], backupDir[MAX_PATH];
        swprintf(dataDir, MAX_PATH, L"%s\\Data", ghDir);
        swprintf(backupDir, MAX_PATH, L"%s\\Data.backup", exeDir);
        if (!fileExistsW(ghDir)) {
            WCHAR restoreSlot[MAX_PATH];
            restoreSlot[0] = L'\0';
            for (int pass = 0; pass < 2 && !restoreSlot[0]; pass++) {
                for (int i = 0; i < 100; i++) {
                    WCHAR slot[MAX_PATH], slotData[MAX_PATH];
                    oldSlotPath(exeDir, i, slot, MAX_PATH);
                    if (!fileExistsW(slot)) continue;
                    if (pass == 0) {
                        swprintf(slotData, MAX_PATH, L"%s\\Data", slot);
                        if (!fileExistsW(slotData)) continue;
                    }
                    swprintf(restoreSlot, MAX_PATH, L"%s", slot);
                    break;
                }
            }
            if (restoreSlot[0]) {
                if (!MoveFileW(restoreSlot, ghDir))
                    swapLogAppend(logBuf, sizeof(logBuf), "crash-recover: restore old-slot FAIL err=%lu", GetLastError());
            }
        }
        if (!fileExistsW(dataDir) && fileExistsW(backupDir)) {
            if (!MoveFileW(backupDir, dataDir))
                swapLogAppend(logBuf, sizeof(logBuf), "crash-recover: move Data.backup FAIL err=%lu", GetLastError());
        }
    }
    if (!fileExistsW(ghNext)) {
        // ★ pending 重启兜底完成检测（2026-08-14）: 交换已在重启时由 smss 执行完毕
        //   → live 已是目标版本，用户 Data 还躺在 old 槽里 → 搬回并收尾。
        //   其余半执行/未执行场景同样先救 Data（数据零丢失），再清标记。
        tryRestoreDataFromOldSlots(exeDir, ghDir, logBuf, sizeof(logBuf));
        swapLogAppend(logBuf, sizeof(logBuf), "swap abort: gh555.com-next missing (swap-ready cleared)");
        DeleteFileW(swapReady);
        { WCHAR prb[MAX_PATH]; swprintf(prb, MAX_PATH, L"%s\\.pending-reboot", exeDir); DeleteFileW(prb); }
        swapLogFlush(exeDir, logBuf);
        return 0;
    }

    // ★ 守卫 1: joker 正在运行（含旧实例残党）→ 放弃本次交换，等用户退出后下次启动
    if (isProcessRunning(L"joker.exe")) {
        swapLogAppend(logBuf, sizeof(logBuf), "swap deferred: joker.exe running");
        swapLogFlush(exeDir, logBuf);
        return 0;
    }

    // ★ 守卫 1b（2026-08-14）: 交换前精准杀光本包内残留进程（py-broker/goods/ghrun 崩溃残党
    //   的 cwd/映像句柄锁死目录 → rename 必失败）。只杀 exe 位于本包内的进程，零误伤。
    killStalePackProcesses(exeDir);

    // ★ 守卫 2: next 完整性最小校验（joker + versions.json + resources/app）→ 残缺版绝不交换
    //   versions.json = 唯一版本权威（清单编号 + 组件精确矩阵），缺失即判残缺。
    {
        WCHAR chk[MAX_PATH];
        swprintf(chk, MAX_PATH, L"%s\\joker.exe", ghNext);
        if (!fileExistsW(chk)) {
            swapLogAppend(logBuf, sizeof(logBuf), "swap abort: next incomplete (missing joker.exe)");
            DeleteFileW(swapReady);
            swapLogFlush(exeDir, logBuf);
            return 0;
        }
        swprintf(chk, MAX_PATH, L"%s\\versions.json", ghNext);
        if (!fileExistsW(chk)) {
            swapLogAppend(logBuf, sizeof(logBuf), "swap abort: next incomplete (missing versions.json)");
            DeleteFileW(swapReady);
            swapLogFlush(exeDir, logBuf);
            return 0;
        }
        swprintf(chk, MAX_PATH, L"%s\\resources\\app", ghNext);
        if (!fileExistsW(chk)) {
            swapLogAppend(logBuf, sizeof(logBuf), "swap abort: next incomplete (missing resources\\app)");
            DeleteFileW(swapReady);
            swapLogFlush(exeDir, logBuf);
            return 0;
        }
    }

    // ★ 防降级守卫（2026-08-14）: next 版本不严格高于 live → 放弃交换并清暂存。
    //   场景: 手动删 joker → 首次安装重建 live 到更新版 → 旧 .swap-ready+next 残留
    //   → 无此守卫会交换回旧版（反向降级）。
    {
        char nextVer[64] = {0};
        WCHAR nextVPath[MAX_PATH];
        swprintf(nextVPath, MAX_PATH, L"%s\\versions.json", ghNext);
        if (readManifestIdFile(nextVPath, nextVer, sizeof(nextVer)) > 0 &&
            liveVer[0] != '\0' && compareVersion(nextVer, liveVer) <= 0) {
            swapLogAppend(logBuf, sizeof(logBuf), "swap abort: next %s not newer than live %s (no downgrade)", nextVer, liveVer);
            DeleteFileW(swapReady);
            removeDir(ghNext);
            applyFailClear(exeDir);
            swapLogFlush(exeDir, logBuf);
            return 0;
        }
    }

    // ★ 保存用户数据
    WCHAR dataDir[MAX_PATH], backupDir[MAX_PATH];
    swprintf(dataDir, MAX_PATH, L"%s\\Data", ghDir);
    swprintf(backupDir, MAX_PATH, L"%s\\Data.backup", exeDir);
    removeDir(backupDir);
    int hasBackup = 0;
    if (fileExistsW(dataDir)) {
        hasBackup = (MoveFileW(dataDir, backupDir) != 0);
        if (!hasBackup) {
            // ★ 数据备份失败（AV/占用锁）→ 中止交换，绝不拿用户数据冒险
            //   （旧实现继续交换 → 新包 Data 覆盖用户账号数据 → 登出+偏好全丢）
            swapLogAppend(logBuf, sizeof(logBuf), "swap FAIL: backup user Data err=%lu (aborted, retry next boot)", GetLastError());
            swapLogFlush(exeDir, logBuf);
            return -1;
        }
    }

    // 原子交换（轮换槽: 旧槽被锁删不掉 → 用 -1/-2 新槽，旧垃圾永不阻塞升级）
    if (!findFreeOldSlot(exeDir, ghOldSlot, MAX_PATH)) {
        swapLogAppend(logBuf, sizeof(logBuf), "swap FAIL: no free old-slot");
        if (hasBackup) MoveFileW(backupDir, dataDir);
        swapLogFlush(exeDir, logBuf);
        return -1;
    }
    removeDir(ghOldSlot);
    if (!MoveFileW(ghDir, ghOldSlot)) {
        swapLogAppend(logBuf, sizeof(logBuf), "swap FAIL: move gh555.com -> old-slot err=%lu", GetLastError());
        // ★ 锁持有者诊断（2026-08-16）: 谁在锁目录？直接写进日志，终结盲猜
        logLockHolders(ghDir, logBuf, sizeof(logBuf));
        if (hasBackup) MoveFileW(backupDir, dataDir);   // 尽力还原，失败下次崩溃恢复救
        int prc = registerSwapPendingReboot(exeDir, ghDir, ghOldSlot, ghNext);
        if (prc == 1) {
            swapLogAppend(logBuf, sizeof(logBuf), "swap deferred to reboot: pending rename registered");
            swapLogFlush(exeDir, logBuf);
            return 0;
        } else if (prc == 2) {
            swapLogAppend(logBuf, sizeof(logBuf), "swap deferred to reboot: already pending (dedup)");
            swapLogFlush(exeDir, logBuf);
            return 0;
        }
        swapLogAppend(logBuf, sizeof(logBuf), "swap FAIL: pending rename register err=%lu (retry next boot)", GetLastError());
        swapLogFlush(exeDir, logBuf);
        return -1;
    }
    if (!MoveFileW(ghNext, ghDir)) {
        swapLogAppend(logBuf, sizeof(logBuf), "swap FAIL: move gh555.com-next -> gh555.com err=%lu", GetLastError());
        MoveFileW(ghOldSlot, ghDir);
        if (hasBackup) MoveFileW(backupDir, dataDir);
        swapLogFlush(exeDir, logBuf);
        return -1;
    }

    // ★ 恢复用户数据
    if (hasBackup) {
        removeDir(dataDir);
        if (!MoveFileW(backupDir, dataDir)) {
            // 数据仍在 Data.backup → 下次启动崩溃恢复段自动还原
            swapLogAppend(logBuf, sizeof(logBuf), "swap WARN: restore user Data FAIL err=%lu (data safe in Data.backup)", GetLastError());
        }
    }

    // ★ 自更新: gh555.com/launcher-next.exe → 根 qqqide.exe（三明治替换）
    //   失败保留 next，每次启动重试（防启动器永久分裂）
    tryLauncherSelfReplace(exeDir);

    // 旧槽删除失败只留垃圾（每启动重试），不影响本次升级——已由轮换槽机制兜底
    removeDir(ghOldSlot);
    DeleteFileW(swapReady);
    { WCHAR prb[MAX_PATH]; swprintf(prb, MAX_PATH, L"%s\\.pending-reboot", exeDir); DeleteFileW(prb); }
    swapLogAppend(logBuf, sizeof(logBuf), "swap OK: %s -> %s",
        liveVer[0] ? liveVer : "?", pendVer[0] ? pendVer : "?");
    swapLogFlush(exeDir, logBuf);
    applyFailClear(exeDir);
    return 1;
}


// ★ 根目录自清洁（2026-08-10）: 包根只留 LICENSE / qqqide.exe / gh555.com
//   删除启动器自己产生的一切临时产物，包根永不累积垃圾。
//   - 保留: LICENSE / qqqide.exe / gh555.com
//   - 挂起更新保留: .swap-ready + gh555.com-next（joker 还在跑→交换被推迟，绝不能丢）
//   - 删除: r / r.next / .version-next / debug.log / 旧根位置 launcher-config.json /
//           loading-status / gh555.com-old / qqqide.old.exe / 无挂起标记的 gh555.com-next
//   - 旧根 Data（历史泄漏残留）由 migrateLegacyRootData 救援 alphal 后整树删除
//   - 未知文件一律不动（防误删用户自放文件）
static void cleanupRootJunk(const WCHAR *exeDir) {
    WCHAR p[MAX_PATH];
    static const WCHAR *plainFiles[] = {
        L"r", L"r.next", L"r.next.sig", L".version-next", L"debug.log",
        L"launcher-config.json", L"loading-status", L"qqqide.old.exe"
    };
    for (int i = 0; i < (int)(sizeof(plainFiles) / sizeof(plainFiles[0])); i++) {
        swprintf(p, MAX_PATH, L"%s\\%s", exeDir, plainFiles[i]);
        if (fileExistsW(p)) DeleteFileW(p);
    }
    // 交换失败/崩溃残留目录（轮换槽系列，2026-08-14）:
    //   含 Data 的槽永不删（用户数据安全，由 applySwapIfReady 搬回后收尾）
    for (int i = 0; i < 100; i++) {
        oldSlotPath(exeDir, i, p, MAX_PATH);
        if (!fileExistsW(p)) continue;
        WCHAR slotData[MAX_PATH];
        swprintf(slotData, MAX_PATH, L"%s\\Data", p);
        if (fileExistsW(slotData)) continue;
        removeDir(p);
    }
    // 单元增量暂存（下载中断残留，启动即清）
    swprintf(p, MAX_PATH, L"%s\\u.next", exeDir);
    if (fileExistsW(p)) removeDir(p);
    // 全量解压暂存（解压中途被杀残留，启动即清）
    swprintf(p, MAX_PATH, L"%s\\_swap_tmp", exeDir);
    if (fileExistsW(p)) removeDir(p);
    // 挂起更新: .swap-ready 仍在 → 交换被推迟（joker 在跑）→ 保留 next 等下次交换
    swprintf(p, MAX_PATH, L"%s\\.swap-ready", exeDir);
    if (!fileExistsW(p)) {
        swprintf(p, MAX_PATH, L"%s\\gh555.com-next", exeDir);
        if (fileExistsW(p)) removeDir(p);
        // .pending-reboot 随 .swap-ready 一起清（交换已放弃）
        swprintf(p, MAX_PATH, L"%s\\.pending-reboot", exeDir);
        DeleteFileW(p);
    }
}

// ★ 旧根 Data 迁移（2026-08-10）: 根目录 Data 是旧包泄漏残留（dev 数据被 electron-builder
//   拷入发行包，F27 已堵源头）。程序级保险库 = gh555.com/Data（运行时 userData + 交换守卫
//   自动备份恢复）。一次性救援 + 清除: 保险库缺 alphal 且旧目录有 → 搬入（幂等，目标已存在
//   则旧副本视为泄漏拷贝作废）；救援完成后整树删除根 Data。此后包根只剩 LICENSE / qqqide.exe / gh555.com。
static void migrateLegacyRootData(const WCHAR *exeDir) {
    WCHAR legacy[MAX_PATH], vault[MAX_PATH], srcA[MAX_PATH], dstA[MAX_PATH];
    int alphalDone = 0;

    swprintf(legacy, MAX_PATH, L"%s\\Data", exeDir);
    if (!fileExistsW(legacy)) return;           // 无残留 → 无事可做

    swprintf(vault, MAX_PATH, L"%s\\gh555.com\\Data", exeDir);
    swprintf(srcA, MAX_PATH, L"%s\\alphal", legacy);
    swprintf(dstA, MAX_PATH, L"%s\\alphal", vault);

    if (!fileExistsW(srcA)) {
        alphalDone = 1;                          // 旧目录本来就没有账号数据
    } else if (fileExistsW(dstA)) {
        alphalDone = 1;                          // 保险库已有账号数据（目标胜出）
    } else if (MoveFileW(srcA, dstA)) {
        alphalDone = 1;                          // 救援成功（同盘原子改名）
    }
    // MoveFileW 失败（被占用等）→ 保留旧目录，下次启动重试，绝不丢数据

    if (alphalDone) removeDir(legacy);
}


// ★ 后台解压线程 — 将 r.next 解压到 gh555.com-next/（不阻塞用户使用 IDE）
static unsigned __stdcall backgroundApplyUpdate(void *param) {
    InterlockedExchange(&g_applyRunning, 1);
    WCHAR *exeDir = (WCHAR *)param;

    WCHAR rNext[MAX_PATH], vNext[MAX_PATH], rNextSig[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", exeDir);
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", exeDir);
    swprintf(rNextSig, MAX_PATH, L"%s\\r.next.sig", exeDir);

    if (!fileExistsW(rNext) || !fileExistsW(vNext)) {
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }

    char newVer[64] = {0};
    int rd = readFileText(vNext, newVer, sizeof(newVer));
    if (rd <= 0) {
        swapLogNow(exeDir, "extract abort: .version-next unreadable");
        applyFailMark(exeDir);
        DeleteFileW(rNext); DeleteFileW(rNextSig); DeleteFileW(vNext); InterlockedExchange(&g_applyRunning, 0); return 0;
    }

    // ★ 交换已完成（live 已是目标版本）→ 清理残留暂存，不再重复解压
    {
        char liveVer[64] = {0};
        if (readLocalVersion(exeDir, liveVer, sizeof(liveVer)) > 0 &&
            strcmp(liveVer, newVer) == 0) {
            swapLogNow(exeDir, "extract skip: live already %s (stale r.next cleaned)", liveVer);
            applyFailClear(exeDir);
            DeleteFileW(rNext); DeleteFileW(vNext);
            InterlockedExchange(&g_applyRunning, 0);
            return 0;
        }
    }

    // 创建临时解压目录
    WCHAR tmpDir[MAX_PATH], ghNext[MAX_PATH];

    swprintf(tmpDir, MAX_PATH, L"%s\\_swap_tmp", exeDir);
    swprintf(ghNext, MAX_PATH, L"%s\\gh555.com-next", exeDir);

    // ★ 幂等守卫（2026-08-06）: gh555.com-next 已存在且版本匹配 → 补写 .swap-ready 即结束
    //   禁止每次启动重复解压 120MB（交换推迟期间每启动全量重做 = 严重 bug）
    //   版本读取 = next/versions.json 的 id（唯一权威，2026-08-10）
    {
        WCHAR nextVerPath[MAX_PATH];
        swprintf(nextVerPath, MAX_PATH, L"%s\\versions.json", ghNext);
        char nextVer[64] = {0};
        if (fileExistsW(ghNext) &&
            readManifestIdFile(nextVerPath, nextVer, sizeof(nextVer)) > 0 &&
            strcmp(nextVer, newVer) == 0) {
            swapLogNow(exeDir, "extract skip: next already %s (idempotent, no re-extract)", newVer);
            WCHAR swapReady[MAX_PATH];
            swprintf(swapReady, MAX_PATH, L"%s\\.swap-ready", exeDir);
            writeFileText(swapReady, newVer);
            applyFailClear(exeDir);
            DeleteFileW(rNext); DeleteFileW(rNextSig); DeleteFileW(vNext);
            InterlockedExchange(&g_applyRunning, 0);
            return 0;
        }
    }

    // ★ Ed25519 验签（2026-08-27 安全）: r.next 必须带合法签名（r.next.sig）
    //   防 CDN 投毒/中间人替换。验签失败 → 删暂存 + 失败计数，拒绝解压
    //   （方向安全: 保留旧版，下次启动重试）。验证点统一在此 —— 下载路径与
    //   skip-re-download 路径都汇聚于此，无旁路。
    {
        if (!fileExistsW(rNextSig) || verifySignedFile(rNext, rNextSig) != 0) {
            swapLogNow(exeDir, "extract abort: r.next signature INVALID (security, keep old version)");
            DeleteFileW(rNext); DeleteFileW(rNextSig); DeleteFileW(vNext);
            applyFailMark(exeDir);
            InterlockedExchange(&g_applyRunning, 0);
            return 0;
        }
        swapLogNow(exeDir, "extract: r.next signature OK (%s)", newVer);
    }

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
        swapLogNow(exeDir, "extract FAIL: spawn 7z err=%lu", GetLastError());
        applyFailMark(exeDir);
        removeDir(tmpDir);
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD ec = 0;
    GetExitCodeProcess(pi.hProcess, &ec);
    CloseHandle(pi.hProcess);

    if (ec != 0) {
        swapLogNow(exeDir, "extract FAIL: 7z exit=%lu (corrupt r.next)", ec);
        applyFailMark(exeDir);
        removeDir(tmpDir); InterlockedExchange(&g_applyRunning, 0); return 0;
    }

    // 移出解压出的 gh555.com → gh555.com-next
    WCHAR extractedGh[MAX_PATH];
    swprintf(extractedGh, MAX_PATH, L"%s\\gh555.com", tmpDir);
    if (!fileExistsW(extractedGh)) {
        swapLogNow(exeDir, "extract FAIL: payload has no gh555.com (bad r.next)");
        applyFailMark(exeDir);
        removeDir(tmpDir);
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }

    if (!MoveFileW(extractedGh, ghNext)) {
        swapLogNow(exeDir, "extract FAIL: move to gh555.com-next err=%lu", GetLastError());
        applyFailMark(exeDir);
        removeDir(tmpDir); removeDir(ghNext);
        InterlockedExchange(&g_applyRunning, 0);
        return 0;
    }

    // ★ 自更新: r 载荷根目录含新 qqqide.exe → 移入 gh555.com-next/ 供 swap 时替换
    {
        WCHAR newLauncherSrc[MAX_PATH], newLauncherDst[MAX_PATH];
        swprintf(newLauncherSrc, MAX_PATH, L"%s\\qqqide.exe", tmpDir);
        swprintf(newLauncherDst, MAX_PATH, L"%s\\launcher-next.exe", ghNext);
        if (fileExistsW(newLauncherSrc)) {
            CopyFileW(newLauncherSrc, newLauncherDst, FALSE);
        }
    }

    removeDir(tmpDir);

    // ★ 版本号不再写：versions.json 已随 r 冻结在 gh555.com 内（唯一权威，2026-08-10）

    // 写 .swap-ready → 下次启动原子交换
    WCHAR swapReady[MAX_PATH];
    swprintf(swapReady, MAX_PATH, L"%s\\.swap-ready", exeDir);
    writeFileText(swapReady, newVer);
    swapLogNow(exeDir, "extract OK: %s staged (swap-ready written)", newVer);
    applyFailClear(exeDir);

    // 清理暂存文件
    DeleteFileW(rNext);
    DeleteFileW(rNextSig);
    DeleteFileW(vNext);

    InterlockedExchange(&g_applyRunning, 0);

    // 通知主线程：如果启动器已隐藏，可以关闭了
    if (g_hwnd) PostMessageW(g_hwnd, WM_USER + 1, 0, 0);

    return 0;
}

// ★ 解压线程调度（2026-08-14）: 下载完 r.next+.version-next 即在本会话解压
//   → 全量升级从 3 次启动压到 2 次（与增量路径一致）。每会话最多 2 次（防解压失败洪泛），
//   失败（r.next 残留）下次启动重试。
static void maybeStartApplyThread(void) {
    if (g_applyLaunches >= 2) return;
    if (InterlockedCompareExchange(&g_applyRunning, 0, 0) != 0) return;  // 上一线程仍在跑
    if (g_hApplyThread) {
        if (WaitForSingleObject(g_hApplyThread, 0) == WAIT_OBJECT_0) {
            CloseHandle(g_hApplyThread); g_hApplyThread = NULL;
        } else {
            return;
        }
    }
    WCHAR rNextPath[MAX_PATH], vNextPath[MAX_PATH];
    swprintf(rNextPath, MAX_PATH, L"%s\\r.next", g_exeDir);
    swprintf(vNextPath, MAX_PATH, L"%s\\.version-next", g_exeDir);
    if (fileExistsW(rNextPath) && fileExistsW(vNextPath)) {
        g_applyLaunches++;
        g_hApplyThread = (HANDLE)_beginthreadex(NULL, 0, backgroundApplyUpdate, g_exeDir, 0, NULL);
    }
}

// ═══════════════════════════════════════════════════════════════
// ★ 单元增量更新（2026-08-10 B 方案落地）
//   哲学: 增量 = 纯传输层优化，正确性零责任。
//   ① 版本权威不变 = versions.json 清单编号（F33 重构），任何异常 → 全量 r 兜底
//   ② 单元 = 架构层目录（launcher/core/app/shell-out/webapp 固定 5 个），
//      单元数不随项目复杂度增长（新文件自动落入 core/app 补集）
//   ③ engines/* 不参与增量（component-checker 已按 manifest 独立增量管理，
//      防启动器覆盖组件升级导致静默回退）
//   ④ 增量字节数 >= 全量 r → 直接全量（带宽不劣化）
//   ⑤ 本地状态 = gh555.com/Data/units.json（随交换 Data 备份恢复，天然幂等）
// ═══════════════════════════════════════════════════════════════

#define MAX_UNITS 12

typedef struct {
    char name[48];
    char rel[256];
    char version[64];
    long bytes;
    char file[128];
    char hash[160];   // sha512 hex 128 字符（2026-08-27 安全: 已验签清单锁定的单元完整性哈希；
                    //   2026-08-28: 128 缓冲 + parseJsonString 127 上限 = 断流，必须 ≥129）
} UnitDef;

typedef struct {
    char id[64];
    long r_bytes;
    char versions_raw[2048];   // "versions" 键的原始 JSON（逐字写 next/versions.json）
    int n_units;
    UnitDef units[MAX_UNITS];
} UnitsManifest;

// 抓取 "versions" 键的原始 JSON 值（含花括号）
static int captureRawJsonObject(const char **p, char *out, int outSize) {
    skipWhitespace(p);
    if (**p != '{') return 0;
    int depth = 0;
    int i = 0;
    while (**p && i < outSize - 1) {
        char c = **p;
        out[i++] = c;
        if (c == '{') depth++;
        else if (c == '}') {
            depth--;
            if (depth == 0) { (*p)++; out[i] = '\0'; return 1; }
        }
        (*p)++;
    }
    out[i] = '\0';
    return 0;
}

// 跳过任意 JSON 值（未知 key 容错，向前兼容）
static void skipJsonValue(const char **p) {
    skipWhitespace(p);
    if (**p == '"') { char dummy[256]; parseJsonString(p, dummy, sizeof(dummy)); }  // 256: 127 上限曾吞 128 字符 sha512 断流
    else if (**p == '{') { int d = 1; (*p)++; while (**p && d > 0) { if (**p == '{') d++; if (**p == '}') d--; (*p)++; } }
    else if (**p == '[') { int d = 1; (*p)++; while (**p && d > 0) { if (**p == '[') d++; if (**p == ']') d--; (*p)++; } }
    else if (**p == 't' || **p == 'f') { int v; parseJsonBool(p, &v); }
    else { while (**p && **p != ',' && **p != '}' && **p != ']') (*p)++; }
}

// 解析一个单元对象 {"name":..,"rel":..,"version":..,"bytes":..,"file":..}
static int parseUnitObject(const char **p, UnitDef *u) {
    skipWhitespace(p);
    if (**p != '{') return 0;
    (*p)++;
    memset(u, 0, sizeof(*u));
    while (1) {
        skipWhitespace(p);
        if (**p == '}') { (*p)++; break; }
        if (**p == ',') { (*p)++; continue; }
        if (**p == '\0') return 0;
        char key[48];
        if (!parseJsonString(p, key, sizeof(key))) return 0;
        skipWhitespace(p);
        if (**p != ':') return 0;
        (*p)++;
        if (strcmp(key, "name") == 0) { skipWhitespace(p); parseJsonString(p, u->name, sizeof(u->name)); }
        else if (strcmp(key, "rel") == 0) { skipWhitespace(p); parseJsonString(p, u->rel, sizeof(u->rel)); }
        else if (strcmp(key, "version") == 0) { skipWhitespace(p); parseJsonString(p, u->version, sizeof(u->version)); }
        else if (strcmp(key, "bytes") == 0) { skipWhitespace(p); char *end = NULL; u->bytes = strtol(*p, &end, 10); if (end) *p = end; }
        else if (strcmp(key, "file") == 0) { skipWhitespace(p); parseJsonString(p, u->file, sizeof(u->file)); }
        else if (strcmp(key, "hash") == 0) { skipWhitespace(p); parseJsonString(p, u->hash, sizeof(u->hash)); }
        else { skipJsonValue(p); }
    }
    return 1;
}

// 解析远端单元清单 units.json
static int parseUnitsManifest(const char *json, UnitsManifest *m) {
    const char *p = json;
    skipWhitespace(&p);
    if (*p != '{') return 0;
    p++;
    memset(m, 0, sizeof(*m));
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
        if (strcmp(key, "id") == 0) { skipWhitespace(&p); parseJsonString(&p, m->id, sizeof(m->id)); }
        else if (strcmp(key, "r_bytes") == 0) { skipWhitespace(&p); char *end = NULL; m->r_bytes = strtol(p, &end, 10); if (end) p = end; }
        else if (strcmp(key, "versions") == 0) { captureRawJsonObject(&p, m->versions_raw, sizeof(m->versions_raw)); }
        else if (strcmp(key, "units") == 0) {
            skipWhitespace(&p);
            if (*p == '[') {
                p++;
                while (m->n_units < MAX_UNITS) {
                    skipWhitespace(&p);
                    if (*p == ']') { p++; break; }
                    if (*p == ',') { p++; continue; }
                    if (!parseUnitObject(&p, &m->units[m->n_units])) break;
                    m->n_units++;
                }
            }
        }
        else { skipJsonValue(&p); }
    }
    return m->n_units > 0 && m->id[0] != '\0';
}

// 解析本地单元状态 gh555.com/Data/units.json（复用 UnitsManifest，仅 id + name/version 有意义）
static int parseLocalUnitsState(const char *json, UnitsManifest *ls) {
    const char *p = json;
    skipWhitespace(&p);
    if (*p != '{') return 0;
    p++;
    memset(ls, 0, sizeof(*ls));
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
        if (strcmp(key, "id") == 0) { skipWhitespace(&p); parseJsonString(&p, ls->id, sizeof(ls->id)); }
        else if (strcmp(key, "units") == 0) {
            skipWhitespace(&p);
            if (*p == '{') {
                p++;
                while (ls->n_units < MAX_UNITS) {
                    skipWhitespace(&p);
                    if (*p == '}') { p++; break; }
                    if (*p == ',') { p++; continue; }
                    char uname[48];
                    if (!parseJsonString(&p, uname, sizeof(uname))) break;
                    skipWhitespace(&p);
                    if (*p != ':') break;
                    p++;
                    skipWhitespace(&p);
                    char uver[64];
                    if (!parseJsonString(&p, uver, sizeof(uver))) break;
                    strncpy(ls->units[ls->n_units].name, uname, sizeof(ls->units[0].name) - 1);
                    strncpy(ls->units[ls->n_units].version, uver, sizeof(ls->units[0].version) - 1);
                    ls->n_units++;
                }
            }
        }
        else { skipJsonValue(&p); }
    }
    return ls->n_units > 0 || ls->id[0] != '\0';
}

// 生成本地单元状态 JSON
static void buildLocalUnitsJson(char *buf, int bufSize, const UnitsManifest *m) {
    int n = 0;
    n += snprintf(buf + n, bufSize - n, "{\"id\":\"%s\",\"units\":{", m->id);
    for (int i = 0; i < m->n_units; i++) {
        n += snprintf(buf + n, bufSize - n, "\"%s\":\"%s\",", m->units[i].name, m->units[i].version);
    }
    if (n > 2 && buf[n - 1] == ',') { buf[n - 1] = '}'; buf[n] = '\0'; }
    n = (int)strlen(buf);
    n += snprintf(buf + n, bufSize - n, "}");
}

// 判断 rel 是否命中跳过清单（'|' 分隔的多段路径，'\\' 分隔段）
static int relSkipped(const WCHAR *rel, const WCHAR *skipList) {
    if (!skipList || !skipList[0]) return 0;
    const WCHAR *start = skipList;
    while (*start) {
        const WCHAR *end = wcschr(start, L'|');
        size_t len = end ? (size_t)(end - start) : wcslen(start);
        if (wcslen(rel) == len && wcsncmp(rel, start, len) == 0) return 1;
        if (!end) break;
        start = end + 1;
    }
    return 0;
}

// ★ 合并树: 把解压产物 src 合并进 dst（next 目标路径）
//   文件用 MoveFileEx(REPLACE_EXISTING) → 仅替换目录项，硬链接共享 inode 的 live 零损伤
//   失败回退: 删目录项 + 物理复制（同样安全，绝不原地写硬链接）
static int mergeTreeW(const WCHAR *src, const WCHAR *dst) {
    DWORD attr = GetFileAttributesW(src);
    if (attr == INVALID_FILE_ATTRIBUTES) return -1;
    if (!(attr & FILE_ATTRIBUTE_DIRECTORY)) {
        // 单文件单元（launcher-next.exe）
        WCHAR parent[MAX_PATH];
        wcscpy(parent, dst);
        WCHAR *slash = wcsrchr(parent, L'\\');
        if (slash) { *slash = L'\0'; CreateDirectoryW(parent, NULL); }
        if (MoveFileExW(src, dst, MOVEFILE_REPLACE_EXISTING)) return 0;
        DeleteFileW(dst);
        return CopyFileW(src, dst, FALSE) ? 0 : -1;
    }
    WCHAR searchPath[MAX_PATH];
    swprintf(searchPath, MAX_PATH, L"%s\\*", src);
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return -1;
    CreateDirectoryW(dst, NULL);
    int rc = 0;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR s[MAX_PATH], d[MAX_PATH];
        swprintf(s, MAX_PATH, L"%s\\%s", src, fd.cFileName);
        swprintf(d, MAX_PATH, L"%s\\%s", dst, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (mergeTreeW(s, d) != 0) { rc = -1; break; }
        } else {
            if (MoveFileExW(s, d, MOVEFILE_REPLACE_EXISTING)) continue;
            DeleteFileW(d);
            if (!CopyFileW(s, d, FALSE)) { rc = -1; break; }
            DeleteFileW(s);
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    return rc;
}

// ★ 硬链接克隆目录树（NTFS 同卷零拷贝秒级；失败回退物理复制）
//   skipList: '|' 分隔的相对路径（如 "Data|versions.json|.version"）
static int cloneTreeW(const WCHAR *src, const WCHAR *dst, const WCHAR *rel, const WCHAR *skipList) {
    WCHAR searchPath[MAX_PATH];
    swprintf(searchPath, MAX_PATH, L"%s\\*", src);
    WIN32_FIND_DATAW fd;
    HANDLE hFind = FindFirstFileW(searchPath, &fd);
    if (hFind == INVALID_HANDLE_VALUE) return -1;
    CreateDirectoryW(dst, NULL);
    int rc = 0;
    do {
        if (wcscmp(fd.cFileName, L".") == 0 || wcscmp(fd.cFileName, L"..") == 0) continue;
        WCHAR childRel[MAX_PATH];
        if (rel[0]) swprintf(childRel, MAX_PATH, L"%s\\%s", rel, fd.cFileName);
        else wcscpy(childRel, fd.cFileName);
        if (relSkipped(childRel, skipList)) continue;
        WCHAR s[MAX_PATH], d[MAX_PATH];
        swprintf(s, MAX_PATH, L"%s\\%s", src, fd.cFileName);
        swprintf(d, MAX_PATH, L"%s\\%s", dst, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (cloneTreeW(s, d, childRel, skipList) != 0) { rc = -1; break; }
        } else {
            if (!CreateHardLinkW(d, s, NULL) && !CopyFileW(s, d, FALSE)) { rc = -1; break; }
        }
    } while (FindNextFileW(hFind, &fd));
    FindClose(hFind);
    return rc;
}

// 计算需要下载的单元（本地缺失或版本不一致）；返回需要数
static int collectNeededUnits(const UnitsManifest *m, const UnitsManifest *ls, int *needed, int maxNeeded, long *neededBytes) {
    int n = 0;
    long total = 0;
    for (int i = 0; i < m->n_units && n < maxNeeded; i++) {
        int have = 0;
        for (int j = 0; j < ls->n_units; j++) {
            if (strcmp(ls->units[j].name, m->units[i].name) == 0) {
                if (strcmp(ls->units[j].version, m->units[i].version) == 0) have = 1;
                break;
            }
        }
        if (!have) { needed[n++] = i; total += m->units[i].bytes; }
    }
    *neededBytes = total;
    return n;
}

// ★ 单元哈希 sidecar 解析（2026-08-28）: {"id":..,"units":[{"name":..,"hash":..}]}
//   128 字符 sha512 移出 units.json（127 解析上限撑爆 → 全量 178MB 死循环实锤），
//   sidecar 独立签名，overlay 到清单单元（sidecar 权威）。
static int parseSidecarHashes(const char *json, UnitsManifest *m) {
    const char *p = json;
    skipWhitespace(&p);
    if (*p != '{') return 0;
    p++;
    int overlay = 0;
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
        if (strcmp(key, "units") == 0) {
            skipWhitespace(&p);
            if (*p == '[') {
                p++;
                while (1) {
                    skipWhitespace(&p);
                    if (*p == ']') { p++; break; }
                    if (*p == ',') { p++; continue; }
                    if (*p != '{') return 0;
                    p++;
                    char uname[48] = {0}, uhash[160] = {0};
                    while (1) {
                        skipWhitespace(&p);
                        if (*p == '}') { p++; break; }
                        if (*p == ',') { p++; continue; }
                        if (*p == '\0') return 0;
                        char k2[48];
                        if (!parseJsonString(&p, k2, sizeof(k2))) return 0;
                        skipWhitespace(&p);
                        if (*p != ':') return 0;
                        p++;
                        if (strcmp(k2, "name") == 0) { skipWhitespace(&p); parseJsonString(&p, uname, sizeof(uname)); }
                        else if (strcmp(k2, "hash") == 0) { skipWhitespace(&p); parseJsonString(&p, uhash, sizeof(uhash)); }
                        else skipJsonValue(&p);
                    }
                    if (uname[0] && uhash[0]) {
                        for (int i = 0; i < m->n_units; i++) {
                            if (strcmp(m->units[i].name, uname) == 0) {
                                strncpy(m->units[i].hash, uhash, sizeof(m->units[i].hash) - 1);
                                overlay++;
                                break;
                            }
                        }
                    }
                }
            }
        }
        else skipJsonValue(&p);
    }
    return overlay > 0;
}

// ★ 单元增量装配: 返回 1=成功(swap-ready 已写) / 0=失败 → 调用方走全量 r 兜底
static int tryIncrementalUpdate(const WCHAR *exeDir, const char *serverVer) {
    char liveVer[64] = {0};
    readLocalVersion(exeDir, liveVer, sizeof(liveVer));
    swapLogNow(exeDir, "incremental: begin %s -> %s", liveVer[0] ? liveVer : "?", serverVer);

    char json[8192];
    int len = downloadToString(g_cfg.update_host, g_cfg.units_path, json, sizeof(json), g_cfg.use_https);
    if (len <= 0 && g_cfg.use_https) {
        len = downloadToString(g_cfg.update_host, g_cfg.units_path, json, sizeof(json), 0);
    }
    if (len <= 0) {
        swapLogNow(exeDir, "incremental abort: units.json fetch FAIL (fallback full r)");
        return 0;
    }

    // ★ Ed25519 验签（2026-08-27 安全）: units.json 必须带合法签名
    //   （防 CDN 投毒绕过全量签名——增量路径与全量同一信任门）
    {
        char sigPath[300];
        snprintf(sigPath, sizeof(sigPath), "%s.sig", g_cfg.units_path);
        char sigBuf[128];
        int sigLen = downloadToString(g_cfg.update_host, sigPath, sigBuf, sizeof(sigBuf), g_cfg.use_https);
        if (sigLen <= 0 && g_cfg.use_https) {
            sigLen = downloadToString(g_cfg.update_host, sigPath, sigBuf, sizeof(sigBuf), 0);
        }
        if (sigLen != 64 || verifySignedBuf((const u8 *)json, (size_t)len, (const u8 *)sigBuf, sigLen) != 0) {
            swapLogNow(exeDir, "incremental abort: units.json signature INVALID (security, fallback full r)");
            return 0;
        }
    }

    UnitsManifest m;
    if (!parseUnitsManifest(json, &m)) {
        swapLogNow(exeDir, "incremental abort: units manifest parse FAIL (fallback full r)");
        return 0;
    }
    if (m.id[0] == '\0' || strcmp(m.id, serverVer) != 0) {
        swapLogNow(exeDir, "incremental abort: manifest id %s != latest %s (fallback full r)", m.id[0] ? m.id : "?", serverVer);
        return 0;
    }
    if (m.versions_raw[0] == '\0') return 0;

    // ★ 单元完整性哈希（2026-08-28 sidecar）: units.hash.json + 签名验签 → overlay 到清单。
    //   过渡期（旧 CDN units.json 内嵌 hash）自动回退清单内值。
    //   ★ 127 字符解析上限教训: units.json 内禁止任何 >127 字符字符串——128 字符 sha512
    //   曾撑爆 parseJsonString 缓冲 → 全部启动器增量解析失败 → 全量 178MB 死循环。
    {
        char sidecar[8192];
        int slen = downloadToString(g_cfg.update_host, "/dl/qqqide-up/units.hash.json",
            sidecar, sizeof(sidecar), g_cfg.use_https);
        if (slen <= 0 && g_cfg.use_https) {
            slen = downloadToString(g_cfg.update_host, "/dl/qqqide-up/units.hash.json",
                sidecar, sizeof(sidecar), 0);
        }
        if (slen > 0) {
            char sigPath[300];
            snprintf(sigPath, sizeof(sigPath), "/dl/qqqide-up/units.hash.json.sig");
            char sigBuf[128];
            int sigLen = downloadToString(g_cfg.update_host, sigPath, sigBuf, sizeof(sigBuf), g_cfg.use_https);
            if (sigLen <= 0 && g_cfg.use_https) {
                sigLen = downloadToString(g_cfg.update_host, sigPath, sigBuf, sizeof(sigBuf), 0);
            }
            if (sigLen == 64 && verifySignedBuf((const u8 *)sidecar, (size_t)slen, (const u8 *)sigBuf, sigLen) == 0) {
                if (!parseSidecarHashes(sidecar, &m)) {
                    swapLogNow(exeDir, "incremental abort: units.hash.json parse FAIL (security, fallback full r)");
                    return 0;
                }
                swapLogNow(exeDir, "incremental: unit hashes from signed sidecar (%d units)", m.n_units);
            } else {
                swapLogNow(exeDir, "incremental abort: units.hash.json signature INVALID (security, fallback full r)");
                return 0;
            }
        } else {
            // sidecar 缺失（过渡期 CDN）→ 依赖清单内嵌 hash（老格式）
            int inJson = 0;
            for (int i = 0; i < m.n_units; i++) if (m.units[i].hash[0]) inJson = 1;
            if (!inJson) {
                swapLogNow(exeDir, "incremental abort: no unit hashes (security, fallback full r)");
                return 0;
            }
            swapLogNow(exeDir, "incremental: units.hash.json absent, using in-manifest hashes (transitional)");
        }
    }

    // 本地单元状态缺失（旧包）→ 全量兜底
    WCHAR lsPath[MAX_PATH];
    swprintf(lsPath, MAX_PATH, L"%s\\gh555.com\\Data\\units.json", exeDir);
    char lsRaw[4096];
    if (readFileRaw(lsPath, lsRaw, sizeof(lsRaw)) <= 0) {
        swapLogNow(exeDir, "incremental abort: no local unit state (legacy pack, fallback full r)");
        return 0;
    }
    UnitsManifest ls;
    if (!parseLocalUnitsState(lsRaw, &ls)) {
        swapLogNow(exeDir, "incremental abort: local units.json parse FAIL (fallback full r)");
        return 0;
    }
    if (strcmp(ls.id, m.id) == 0) return 0;                          // 已是目标版本（幂等兜底）

    int needed[MAX_UNITS];
    long neededBytes = 0;
    int nNeed = collectNeededUnits(&m, &ls, needed, MAX_UNITS, &neededBytes);
    if (nNeed == 0) {
        swapLogNow(exeDir, "incremental abort: no unit changes (fallback full r)");
        return 0;
    }
    if (m.r_bytes > 0 && neededBytes >= m.r_bytes) {
        swapLogNow(exeDir, "incremental abort: delta %ld >= full %ld (fallback full r)", neededBytes, m.r_bytes);
        return 0;
    }

    // ── 装配 gh555.com-next: ① 硬链接克隆 live（同卷零拷贝，秒级） ② 覆盖变化单元 ──
    //   next 必须是完整 gh555.com（swap 门同全量 r），未变化单元从 live 克隆；
    //   变化单元删除克隆旧路径（断链安全）后解压新内容 → 结果 = 完整新矩阵。
    WCHAR uDir[MAX_PATH], ghNext[MAX_PATH], liveCore[MAX_PATH];
    swprintf(uDir, MAX_PATH, L"%s\\u.next", exeDir);
    swprintf(ghNext, MAX_PATH, L"%s\\gh555.com-next", exeDir);
    swprintf(liveCore, MAX_PATH, L"%s\\gh555.com", exeDir);
    removeDir(uDir);
    CreateDirectoryW(uDir, NULL);
    removeDir(ghNext);

    int ok = 1;
    // ① 全量硬链接克隆（Data/versions.json/.version 不克隆，由本函数重写）
    if (cloneTreeW(liveCore, ghNext, L"", L"Data|versions.json|.version") != 0) ok = 0;
    for (int i = 0; i < nNeed && ok; i++) {
        UnitDef *u = &m.units[needed[i]];
        WCHAR dest[MAX_PATH], outDir[MAX_PATH];
        swprintf(dest, MAX_PATH, L"%s\\%s.7z", uDir, u->name);
        swprintf(outDir, MAX_PATH, L"%s\\out", uDir);
        DeleteFileW(dest);
        removeDir(outDir);

        char cdnPath[512];
        snprintf(cdnPath, sizeof(cdnPath), "/dl/qqqide-up/%s", u->file);
        int rc = downloadFile(g_cfg.update_host, cdnPath, dest, g_cfg.use_https);
        if (rc != 0 && g_cfg.use_https) {
            DeleteFileW(dest);
            rc = downloadFile(g_cfg.update_host, cdnPath, dest, 0);
        }
        if (rc != 0) {
            swapLogNow(exeDir, "incremental FAIL: download unit %s (fallback full r)", u->name);
            ok = 0; break;
        }

        // ★ 清单 sha512 校验（2026-08-27 安全）: 单元内容必须匹配已验签清单的 hash
        //   （7z CRC 防损坏不防篡改，攻击者可构造自洽恶意 7z）
        if (u->hash[0] && !fileSha512Matches(dest, u->hash)) {
            swapLogNow(exeDir, "incremental FAIL: unit %s hash mismatch (security, fallback full r)", u->name);
            DeleteFileW(dest); ok = 0; break;
        }

        // ② 解压到临时目录（绝不对 next 内硬链接文件原地写——共享 inode 会污染 live）
        CreateDirectoryW(outDir, NULL);
        WCHAR cmdLine[1024];
        swprintf(cmdLine, 1024, L"\"%s\" -y", dest);
        STARTUPINFOW si = { sizeof(si) };
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION pi = {0};
        if (!CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
            CREATE_NO_WINDOW, NULL, outDir, &si, &pi)) {
            swapLogNow(exeDir, "incremental FAIL: spawn 7z for unit %s err=%lu (fallback full r)", u->name, GetLastError());
            ok = 0; break;
        }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD ec = 0;
        GetExitCodeProcess(pi.hProcess, &ec);
        CloseHandle(pi.hProcess);
        if (ec != 0) {
            swapLogNow(exeDir, "incremental FAIL: 7z exit=%lu for unit %s (CRC, fallback full r)", ec, u->name);
            ok = 0; break;                                           // 7z CRC 校验失败 → 丢弃
        }

        // ③ 合并入 next 根（单元档案内路径 = 相对 gh555.com 根，自描述无需 rel）
        //    REPLACE 目录项 → 断链安全，live 零损伤
        if (mergeTreeW(outDir, ghNext) != 0) { ok = 0; break; }
        removeDir(outDir);
        DeleteFileW(dest);
    }

    if (!ok) {
        swapLogNow(exeDir, "incremental FAIL: assemble aborted (fallback full r)");
        removeDir(ghNext); removeDir(uDir); return 0;                // 任一失败 → 丢弃暂存 → 全量兜底
    }

    // ── 元数据落盘（先于 gate：版本权威逐字 = 全量 r 的 versions.json） ──
    WCHAR vPath[MAX_PATH], dotVPath[MAX_PATH], dataDir[MAX_PATH], luPath[MAX_PATH], swPath[MAX_PATH];
    swprintf(vPath, MAX_PATH, L"%s\\versions.json", ghNext);
    writeFileText(vPath, m.versions_raw);
    swprintf(dotVPath, MAX_PATH, L"%s\\.version", ghNext);
    writeFileText(dotVPath, m.id);
    swprintf(dataDir, MAX_PATH, L"%s\\Data", ghNext);
    CreateDirectoryW(dataDir, NULL);
    swprintf(luPath, MAX_PATH, L"%s\\Data\\units.json", ghNext);
    { char lbuf[4096]; buildLocalUnitsJson(lbuf, sizeof(lbuf), &m); writeFileText(luPath, lbuf); }

    // ── gate 校验（与全量 r 交换同一门） ──
    {
        WCHAR chk[MAX_PATH];
        swprintf(chk, MAX_PATH, L"%s\\joker.exe", ghNext);
        if (!fileExistsW(chk)) { removeDir(ghNext); removeDir(uDir); return 0; }
        swprintf(chk, MAX_PATH, L"%s\\resources\\app", ghNext);
        if (!fileExistsW(chk)) { removeDir(ghNext); removeDir(uDir); return 0; }
        swprintf(chk, MAX_PATH, L"%s\\versions.json", ghNext);
        if (!fileExistsW(chk)) { removeDir(ghNext); removeDir(uDir); return 0; }
    }

    swprintf(swPath, MAX_PATH, L"%s\\.swap-ready", exeDir);
    writeFileText(swPath, m.id);

    removeDir(uDir);
    swapLogNow(exeDir, "incremental OK: %s -> %s (%d units, %ld bytes)",
        liveVer[0] ? liveVer : "?", m.id, nNeed, neededBytes);
    return 1;
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
    if (len <= 0) {
        swapLogNow(g_exeDir, "update: fetch latest.txt FAIL (len=%d)", len);
        InterlockedExchange(&g_updateRunning, 0); return 0;
    }

    char *nl = strchr(serverVer, '\n'); if (nl) *nl = '\0';
    nl = strchr(serverVer, '\r'); if (nl) *nl = '\0';
    while (len > 0 && (serverVer[len-1] == ' ' || serverVer[len-1] == '\t')) serverVer[--len] = '\0';
    if (len == 0) { InterlockedExchange(&g_updateRunning, 0); return 0; }

    char localVer[64] = {0};
    int localLen = readLocalVersion(g_exeDir, localVer, sizeof(localVer));
    // ★ 仅服务器版本严格更高才升级（旧实现 "版本不等即下载" → 反向降级）
    if (localLen > 0 && compareVersion(serverVer, localVer) <= 0) {
        InterlockedExchange(&g_updateRunning, 0); return 0;
    }

    // ★ 幂等守卫（2026-08-06）: swap-ready 已就绪 + gh555.com-next 已是目标版本
    //   → 暂存完成，仅等用户退出后交换。禁止每启动重复下载 120MB r.next。
    {
        WCHAR swPath[MAX_PATH], nextVerPath[MAX_PATH];
        swprintf(swPath, MAX_PATH, L"%s\\.swap-ready", g_exeDir);
        swprintf(nextVerPath, MAX_PATH, L"%s\\gh555.com-next\\versions.json", g_exeDir);
        char swVer[64] = {0}, nextVer[64] = {0};
        if (readFileText(swPath, swVer, sizeof(swVer)) > 0 &&
            strcmp(swVer, serverVer) == 0 &&
            readManifestIdFile(nextVerPath, nextVer, sizeof(nextVer)) > 0 &&
            strcmp(nextVer, serverVer) == 0) {
            InterlockedExchange(&g_updateRunning, 0); return 0;
        }
    }
    // ★ 单元增量优先（2026-08-10 B 方案）: 只下载版本变化的架构单元
    //   （launcher/core/app/shell-out/webapp），任何异常自动回退全量 r。
    //   engines/* 不参与（component-checker 独立按 manifest 增量管理）。
    if (g_cfg.units_enabled && g_cfg.units_path[0] != '\0') {
        if (tryIncrementalUpdate(g_exeDir, serverVer) == 1) {
            InterlockedExchange(&g_updateRunning, 0);
            return 0;
        }
    }
    // 下载到暂存
    WCHAR rNext[MAX_PATH], rSigPath[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", g_exeDir);
    swprintf(rSigPath, MAX_PATH, L"%s\\r.next.sig", g_exeDir);

    // ★ 下载去重（2026-08-14）: r.next 已在盘且 .version-next 已是目标版本
    //   → 跳过重复下载，留给解压线程重试（解压持续失败时每启动重下 159MB = 纯带宽浪费，
    //   客户 40 次循环同款）。服务器出新版 → serverVer 变化 → 守卫自然放行重下。
    {
        WCHAR vnPath[MAX_PATH];
        swprintf(vnPath, MAX_PATH, L"%s\\.version-next", g_exeDir);
        char vnVer[64] = {0};
        if (fileExistsW(rNext) && fileExistsW(rSigPath) && readFileText(vnPath, vnVer, sizeof(vnVer)) > 0 &&
            strcmp(vnVer, serverVer) == 0) {
            swapLogNow(g_exeDir, "update: skip re-download r (%s staged, retry extract)", serverVer);
            InterlockedExchange(&g_updateRunning, 0);
            return 0;
        }
    }

    DeleteFileW(rNext);

    int result = downloadFile(g_cfg.update_host, g_cfg.r_path, rNext, g_cfg.use_https);
    if (result != 0 && g_cfg.use_https) {
        DeleteFileW(rNext);
        result = downloadFile(g_cfg.update_host, g_cfg.r_path, rNext, 0);
    }
    if (result != 0) {
        swapLogNow(g_exeDir, "update: download r FAIL (err=%d, fallback next boot)", result);
        DeleteFileW(rNext); InterlockedExchange(&g_updateRunning, 0); return 0;
    }

    // ★ 下载签名（2026-08-27 安全）: r.next 必须配 r.next.sig（64B Ed25519），
    //   解压线程验签通过才解压。sig 下载失败 → 删 r.next 下次重试（方向安全）。
    {
        DeleteFileW(rSigPath);
        char sigPath[300];
        snprintf(sigPath, sizeof(sigPath), "%s.sig", g_cfg.r_path);
        int sr = downloadFile(g_cfg.update_host, sigPath, rSigPath, g_cfg.use_https);
        if (sr != 0 && g_cfg.use_https) {
            DeleteFileW(rSigPath);
            sr = downloadFile(g_cfg.update_host, sigPath, rSigPath, 0);
        }
        if (sr != 0) {
            swapLogNow(g_exeDir, "update: r.sig download FAIL (err=%d, security keep old version)", sr);
            DeleteFileW(rNext); DeleteFileW(rSigPath);
            InterlockedExchange(&g_updateRunning, 0);
            return 0;
        }
    }

    // 写 .version-next
    WCHAR vNext[MAX_PATH];
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", g_exeDir);
    writeFileText(vNext, serverVer);
    swapLogNow(g_exeDir, "update: r.next downloaded OK (%s), extracting in-session", serverVer);

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

// ★ VC 运行库 app-local 部署 — 把 vc_runtime 目录注入 PATH
//   Win7 SP1 无 KB2999226 / 缺 VC 运行库的机器 → joker/python/git 等子进程从此目录解析 DLL
static void injectRuntimePath(const WCHAR *exeDir) {
    WCHAR vcDir[MAX_PATH];
    swprintf(vcDir, MAX_PATH, L"%s\\gh555.com\\resources\\app\\engines\\vc_runtime\\win32-x64", exeDir);
    if (GetFileAttributesW(vcDir) == INVALID_FILE_ATTRIBUTES) {
        // dev 模式(无 gh555.com): 项目根 engines\vc_runtime\win32-x64
        swprintf(vcDir, MAX_PATH, L"%s\\engines\\vc_runtime\\win32-x64", exeDir);
    }
    if (GetFileAttributesW(vcDir) == INVALID_FILE_ATTRIBUTES) return;

    WCHAR newPath[32768];
    DWORD n = GetEnvironmentVariableW(L"PATH", newPath, 32768);
    WCHAR full[32768];
    if (n > 0 && n < 32768) {
        swprintf(full, 32768, L"%s;%s", vcDir, newPath);
    } else {
        wcscpy(full, vcDir);
    }
    SetEnvironmentVariableW(L"PATH", full);
}

static int launchCore(void) {
    WCHAR exePath[MAX_PATH], exeDir[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);
    wcscpy(exeDir, exePath);
    WCHAR *p = wcsrchr(exeDir, L'\\');
    if (p) *p = L'\0';

    // ★ 注入 VC 运行库目录到 PATH（joker.exe 及其所有子进程可见）
    injectRuntimePath(exeDir);

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

        // ★ 升级连续失败 ≥3 次 → 红色错误行（2026-08-14，客户 40 次静默死循环实锤）
        if (g_err && g_status[0]) {
            WCHAR wErr[200];
            MultiByteToWideChar(CP_UTF8, 0, g_status, -1, wErr, 200);
            SetTextColor(hdc, RGB(0xdc, 0x32, 0x2f));
            RECT er = {16, 178, WW - 16, 204};
            DrawTextW(hdc, wErr, -1, &er, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        }

        // 2026-08-06: 状态文字已移除 — 启动窗只显示 标题 + 进度条 + 百分比
        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_TIMER: {
        g_tickCount++;

        switch (g_phase) {
        case PHASE_INIT:
            if (g_tickCount >= 1) {
                // ★ 升级连续失败暴露（2026-08-14）: .apply-fails ≥3 → 启动窗红色错误行
                {
                    WCHAR fPath[MAX_PATH];
                    GetModuleFileNameW(NULL, fPath, MAX_PATH);
                    WCHAR *fs = wcsrchr(fPath, L'\\');
                    if (fs) *fs = L'\0';
                    WCHAR fFull[MAX_PATH];
                    swprintf(fFull, MAX_PATH, L"%s\\.apply-fails", fPath);
                    char fbuf[32] = {0};
                    if (readFileText(fFull, fbuf, sizeof(fbuf)) > 0 && atoi(fbuf) >= 3) {
                        snprintf(g_status, sizeof(g_status), "auto-update failed %s times, retry after reboot", fbuf);
                        g_err = 1;
                    }
                }
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
            maybeStartApplyThread();
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

            // ★ 下载完成即解压（2026-08-14）: 后台下载完 r.next+.version-next → 本会话立即解压
            //   → 全量升级 2 次启动完成（下载+解压同会话，仅交换等下次启动）
            maybeStartApplyThread();

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

    // ★ 单实例 Mutex（OS 内核对象，100% 原子，零竞态窗口）
    //   替代旧 FindWindowW 先行检测（旧方案存在窗口创建前的毫秒级竞态窗口）
    //   流程：Mutex 原子检测 → 非首例则杀旧进程 → 重试 → 继续启动
    HANDLE hMutex = CreateMutexW(NULL, TRUE, L"QqqIdeLauncher");
    int firstInstance = (hMutex != NULL && GetLastError() != ERROR_ALREADY_EXISTS);

    if (!firstInstance) {
        if (hMutex) { CloseHandle(hMutex); hMutex = NULL; }
        // 已有实例 → 找到旧窗口 → 强杀 → 重试 Mutex
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
        }
        // 重试 Mutex（旧 launcher 进程可能已销毁窗口但仍在清理中）
        hMutex = CreateMutexW(NULL, TRUE, L"QqqIdeLauncher");
        if (hMutex && GetLastError() == ERROR_ALREADY_EXISTS) {
            // ★ 旧实例还活着（通常正等后台解压线程退出）→ 绝不双开：
            //   把已运行的 joker 窗口带到前台，本实例直接退出。
            if (hMutex) { CloseHandle(hMutex); hMutex = NULL; }
            bringJokerToFront(L"joker.exe");
            return 0;
        }
    }
    // hMutex 随进程退出由 OS 自动释放，无需显式 CloseHandle

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

    // ★ 启动器自更新善后（2026-08-06）: 清理上次三明治替换残留的 .old.exe
    {
        WCHAR oldPath[MAX_PATH];
        swprintf(oldPath, MAX_PATH, L"%s\\qqqide.old.exe", myDir);
        if (fileExistsW(oldPath)) {
            DeleteFileW(oldPath);
        }
    }

    // ★ 加载配置（缓存 → 服务器 → 默认值）
    //   注意：服务器拉取在这里做（启动前），因为需要 host/path 等配置。
    //   但网络失败不阻塞——缓存或默认值兜底。
    loadConfig(myDir);

    // ★ Q 记录：写系统环境变量，兜底 Python 路径
    writeQRecord(myDir);

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
        // ★ 上次三明治替换失败的补救（失败时 next 保留，此处重试）
        tryLauncherSelfReplace(myDir);
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

    // ★ 根目录自清洁: 删除启动器自身一切临时产物（r/r.next/版本残留/调试日志/旧配置）
    cleanupRootJunk(myDir);

    // ★ 旧根 Data 迁移: 泄漏残留 → 救援 alphal 入保险库（gh555.com/Data）后整树删除
    migrateLegacyRootData(myDir);

    // ★ 首次运行解压完成后重写 Q 记录（2026-08-14 客户事故）:
    //   首次启动 gh555.com 尚不存在 → 上面那次写入误落 dev 兜底路径
    //   （注册表残留 "…\engines\python" 不存在的路径）。此时布局已就绪，重写为真值。
    writeQRecord(myDir);

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
