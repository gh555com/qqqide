// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

// ============================================================================
// launcher.c — qqqide 原生启动器（Win32 API，零外部依赖）
//
// ★ Bootstrap Config 架构（2026-07-18）
//   唯一硬编码: CONFIG_URL → 下载 launcher-config.json → 一切行为由配置驱动
//   配置可随时在服务器更新，用户永不需要重新下载绿色包。
//   配置缓存到本地，离线时用缓存+内置默认值兜底。
//
// ★ 架构（2026-08-31 定案）: 下载/验签/解压 100% 由壳层在 IDE 正常运行期间后台执行
//   （shell/auto-updater.ts）。启动器职责: 秒弹窗 → 启动 joker → 下次开机原子交换
//   （交换前对 r.next 二次验签）。启动器零下载线程 → 启动零等待 / 退出零等待 /
//   第二实例零等待（点击必弹窗）。
//   更新契约文件（与 auto-updater.ts 共享）: r.next / r.next.sig / .version-next /
//   r.next.meta / .swap-ready / gh555.com-next / Data/launcher-swap.log / .apply-fails
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
#define LAUNCHER_VERSION "20260831.3"

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
typedef struct { HWND self; HWND found; } FindWindowCtx2;
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

// ★ 第二实例: 找到另一个启动器窗口（排除本窗口）——旧启动器正在收尾/首装/交换时唤起它
static BOOL CALLBACK findOtherLauncher(HWND hwnd, LPARAM lParam) {
    FindWindowCtx2 *ctx = (FindWindowCtx2 *)lParam;
    if (hwnd == ctx->self) return TRUE;
    WCHAR cls[64];
    if (GetClassNameW(hwnd, cls, 64) > 0 && wcscmp(cls, L"QqqIdeLauncher") == 0) {
        ctx->found = hwnd;
        return FALSE;
    }
    return TRUE;
}
static HWND findOtherLauncherWindow(HWND self) {
    FindWindowCtx2 ctx = { self, NULL };
    EnumWindows(findOtherLauncher, (LPARAM)&ctx);
    return ctx.found;
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

// 下载文件到磁盘
static int downloadFile(const char *host, const char *path,
                         const WCHAR *dest, int useHttps) {
    WCHAR wHost[256], wPath[512];
    toWide(host, wHost, 256);
    toWide(path, wPath, 512);

    HINTERNET hSession = WinHttpOpen(L"qqqide-launcher/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) {
        swapLogPersist(g_exeDir, "download: WinHttpOpen FAIL");
        return -1;
    }

    HINTERNET hConnect = WinHttpConnect(hSession, wHost,
        useHttps ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT, 0);
    if (!hConnect) {
        char dbg[160];
        snprintf(dbg, sizeof(dbg), "download %hs: WinHttpConnect FAIL err=%lu", path, GetLastError());
        swapLogPersist(g_exeDir, dbg);
        WinHttpCloseHandle(hSession); return -1;
    }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", wPath, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        useHttps ? WINHTTP_FLAG_SECURE : 0);
    if (!hRequest) {
        char dbg[160];
        snprintf(dbg, sizeof(dbg), "download %hs: WinHttpOpenRequest FAIL err=%lu", path, GetLastError());
        swapLogPersist(g_exeDir, dbg);
        WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1;
    }

    enableTls12(hRequest);

    DWORD timeout = 60000; // 文件下载固定 60s
    WinHttpSetOption(hRequest, WINHTTP_OPTION_CONNECT_TIMEOUT, &timeout, sizeof(timeout));
    WinHttpSetOption(hRequest, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));

    if (g_cfg.follow_redirect) {
        DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
        WinHttpSetOption(hRequest, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));
    }

    // ★ 断点续传（2026-08-31 慢网络死循环根治）: dest 已存在 → Range 从现有大小续传。
    //   65MB 增量 @90KB/s 需 12+ 分钟，任何中断（用户重开/硬上限/看门狗）进度清零
    //   → 永远升不上去（E:\s\w 机器三次 begin 零后续实锤）。CDN（R2/OSS）均支持 Range。
    //   安全: 后续 sha512 清单校验 + 7z CRC + Ed25519 验签三重裁决，损坏必重下。
    DWORD existingSize = 0;
    if (fileExistsW(dest)) {
        HANDLE hf = CreateFileW(dest, GENERIC_READ, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hf != INVALID_HANDLE_VALUE) {
            existingSize = GetFileSize(hf, NULL);
            CloseHandle(hf);
        }
    }
    WCHAR wRange[64];
    const WCHAR *headers = WINHTTP_NO_ADDITIONAL_HEADERS;
    if (existingSize > 0) {
        swprintf(wRange, 64, L"Range: bytes=%lu-\r\n", existingSize);
        headers = wRange;
    }

    BOOL ok = WinHttpSendRequest(hRequest, headers, -1L,
        WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
    if (!ok) {
        char dbg[160];
        snprintf(dbg, sizeof(dbg), "download %hs: WinHttpSendRequest FAIL err=%lu", path, GetLastError());
        swapLogPersist(g_exeDir, dbg);
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1;
    }

    ok = WinHttpReceiveResponse(hRequest, NULL);
    if (!ok) {
        char dbg[160];
        snprintf(dbg, sizeof(dbg), "download %hs: WinHttpReceiveResponse FAIL err=%lu", path, GetLastError());
        swapLogPersist(g_exeDir, dbg);
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1;
    }

    DWORD statusCode = 0, statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (statusCode != 200 && statusCode != 206 && statusCode != 416) {
        char dbg[128];
        snprintf(dbg, sizeof(dbg), "download %hs: unexpected status %lu", path, statusCode);
        swapLogPersist(g_exeDir, dbg);
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return -1;
    }
    // 416 Range Not Satisfiable = 本地文件已 ≥ 服务器大小 → 视为无需再下，
    //   由调用方校验层（hash/验签/CRC）裁决完整性，不符自然删除重下。
    if (statusCode == 416) {
        char dbg[128];
        snprintf(dbg, sizeof(dbg), "download %hs: 416 (local already complete, ex=%lu)", path, existingSize);
        swapLogPersist(g_exeDir, dbg);
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return 0;
    }

    DWORD contentLen = 0, clSize = sizeof(contentLen);
    BOOL clOk = WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &contentLen, &clSize, WINHTTP_NO_HEADER_INDEX);
    // ★ 完整性检查前置（2026-08-31 应急通道实锤）: Content-Length 查询失败 →
    //   expectTotal=0 → 完整性检查被跳过 → 半截文件假成功（rc=0）→ 验签失败删文件
    //   → 每启动重下 179MB 死循环。查询失败/无 CL 一律拒绝（方向安全）。
    if (!clOk || contentLen == 0) {
        swapLogPersist(g_exeDir, "download FAIL: no Content-Length (cannot verify completeness)");
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return -1;
    }

    // 206 → 追加写（断点续传）；200 → 从头写（服务器忽略 Range）
    HANDLE hFile = CreateFileW(dest, GENERIC_WRITE, 0, NULL,
        (statusCode == 206) ? OPEN_ALWAYS : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        WinHttpCloseHandle(hRequest); WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession);
        return -1;
    }
    if (statusCode == 206) SetFilePointer(hFile, 0, NULL, FILE_END);

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
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);

    // 校验: 206 → 完整大小 = existingSize + contentLen（contentLen 为剩余量）；200 → contentLen 全量
    DWORD expectTotal = contentLen;
    if (statusCode == 206) expectTotal += existingSize;
    if (statusCode == 206 && totalDownloaded == 0) {
        swapLogPersist(g_exeDir, "download: 206 but 0 bytes read (stalled)");
        return -1;
    }
    if (expectTotal > 0 && existingSize + totalDownloaded < expectTotal * 0.99) {
        char dbg[160];
        snprintf(dbg, sizeof(dbg), "download %hs: INCOMPLETE got=%luB clen=%lu ex=%lu (partial, retry next)",
            path, totalDownloaded, contentLen, existingSize);
        swapLogPersist(g_exeDir, dbg);
        return -1;
    }
    // ★ 下载诊断日志（2026-08-31）: 任何下载结果留痕（code/got/clen/ex/total），终结盲猜
    {
        char dbg[256];
        snprintf(dbg, sizeof(dbg), "download %hs: code=%lu got=%luB clen=%lu ex=%lu total=%luB rc=%d",
            path, statusCode, totalDownloaded, contentLen, existingSize,
            existingSize + totalDownloaded, (totalDownloaded > 0) ? 0 : -1);
        swapLogPersist(g_exeDir, dbg);
    }
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
    // ★ m 必须分配 n = dataLen+64 字节（2026-08-31 实锤）: crypto_sign_open 向 m 写入
    //   R||pk||message 全量（n 字节），不是只写消息——malloc(dataLen) 越界 64 字节，
    //   小文件靠堆对齐侥幸通过，179MB 真实 r 必挂 → 全量更新验签恒失败（"signature
    //   INVALID" + 清暂存 + 每启动重下 179MB 死循环）。F22 只修了 m/sm 同址问题，
    //   漏了这个缓冲区尺寸错误。
    u8 *m = (u8 *)malloc(dataLen + 64);
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
    // ★ 专用二进制读取（2026-08-31 实锤）: readFileRaw 是文本语义（ReadFile bufSize-1
    //   + 尾部 \0）——读 64B 签名只返回 63 字节 → 验签恒败（"sig read rc=63"）。
    //   C 端全量验签从 20260827.1 起双重失效（此截断 + verifySignedBuf m 缓冲越界），
    //   所有走全量 r 的客户端下载完成后必被拒——本函数必须一次读满 64 字节。
    HANDLE hs = CreateFileW(sigPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hs == INVALID_HANDLE_VALUE) {
        char dbg[192];
        snprintf(dbg, sizeof(dbg), "verify: sig open FAIL err=%lu (%ls)", GetLastError(), sigPath);
        swapLogPersist(g_exeDir, dbg);
        return -1;
    }
    DWORD rd = 0;
    BOOL ok = ReadFile(hs, sig, 64, &rd, NULL);
    CloseHandle(hs);
    if (!ok || rd != 64) {
        char dbg[192];
        snprintf(dbg, sizeof(dbg), "verify: sig read rc=%lu err=%lu (%ls)", rd, GetLastError(), sigPath);
        swapLogPersist(g_exeDir, dbg);
        return -1;
    }
    size_t dataLen = 0;
    u8 *data = readFileAlloc(filePath, &dataLen);
    if (!data) {
        swapLogPersist(g_exeDir, "verify: data read FAIL (missing/locked/oversize)");
        return -1;
    }
    char dbg[128];
    snprintf(dbg, sizeof(dbg), "verify: dataLen=%llu (0x%llx)", (unsigned long long)dataLen, (unsigned long long)dataLen);
    swapLogPersist(g_exeDir, dbg);
    int rc = verifySignedBuf(data, dataLen, sig, 64);
    free(data);
    return rc;
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

static int extractPayload(const WCHAR *rPath, const WCHAR *exeDir, int keepR) {
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
            // ★ 解压总超时（2026-08-30）: SFX 卡死 → 10 分钟强杀，防永久挂起
            if (++ticks > 2400) {
                TerminateProcess(pi.hProcess, 1);
                WaitForSingleObject(pi.hProcess, 5000);
                GetExitCodeProcess(pi.hProcess, &ec);
                break;
            }
            if (ticks < 36 && ticks % 4 == 0 && g_pct < 90) {
                g_pct += 9;
                if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
            }
        }
    }
    CloseHandle(pi.hProcess);
    if (ec != 0) { setStatus("extract error", 1); return -1; }

    // 验证 joker.exe 存在
    //   ★ 回退 DEFAULT_CFG（2026-08-31）: 应急通道在 loadConfig 前执行，g_cfg 为零值
    WCHAR check[MAX_PATH];
    WCHAR wJoker[256];
    toWide(g_cfg.joker_exe[0] ? g_cfg.joker_exe : DEFAULT_CFG.joker_exe, wJoker, 256);
    swprintf(check, MAX_PATH, L"%s\\%s", exeDir, wJoker);
    if (!fileExistsW(check)) { setStatus("extract incomplete", 1); return -1; }

    // 清理 r 文件（keepR=1: 应急通道保留 r.next 供交换前二次验签，不删）
    if (!keepR) {
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
    }
    return 0;
}


// ★ 应急全量更新通道（2026-08-31，壳层单点故障兜底）:
//   正常架构: 更新下载/验签/解压 100% 在壳层（IDE 正常运行期间后台执行），启动器零下载。
//   兜底: 壳层通道连续失败 ≥3 次（.apply-fails≥3，壳层自身损坏/被杀/增量死循环）→ 启动器
//   亲自走旧式全量链路: 下载 r.next(+r.next.sig，断点续传) → Ed25519 验签 → 解压
//   gh555.com-next → 写 .swap-ready → 下次启动走交换全守卫（二次验签+防降级+数据备份）。
//   方向安全: 验签失败拒更新保留旧版；正常时零开销（一次 stat 判定）。
static void emergencyFullUpdate(const WCHAR *exeDir) {
    char logBuf[4096] = {0};
    WCHAR failPath[MAX_PATH], swapReady[MAX_PATH], rNext[MAX_PATH], rSig[MAX_PATH];
    WCHAR ghNext[MAX_PATH], tmpDir[MAX_PATH], extracted[MAX_PATH], vPath[MAX_PATH];
    WCHAR vNext[MAX_PATH], metaPath[MAX_PATH];
    char fbuf[32] = {0};
    char ver[64] = {0};
    char sigPath[300];
    int dlRc = -1;
    HANDLE hf;

    // 1. 仅当壳层连续失败确认（≥3）才激活；已有挂起交换 → 无事可做
    swprintf(failPath, MAX_PATH, L"%s\\.apply-fails", exeDir);
    if (readFileText(failPath, fbuf, sizeof(fbuf)) <= 0 || atoi(fbuf) < 3) return;
    swprintf(swapReady, MAX_PATH, L"%s\\.swap-ready", exeDir);
    if (fileExistsW(swapReady)) return;

    swprintf(rNext, MAX_PATH, L"%s\\r.next", exeDir);
    swprintf(rSig, MAX_PATH, L"%s\\r.next.sig", exeDir);
    swprintf(ghNext, MAX_PATH, L"%s\\gh555.com-next", exeDir);
    swprintf(tmpDir, MAX_PATH, L"%s\\.r-extract-tmp", exeDir);

    swapLogAppend(logBuf, sizeof(logBuf), "emergency update: activated (.apply-fails=%s, full r fallback)", fbuf);
    setStatus("emergency update: downloading…", 0);
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }

    // 2. 下载 r.next —— downloadFile 天然幂等: 缺 → 全量；半截 → 206 断点续传；
    //    完整 → 416 视为无需再下（返回 0）。绝不能只按存在性跳过（半截文件
    //    会被验签拒绝后删除 = 续传破坏，每次启动重下 179MB）。
    //    ★ 用 DEFAULT_CFG（2026-08-31）: 应急通道在 loadConfig 之前执行（避免 39 秒
    //   配置网络阻塞），g_cfg 此时为零——默认配置与正式更新同源（编译期常量）。
    dlRc = downloadFile(DEFAULT_CFG.update_host, DEFAULT_CFG.r_path, rNext, DEFAULT_CFG.use_https);
    if (dlRc != 0 && DEFAULT_CFG.use_https) {
        dlRc = downloadFile(DEFAULT_CFG.update_host, DEFAULT_CFG.r_path, rNext, 0);
    }
    if (dlRc != 0 || !fileExistsW(rNext)) {
        swapLogAppend(logBuf, sizeof(logBuf), "emergency update FAIL: r.next download err");
        swapLogFlush(exeDir, logBuf);
        return;
    }
    // 3. 下载签名（r_path + ".sig"，与壳层同款 URL 构造；同样幂等）
    snprintf(sigPath, sizeof(sigPath), "%s.sig", DEFAULT_CFG.r_path);
    dlRc = downloadFile(DEFAULT_CFG.update_host, sigPath, rSig, DEFAULT_CFG.use_https);
    if (dlRc != 0 && DEFAULT_CFG.use_https) {
        dlRc = downloadFile(DEFAULT_CFG.update_host, sigPath, rSig, 0);
    }
    if (dlRc != 0 || !fileExistsW(rSig)) {
        swapLogAppend(logBuf, sizeof(logBuf), "emergency update FAIL: r.sig download err (keep old version)");
        DeleteFileW(rNext);
        swapLogFlush(exeDir, logBuf);
        return;
    }
    // 4. 强制验签（方向安全: 失败拒更新保留旧版）
    {
        char dbg[192];
        DWORD szr = 0, szs = 0;
        HANDLE hf = CreateFileW(rNext, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hf != INVALID_HANDLE_VALUE) { szr = GetFileSize(hf, NULL); CloseHandle(hf); }
        HANDLE hs = CreateFileW(rSig, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (hs != INVALID_HANDLE_VALUE) { szs = GetFileSize(hs, NULL); CloseHandle(hs); }
        snprintf(dbg, sizeof(dbg), "verify pre: r.next=%luB r.next.sig=%luB (both open err=%lu)", szr, szs, GetLastError());
        swapLogPersist(g_exeDir, dbg);
    }
    if (verifySignedFile(rNext, rSig) != 0) {
        swapLogAppend(logBuf, sizeof(logBuf), "emergency update FAIL: r.next signature INVALID (security, keep old version)");
        // ★ 现场保留（2026-08-31 诊断）: 改名而非删除——r.next.fail 可离线验签定位
        //   （下载层 vs 验签层），下次启动 downloadFile 看不到 r.next 自然重下，不阻塞
        {
            WCHAR failR[MAX_PATH], failS[MAX_PATH];
            swprintf(failR, MAX_PATH, L"%s\\r.next.fail", exeDir);
            swprintf(failS, MAX_PATH, L"%s\\r.next.sig.fail", exeDir);
            DeleteFileW(failR); DeleteFileW(failS);
            MoveFileW(rNext, failR);
            MoveFileW(rSig, failS);
        }
        swapLogFlush(exeDir, logBuf);
        return;
    }
    // 5. 解压到临时目录（keepR=1: r.next 保留，供交换前二次验签）
    //   ★ tmpDir 必须先创建（2026-08-31 实锤）: CreateProcessW 的 lpCurrentDirectory
    //   不存在 → 直接失败（err=267）→ "extract err" 死循环。
    removeDir(tmpDir);
    CreateDirectoryW(tmpDir, NULL);
    if (extractPayload(rNext, tmpDir, 1) != 0) {
        swapLogAppend(logBuf, sizeof(logBuf), "emergency update FAIL: extract err");
        removeDir(tmpDir);
        swapLogFlush(exeDir, logBuf);
        return;
    }
    swprintf(extracted, MAX_PATH, L"%s\\gh555.com", tmpDir);
    if (!fileExistsW(extracted)) {
        swapLogAppend(logBuf, sizeof(logBuf), "emergency update FAIL: payload has no gh555.com");
        removeDir(tmpDir);
        swapLogFlush(exeDir, logBuf);
        return;
    }
    // 6. 上移为 gh555.com-next（旧 next 未交换 → 过期/残缺，先清）
    removeDir(ghNext);
    if (!MoveFileW(extracted, ghNext)) {
        swapLogAppend(logBuf, sizeof(logBuf), "emergency update FAIL: move gh555.com-next err=%lu", GetLastError());
        removeDir(tmpDir);
        swapLogFlush(exeDir, logBuf);
        return;
    }
    removeDir(tmpDir);
    // 7. 写 .version-next / r.next.meta / .swap-ready（下次启动 applySwapIfReady 全守卫交换）
    swprintf(vPath, MAX_PATH, L"%s\\versions.json", ghNext);
    readManifestIdFile(vPath, ver, sizeof(ver));
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", exeDir);
    hf = CreateFileW(vNext, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hf != INVALID_HANDLE_VALUE) { DWORD wb; WriteFile(hf, ver, (DWORD)strlen(ver), &wb, NULL); CloseHandle(hf); }
    swprintf(metaPath, MAX_PATH, L"%s\\r.next.meta", exeDir);
    { char meta[96]; snprintf(meta, sizeof(meta), "{\"v\":\"%s\"}", ver);
      hf = CreateFileW(metaPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
      if (hf != INVALID_HANDLE_VALUE) { DWORD wb; WriteFile(hf, meta, (DWORD)strlen(meta), &wb, NULL); CloseHandle(hf); } }
    hf = CreateFileW(swapReady, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hf != INVALID_HANDLE_VALUE) { DWORD wb; WriteFile(hf, ver, (DWORD)strlen(ver), &wb, NULL); CloseHandle(hf); }
    swapLogAppend(logBuf, sizeof(logBuf), "emergency update OK: staged %s (swap at next boot, apply-fails kept till swap)", ver[0] ? ver : "?");
    swapLogFlush(exeDir, logBuf);
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

    // ★ 交换前二次验签（2026-08-31 架构）: 下载/验签/解压已移至壳层（正常运行期间后台执行）。
    //   此处防御: r.next 仍在盘（全量路径）→ 必须仍带合法签名才交换——防本地篡改/磁盘损坏/
    //   壳层异常写 .swap-ready。增量路径无 r.next → 跳过（单元完整性由壳层按已验签 sidecar
    //   sha512 校验，签名边界在壳层）。验签失败 → 清暂存，下次壳层会话重新下载（方向安全）。
    {
        WCHAR rNextV[MAX_PATH], rNextSigV[MAX_PATH];
        swprintf(rNextV, MAX_PATH, L"%s\\r.next", exeDir);
        swprintf(rNextSigV, MAX_PATH, L"%s\\r.next.sig", exeDir);
        if (fileExistsW(rNextV)) {
            if (!fileExistsW(rNextSigV) || verifySignedFile(rNextV, rNextSigV) != 0) {
                swapLogAppend(logBuf, sizeof(logBuf), "swap abort: r.next signature INVALID (security)");
                DeleteFileW(swapReady);
                removeDir(ghNext);
                DeleteFileW(rNextV); DeleteFileW(rNextSigV);
                { WCHAR tmp[MAX_PATH];
                  swprintf(tmp, MAX_PATH, L"%s\\.version-next", exeDir); DeleteFileW(tmp);
                  swprintf(tmp, MAX_PATH, L"%s\\r.next.meta", exeDir); DeleteFileW(tmp); }
                swapLogFlush(exeDir, logBuf);
                return 0;
            }
            swapLogAppend(logBuf, sizeof(logBuf), "swap: r.next signature OK (full-path update)");
        }
    }

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
    // ★ 交换完成 → r.next 全家消费完毕，清理（2026-08-31: r.next 由壳层下载，启动器交换后删除）
    {
        WCHAR tmp[MAX_PATH];
        swprintf(tmp, MAX_PATH, L"%s\\r.next", exeDir); DeleteFileW(tmp);
        swprintf(tmp, MAX_PATH, L"%s\\r.next.sig", exeDir); DeleteFileW(tmp);
        swprintf(tmp, MAX_PATH, L"%s\\.version-next", exeDir); DeleteFileW(tmp);
        swprintf(tmp, MAX_PATH, L"%s\\r.next.meta", exeDir); DeleteFileW(tmp);
    }
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
    // ★ 断点续传保留（2026-08-31）: r.next/r.next.sig/.version-next 半截或暂存文件不再启动即清——
    //   慢网络中断后下次启动 Range 续传（曾无条件删 → 每启动重下 178MB 永远升不上去）。
    //   完整下载/解压成功后由下载与解压线程自然清理；.version-next 匹配时下载去重守卫直接跳过。
    static const WCHAR *plainFiles[] = {
        L"r", L"debug.log",
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
    // ★ 嵌套载荷污染（2026-08-30 实锤）: r 载荷被错误解压进活目录 → gh555.com\gh555.com
    //   （含 versions.json = 载荷特征，活目录永不应含嵌套 gh555.com）+ gh555.com\qqqide.exe。
    //   自动清除；仅当嵌套目录含 versions.json 才删（防误删用户自建目录）；
    //   被占用删不掉 → 下次启动再清。
    swprintf(p, MAX_PATH, L"%s\\gh555.com\\gh555.com", exeDir);
    if (fileExistsW(p)) {
        WCHAR nestedV[MAX_PATH];
        swprintf(nestedV, MAX_PATH, L"%s\\versions.json", p);
        if (fileExistsW(nestedV)) {
            swapLogNow(exeDir, "cleanup: nested payload gh555.com\\gh555.com removed (pollution)");
            removeDir(p);
        }
    }
    swprintf(p, MAX_PATH, L"%s\\gh555.com\\qqqide.exe", exeDir);
    if (fileExistsW(p)) DeleteFileW(p);
    // 单元增量暂存（2026-08-31 起保留: 半截单元 7z 是断点续传资本；
    //   解压成功/装配失败由 tryIncrementalUpdate 自行清理）
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
        DrawTextW(hdc, L"qd (qqqide)", -1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
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
            // ★ 2026-08-31 架构: 启动器零下载/解压线程（全部移至壳层正常运行期间后台执行）
            if (g_tickCount <= 20 && g_tickCount % 4 == 0 && g_pct < 60) {
                g_pct += 8;
            }
            if (g_tickCount >= 6) {
                g_phase = PHASE_WAITING;
            }
            break;

        case PHASE_WAITING: {
            // ★ 2026-08-31 架构: 启动器唯一职责 = 持有单实例 Mutex + 等 joker。
            //   joker 主窗口出现 → 隐藏自身（进程保持存活持有 Mutex，二次点击唤起已有实例）；
            //   joker 进程退出 → 立即退出（零等待——旧实现等后台线程最长 30 分钟 =
            //   关闭卡死 + 第二实例「点击半天没反应」根因，已随下载线程整体移除）
            if (g_jokerPid != 0) {
                HWND jwnd = findJokerMainWindow(g_jokerPid);
                if (jwnd != NULL && IsWindowVisible(hwnd)) {
                    ShowWindow(hwnd, SW_HIDE);
                }
            }
            if (g_hProcess) {
                DWORD ec = 0;
                if (GetExitCodeProcess(g_hProcess, &ec) && ec != STILL_ACTIVE) {
                    g_phase = PHASE_DONE;
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    return 0;
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

    case WM_CLOSE:
        // ★ 2026-08-31 架构: 无后台线程 → 直接退出（旧退出闸门/30 分钟硬上限已随下载线程移除）
        return DefWindowProcW(hwnd, msg, w, l);

    case WM_LBUTTONDOWN:
        SendMessage(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
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

    // ★★★ 窗口最先创建并显示（2026-08-31 实锤: 旧代码先拉配置/检查首装才建窗，
    //   慢网络下点击半天无窗口——「点击必弹窗」硬保证，无论任何情况）
    g_hwnd = CreateWindowExW(0, CLASS, L"qd (qqqide)",
        WS_POPUP | WS_BORDER, 0, 0, WW, WH, NULL, NULL, hi, NULL);
    if (!g_hwnd) return 1;
    centerWindow(g_hwnd);
    ShowWindow(g_hwnd, (nShow == SW_SHOWMINIMIZED || nShow == 0) ? SW_SHOW : nShow);
    UpdateWindow(g_hwnd);
    setStatus("starting…", 0);

    // ── 确定工作目录 ──
    WCHAR myDir[MAX_PATH];
    GetModuleFileNameW(NULL, myDir, MAX_PATH);
    WCHAR *s = wcsrchr(myDir, L'\\');
    if (s) *s = L'\0';
    wcscpy(g_exeDir, myDir);

    // ★ 单实例 Mutex（OS 内核对象，100% 原子，零竞态窗口）
    HANDLE hMutex = CreateMutexW(NULL, TRUE, L"QqqIdeLauncher");
    int firstInstance = (hMutex != NULL && GetLastError() != ERROR_ALREADY_EXISTS);

    if (!firstInstance) {
        // ★ 第二实例（2026-08-31）: 窗口已秒弹 → 零等待零强杀零 15 分钟等待——
        //   旧实现等旧实例后台线程最长 15 分钟 = 「点击半天没反应」根因，已整体移除
        //   （新架构启动器无后台线程: joker 在跑 → 唤起 IDE；joker 没跑 → 旧启动器
        //   正在收尾/首装/交换，最多等 5s 接棒，接不到则唤起旧窗口后退出）
        setStatus("already running…", 0);
        InvalidateRect(g_hwnd, NULL, TRUE);
        UpdateWindow(g_hwnd);
        pumpMessages();
        if (isProcessRunning(L"joker.exe")) {
            bringJokerToFront(L"joker.exe");
        } else {
            for (int i = 0; i < 50; i++) {   // 最多等 5s（旧启动器收尾是秒级）
                if (hMutex) { CloseHandle(hMutex); hMutex = NULL; }
                hMutex = CreateMutexW(NULL, TRUE, L"QqqIdeLauncher");
                if (hMutex && GetLastError() != ERROR_ALREADY_EXISTS) { firstInstance = 1; break; }
                Sleep(100);
            }
            if (!firstInstance) {
                HWND other = findOtherLauncherWindow(g_hwnd);
                if (other) { ShowWindow(other, SW_RESTORE); SetForegroundWindow(other); }
            }
        }
        if (!firstInstance) {
            if (hMutex) { CloseHandle(hMutex); hMutex = NULL; }
            Sleep(300);
            DestroyWindow(g_hwnd);
            return 0;
        }
    }
    // hMutex 随进程退出由 OS 自动释放，无需显式 CloseHandle

    // ★ 启动器自更新善后（2026-08-06）: 清理上次三明治替换残留的 .old.exe
    {
        WCHAR oldPath[MAX_PATH];
        swprintf(oldPath, MAX_PATH, L"%s\\qqqide.old.exe", myDir);
        if (fileExistsW(oldPath)) {
            DeleteFileW(oldPath);
        }
    }

    // ★ 快速交换优先（2026-08-31 架构）: 交换/自替换不依赖网络配置——
    //   先于 loadConfig 执行，慢网络拉配置不再拖延「更新已生效」（沙箱实测
    //   配置拉取曾拖 50s；窗口虽已秒弹，交换越早越稳）
    tryLauncherSelfReplace(myDir);
    applySwapIfReady(myDir);

    // ★ 应急全量更新（2026-08-31）: 壳层连续失败 ≥3 次 → 启动器亲自下载+验签+解压
    //   并写 .swap-ready，下次启动交换——单点故障兜底，正常时零开销。
    //   ★ 必须在 loadConfig 之前（沙箱实测 loadConfig 网络拉取可阻塞 39 秒——
    //   应急通道用户已连续失败 ≥3 次，绝不能让它再等配置网络）；g_cfg 有编译期
    //   默认值（update_host/r_path/use_https），与正式更新同源，零风险。
    emergencyFullUpdate(myDir);

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
                if (extractPayload(rPath, myDir, 0) == 0) {
                    g_pct = 100;
                    setStatus("ready", 0);
                    InvalidateRect(g_hwnd, NULL, TRUE);
                    UpdateWindow(g_hwnd);
                    Sleep(300);
                }
            }
        } else {
            if (extractPayload(rPath, myDir, 0) == 0) {
                g_pct = 100;
                setStatus("ready", 0);
                InvalidateRect(g_hwnd, NULL, TRUE);
                UpdateWindow(g_hwnd);
                Sleep(300);
            }
        }
    } else {
        // ── 已安装 → 清理残留 r（交换已在上方快速执行）──
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

    // ★ 2026-08-31: 无后台线程，无线程清理（旧实现等下载/解压线程最长 120s = 退出卡死根因）
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
