// ============================================================================
// launcher.c — qqq IDE 原生启动器（Win32 API，零外部依赖）
//
// 非阻塞 100% 托管更新系统：
//   ① 启动 → 应用暂存更新（r.next）→ 立即启动 joker.exe → 用户先用着
//   ② 后台线程 → 检查服务器 latest.txt → 下载新 r.next → 写 .version-next
//   ③ 下次启动 → ①检测到暂存更新 → 删除旧 gh555.com/ → 解压 r.next → 100% 精确一致
// 永不阻塞用户。更新在重启时自动应用。服务端改一行版本号即全量推送。
//   ④ 包含首次运行机制：joker.exe 不存在时使用 r 解压。
//   ⑤ 网络不通 → 跳过更新，用本地版本（断网可用）。
// ============================================================================
// 编译：gcc -mwindows -O2 -s -o qqqide.exe launcher.c -lcomctl32 -lwinhttp
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <commctrl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <process.h>

// ── 编译期常量 ──
#define WW 420
#define WH 240

#define UPDATE_HOST     L"gh555.com"
#define UPDATE_PATH     L"/dl/qqqide-update/latest.txt"
#define UPDATE_R_PATH   L"/dl/qqqide-update/r"
#define UPDATE_USE_HTTPS 1

// ── 颜色（Solarized Light 色系） ──
#define COL_BG      RGB(0xfd, 0xf6, 0xe3)
#define COL_TITLE   RGB(0x07, 0x36, 0x42)
#define COL_STATUS  RGB(0x58, 0x6e, 0x75)
#define COL_DOT     RGB(0x85, 0x99, 0x00)
#define COL_ERR     RGB(0xdc, 0x32, 0x2f)
#define COL_BAR_BG  RGB(0xee, 0xe8, 0xd5)
#define COL_BAR_FG  RGB(0x26, 0x8b, 0xd2)

// ── 状态常量 ──
enum { PHASE_INIT, PHASE_LAUNCHING, PHASE_WAITING, PHASE_DONE, PHASE_ERROR };

static int  g_phase   = PHASE_INIT;
static int  g_err     = 0;
static int  g_pct     = 0;
static char g_status[128] = "";
static char g_stage[128]  = "";

static HWND    g_hwnd         = NULL;
static HANDLE  g_hProcess     = NULL;
static HANDLE  g_hUpdateThread = NULL;
static volatile LONG g_updateRunning = 0;
static WCHAR   g_exeDir[MAX_PATH] = {0};
static int     g_tickCount    = 0;

// ── 工具函数 ──
static int fileExistsW(const WCHAR *path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

static void setStatus(const char *s, int isErr) {
    strncpy(g_status, s, sizeof(g_status) - 1);
    g_err = isErr;
    if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
}

static void pumpMessages(void) {
    MSG m;
    while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
}

// ── 读取本地版本文件 gh555.com/.version ──
static int readLocalVersion(const WCHAR *exeDir, char *verBuf, int bufSize) {
    WCHAR vPath[MAX_PATH];
    swprintf(vPath, MAX_PATH, L"%s\\gh555.com\\.version", exeDir);
    HANDLE h = CreateFileW(vPath, GENERIC_READ, FILE_SHARE_READ,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 0;
    DWORD rd = 0;
    ReadFile(h, verBuf, bufSize - 1, &rd, NULL);
    CloseHandle(h);
    if (rd == 0) return 0;
    verBuf[rd] = '\0';
    // trim newlines
    char *nl = strchr(verBuf, '\n'); if (nl) *nl = '\0';
    nl = strchr(verBuf, '\r'); if (nl) *nl = '\0';
    // strip whitespace
    while (rd > 0 && (verBuf[rd-1] == ' ' || verBuf[rd-1] == '\t')) verBuf[--rd] = '\0';
    return (int)strlen(verBuf);
}

// ── 写入本地版本文件 ──
static void writeLocalVersion(const WCHAR *exeDir, const char *ver) {
    WCHAR vPath[MAX_PATH];
    WCHAR ghDir[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);
    CreateDirectoryW(ghDir, NULL);
    swprintf(vPath, MAX_PATH, L"%s\\gh555.com\\.version", exeDir);
    HANDLE h = CreateFileW(vPath, GENERIC_WRITE, 0, NULL,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD wr = 0;
    WriteFile(h, ver, (DWORD)strlen(ver), &wr, NULL);
    CloseHandle(h);
}

// ── WinHTTP 下载字符串到内存 ──
static int downloadToString(const WCHAR *host, const WCHAR *path,
                             char *buf, int bufSize, int useHttps) {
    HINTERNET hSession = WinHttpOpen(L"qqqide-launcher/1.0",
        useHttps ? WINHTTP_ACCESS_TYPE_DEFAULT_PROXY : WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return -1;

    HINTERNET hConnect = WinHttpConnect(hSession, host,
        useHttps ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return -1; }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", path, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        useHttps ? WINHTTP_FLAG_SECURE : 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    // 30s timeout
    DWORD timeout = 30000;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_CONNECT_TIMEOUT, &timeout, sizeof(timeout));
    WinHttpSetOption(hRequest, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));

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

// ── WinHTTP 下载文件到磁盘（带进度回调） ──
static int downloadFile(const WCHAR *host, const WCHAR *path,
                         const WCHAR *dest, int useHttps) {
    HINTERNET hSession = WinHttpOpen(L"qqqide-launcher/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return -1;

    HINTERNET hConnect = WinHttpConnect(hSession, host,
        useHttps ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return -1; }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", path, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
        useHttps ? WINHTTP_FLAG_SECURE : 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return -1; }

    DWORD timeout = 60000;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_CONNECT_TIMEOUT, &timeout, sizeof(timeout));
    WinHttpSetOption(hRequest, WINHTTP_OPTION_RECEIVE_TIMEOUT, &timeout, sizeof(timeout));

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

    // 获取文件大小用于进度
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

        // 更新进度
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

    if (contentLen > 0 && totalDownloaded < contentLen * 0.99) {
        return -1; // incomplete
    }
    return totalDownloaded > 0 ? 0 : -1;
}

// ── 检查服务器更新 ──
// 返回: 1=需要更新, 0=已最新, -1=检查失败(跳过更新)
static int checkForUpdate(const WCHAR *exeDir, char *serverVer, int svSize) {
    char serverBuf[64] = {0};
    int len = downloadToString(UPDATE_HOST, UPDATE_PATH, serverBuf, sizeof(serverBuf), UPDATE_USE_HTTPS);
    if (len <= 0) {
        // 尝试 HTTP 兜底
        len = downloadToString(UPDATE_HOST, UPDATE_PATH, serverBuf, sizeof(serverBuf), 0);
    }
    if (len <= 0) return -1; // 网络不通，跳过更新

    // trim
    char *nl = strchr(serverBuf, '\n'); if (nl) *nl = '\0';
    nl = strchr(serverBuf, '\r'); if (nl) *nl = '\0';
    while (len > 0 && (serverBuf[len-1] == ' ' || serverBuf[len-1] == '\t')) serverBuf[--len] = '\0';

    if (len == 0) return -1;
    strncpy(serverVer, serverBuf, svSize - 1);

    char localVer[64] = {0};
    int localLen = readLocalVersion(exeDir, localVer, sizeof(localVer));

    if (localLen == 0) return 1;  // 无本地版本 → 需要更新
    if (strcmp(localVer, serverVer) != 0) return 1; // 版本不同 → 需要更新

    return 0; // 已最新
}

// ── 7z 进度解析 ──
static int parse7zPct(const char *line) {
    const char *p = strchr(line, '%');
    if (!p) return -1;
    while (p > line && p[-1] >= '0' && p[-1] <= '9') p--;
    return atoi(p);
}

// ── 删除旧 gh555.com/ 目录（更新时先清再解压，保证100%精确） ──
static int removeDir(const WCHAR *dir) {
    // 递归删除目录
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
            // retry loop for locked files
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

// ── 解压 r（7zCon.sfx + payload.7z） ──
static int extractPayload(void) {
    WCHAR exeDir[MAX_PATH];
    GetModuleFileNameW(NULL, exeDir, MAX_PATH);
    WCHAR *slash = wcsrchr(exeDir, L'\\');
    if (slash) *slash = L'\0';

    WCHAR rPath[MAX_PATH];
    swprintf(rPath, MAX_PATH, L"%s\\r", exeDir);

    if (!fileExistsW(rPath)) {
        setStatus("missing r (no payload)", 1);
        return -1;
    }

    WCHAR cmdLine[1024];
    swprintf(cmdLine, 1024, L"\"%s\" -y", rPath);

    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;

    PROCESS_INFORMATION pi = {0};
    BOOL ok = CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
                             CREATE_NO_WINDOW, NULL, exeDir, &si, &pi);
    if (!ok) {
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

    if (ec != 0) {
        setStatus("extract error", 1);
        return -1;
    }

    // verify
    WCHAR check[MAX_PATH];
    swprintf(check, MAX_PATH, L"%s\\gh555.com\\joker.exe", exeDir);
    if (!fileExistsW(check)) {
        setStatus("extract incomplete", 1);
        return -1;
    }

    // delete r
    for (int retry = 0; retry < 5; retry++) {
        Sleep(400);
        if (DeleteFileW(rPath)) break;
    }
    if (fileExistsW(rPath)) {
        Sleep(2000);
        for (int retry = 0; retry < 5; retry++) {
            if (DeleteFileW(rPath)) break;
            Sleep(500);
        }
    }
    if (fileExistsW(rPath)) {
        MoveFileExW(rPath, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    }

    return 0;
}

// ── 从服务器下载更新并解压 ──
static int downloadAndExtractUpdate(const WCHAR *exeDir, const char *newVer) {
    setStatus("downloading update…", 0);
    g_pct = 0;
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }

    WCHAR rPath[MAX_PATH];
    swprintf(rPath, MAX_PATH, L"%s\\r", exeDir);

    // 删除旧 r（可能上次残留）
    DeleteFileW(rPath);

    int result = downloadFile(UPDATE_HOST, UPDATE_R_PATH, rPath, UPDATE_USE_HTTPS);
    if (result != 0) {
        // HTTP 兜底
        DeleteFileW(rPath);
        setStatus("retry HTTP…", 0);
        if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
        result = downloadFile(UPDATE_HOST, UPDATE_R_PATH, rPath, 0);
    }
    if (result != 0) {
        setStatus("download failed", 1);
        DeleteFileW(rPath);
        return -1;
    }

    // ★ 更新时先删除旧的 gh555.com/，保证 100% 精确一致（无残留文件）
    setStatus("cleaning old version…", 0);
    g_pct = 95;
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    WCHAR ghDir[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);
    removeDir(ghDir);

    // 解压
    if (extractPayload() != 0) {
        return -1;
    }

    // 写入版本号
    writeLocalVersion(exeDir, newVer);

    g_pct = 100;
    setStatus("update complete", 0);
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    Sleep(300);

    return 0;
}

// ── 应用暂存更新（r.next + .version-next）— 上次后台下载的 ──
static int applyStagedUpdate(const WCHAR *exeDir) {
    WCHAR rNext[MAX_PATH], vNext[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", exeDir);
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", exeDir);

    if (!fileExistsW(rNext) || !fileExistsW(vNext)) return 0; // 无暂存

    char newVer[64] = {0};
    HANDLE h = CreateFileW(vNext, GENERIC_READ, FILE_SHARE_READ,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) { DeleteFileW(rNext); return 0; }
    DWORD rd = 0;
    ReadFile(h, newVer, sizeof(newVer) - 1, &rd, NULL);
    CloseHandle(h);
    newVer[rd] = '\0';
    char *nl = strchr(newVer, '\n'); if (nl) *nl = '\0';
    nl = strchr(newVer, '\r'); if (nl) *nl = '\0';

    setStatus("applying update…", 0);
    g_pct = 5;
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }

    // 删除旧的 gh555.com/
    WCHAR ghDir[MAX_PATH];
    swprintf(ghDir, MAX_PATH, L"%s\\gh555.com", exeDir);
    removeDir(ghDir);

    // 用 r.next 解压
    WCHAR cmdLine[1024];
    swprintf(cmdLine, 1024, L"\"%s\" -y", rNext);
    STARTUPINFOW si = { sizeof(si) };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi = {0};
    BOOL ok = CreateProcessW(NULL, cmdLine, NULL, NULL, FALSE,
                             CREATE_NO_WINDOW, NULL, exeDir, &si, &pi);
    if (!ok) {
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
    if (ec != 0) { DeleteFileW(rNext); DeleteFileW(vNext); return -1; }

    // 验证
    WCHAR check[MAX_PATH];
    swprintf(check, MAX_PATH, L"%s\\gh555.com\\joker.exe", exeDir);
    if (!fileExistsW(check)) { DeleteFileW(rNext); DeleteFileW(vNext); return -1; }

    // 写入版本号
    writeLocalVersion(exeDir, newVer);

    // 清理暂存文件
    DeleteFileW(rNext);
    DeleteFileW(vNext);

    g_pct = 100;
    setStatus("update applied", 0);
    if (g_hwnd) { InvalidateRect(g_hwnd, NULL, TRUE); UpdateWindow(g_hwnd); }
    Sleep(200);
    return 0;
}

// ── 后台更新线程 — 检查服务器版本，下载 r.next，写 .version-next ──
//    永不阻塞启动。用户先用旧版，下次启动自动应用。
static unsigned __stdcall backgroundUpdateProc(void *param) {
    InterlockedExchange(&g_updateRunning, 1);

    // 检查服务器版本
    char serverVer[64] = {0};
    int len = downloadToString(UPDATE_HOST, UPDATE_PATH, serverVer, sizeof(serverVer), UPDATE_USE_HTTPS);
    if (len <= 0) {
        len = downloadToString(UPDATE_HOST, UPDATE_PATH, serverVer, sizeof(serverVer), 0);
    }
    if (len <= 0) { InterlockedExchange(&g_updateRunning, 0); return 0; }

    char *nl = strchr(serverVer, '\n'); if (nl) *nl = '\0';
    nl = strchr(serverVer, '\r'); if (nl) *nl = '\0';
    while (len > 0 && (serverVer[len-1] == ' ' || serverVer[len-1] == '\t')) serverVer[--len] = '\0';
    if (len == 0) { InterlockedExchange(&g_updateRunning, 0); return 0; }

    // 比较本地版本
    char localVer[64] = {0};
    int localLen = readLocalVersion(g_exeDir, localVer, sizeof(localVer));
    if (localLen > 0 && strcmp(localVer, serverVer) == 0) {
        InterlockedExchange(&g_updateRunning, 0); return 0; // 已最新
    }

    // 下载更新到暂存位置
    WCHAR rNext[MAX_PATH];
    swprintf(rNext, MAX_PATH, L"%s\\r.next", g_exeDir);
    DeleteFileW(rNext);

    int result = downloadFile(UPDATE_HOST, UPDATE_R_PATH, rNext, UPDATE_USE_HTTPS);
    if (result != 0) {
        DeleteFileW(rNext);
        result = downloadFile(UPDATE_HOST, UPDATE_R_PATH, rNext, 0);
    }
    if (result != 0) { DeleteFileW(rNext); InterlockedExchange(&g_updateRunning, 0); return 0; }

    // 写 .version-next
    WCHAR vNext[MAX_PATH];
    swprintf(vNext, MAX_PATH, L"%s\\.version-next", g_exeDir);
    HANDLE h = CreateFileW(vNext, GENERIC_WRITE, 0, NULL,
        CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        DWORD wr = 0;
        WriteFile(h, serverVer, (DWORD)strlen(serverVer), &wr, NULL);
        CloseHandle(h);
    }

    InterlockedExchange(&g_updateRunning, 0);
    return 0;
}

// ── 窗口函数 ──
static void centerWindow(HWND hwnd) {
    RECT rc; GetWindowRect(hwnd, &rc);
    int sw = GetSystemMetrics(SM_CXSCREEN);
    int sh = GetSystemMetrics(SM_CYSCREEN);
    int x = (sw - (rc.right - rc.left)) / 2;
    int y = (sh - (rc.bottom - rc.top)) / 2 - 40;
    SetWindowPos(hwnd, NULL, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
}

static int launchCore(void) {
    WCHAR exePath[MAX_PATH];
    WCHAR exeDir[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    wcscpy(exeDir, exePath);
    WCHAR *p = wcsrchr(exeDir, L'\\');
    if (p) *p = L'\0';

    WCHAR corePath[MAX_PATH];
    swprintf(corePath, MAX_PATH, L"%s\\gh555.com\\joker.exe", exeDir);

    if (GetFileAttributesW(corePath) == INVALID_FILE_ATTRIBUTES) {
        setStatus("找不到 gh555.com/joker.exe", 1);
        return -1;
    }

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {0};
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOW;

    BOOL ok = CreateProcessW(corePath, NULL, NULL, NULL, FALSE,
                             0, NULL, exeDir, &si, &pi);
    if (!ok) {
        char buf[64];
        snprintf(buf, sizeof(buf), "启动失败 (err=%lu)", GetLastError());
        setStatus(buf, 1);
        return -1;
    }
    CloseHandle(pi.hThread);
    g_hProcess = pi.hProcess;
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
        HFONT hTitle = CreateFontW(28, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
            PROOF_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        HFONT hOld   = (HFONT)SelectObject(hdc, hTitle);
        SetTextColor(hdc, COL_TITLE);
        RECT tr = {0, 50, WW, 100};
        DrawTextW(hdc, L"qqq IDE", -1, &tr, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(hdc, hOld);
        DeleteObject(hTitle);

        SetTextColor(hdc, g_err ? COL_ERR : COL_STATUS);
        WCHAR wStage[128];
        MultiByteToWideChar(CP_UTF8, 0, g_stage[0] ? g_stage : g_status, -1, wStage, 128);
        RECT sr2 = {20, 130, WW - 20, 160};
        DrawTextW(hdc, wStage, -1, &sr2, DT_CENTER | DT_VCENTER | DT_WORD_ELLIPSIS);

        RECT barBg = {60, 170, WW - 60, 178};
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
        RECT pr = {60, 180, WW - 60, 200};
        WCHAR wPct[16];
        MultiByteToWideChar(CP_UTF8, 0, pctText, -1, wPct, 16);
        DrawTextW(hdc, wPct, -1, &pr, DT_CENTER | DT_VCENTER);

        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_TIMER: {
        g_tickCount++;

        WCHAR candidates[2][MAX_PATH];
        {
            WCHAR myDir[MAX_PATH];
            GetModuleFileNameW(NULL, myDir, MAX_PATH);
            WCHAR *slash = wcsrchr(myDir, L'\\');
            if (slash) *slash = L'\0';
            swprintf(candidates[0], MAX_PATH, L"%s\\gh555.com\\loading-status", myDir);
            swprintf(candidates[1], MAX_PATH, L"%s\\loading-status", myDir);
        }

        int readOk2 = 0;
        for (int ci = 0; ci < 2 && !readOk2; ci++) {
            HANDLE hFile = CreateFileW(candidates[ci], GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
            if (hFile == INVALID_HANDLE_VALUE) continue;
            char buf[256] = {0};
            DWORD rd2 = 0;
            ReadFile(hFile, buf, sizeof(buf) - 1, &rd2, NULL);
            CloseHandle(hFile);
            if (rd2 == 0) continue;
            buf[rd2] = '\0';
            char *nl2 = strchr(buf, '\n'); if (nl2) *nl2 = '\0';
            nl2 = strchr(buf, '\r'); if (nl2) *nl2 = '\0';
            if (strcmp(buf, "ready") == 0) {
                g_phase = PHASE_DONE;
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
                return 0;
            }
            char *pipe2 = strchr(buf, '|');
            if (pipe2) {
                *pipe2 = '\0';
                g_pct = atoi(buf);
                strncpy(g_stage, pipe2 + 1, sizeof(g_stage) - 1);
                readOk2 = 1;
            }
        }

        switch (g_phase) {
        case PHASE_INIT:
            if (g_tickCount >= 2) {
                setStatus("正在启动主程序…", 0);
                g_stage[0] = '\0';
                g_phase = PHASE_LAUNCHING;
                launchCore();
            }
            break;
        case PHASE_LAUNCHING:
            // ★ 后台检查更新（首次 tick 触发，仅一次）— 永不阻塞启动
            if (!g_hUpdateThread) {
                g_hUpdateThread = (HANDLE)_beginthreadex(NULL, 0, backgroundUpdateProc, NULL, 0, NULL);
            }
            if (g_tickCount >= 8) {
                setStatus("正在连接服务器…", 0);
                g_phase = PHASE_WAITING;
            }
            break;
        case PHASE_WAITING:
            if (g_tickCount >= 480) {
                setStatus("加载超时", 1);
                g_phase = PHASE_ERROR;
            } else if (g_hProcess) {
                DWORD ec = 0;
                if (GetExitCodeProcess(g_hProcess, &ec) && ec != STILL_ACTIVE) {
                    setStatus("主程序已退出", 1);
                    g_phase = PHASE_ERROR;
                    break;
                }
            }
            break;
        default:
            break;
        }

        InvalidateRect(hwnd, NULL, TRUE);
        return 0;
    }

    case WM_LBUTTONDOWN:
        SendMessage(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
        return 0;

    default:
        return DefWindowProcW(hwnd, msg, w, l);
    }
}

// ── 入口 ──
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

    HWND existing = FindWindowW(CLASS, NULL);
    if (existing) {
        SetForegroundWindow(existing);
        return 0;
    }

    g_hwnd = CreateWindowExW(
        0, CLASS, L"qqq IDE",
        WS_POPUP | WS_BORDER,
        0, 0, WW, WH,
        NULL, NULL, hi, NULL
    );
    if (!g_hwnd) return 1;

    centerWindow(g_hwnd);

    // ── 确定工作目录 ──
    WCHAR myDir[MAX_PATH];
    GetModuleFileNameW(NULL, myDir, MAX_PATH);
    WCHAR *s = wcsrchr(myDir, L'\\');
    if (s) *s = L'\0';
    wcscpy(g_exeDir, myDir);  // 存全局供后台线程用

    WCHAR jokerPath[MAX_PATH];
    swprintf(jokerPath, MAX_PATH, L"%s\\gh555.com\\joker.exe", myDir);
    int jokerExists = fileExistsW(jokerPath);

    // ── 首次运行：joker.exe 不存在 → 解压本地 r ──
    if (!jokerExists) {
        ShowWindow(g_hwnd, SW_SHOW);
        UpdateWindow(g_hwnd);
        WCHAR rPath[MAX_PATH];
        swprintf(rPath, MAX_PATH, L"%s\\r", myDir);
        if (!fileExistsW(rPath)) {
            // 本地无 r → 从服务器下载（5% 缺口兜底：用户误删 gh555.com/ 后自动恢复）
            setStatus("正在下载组件…", 0);
            InvalidateRect(g_hwnd, NULL, TRUE);
            UpdateWindow(g_hwnd);
            pumpMessages();
            int dlRc = downloadFile(UPDATE_HOST, UPDATE_R_PATH, rPath, UPDATE_USE_HTTPS);
            if (dlRc != 0 || !fileExistsW(rPath)) {
                setStatus("下载失败，请检查网络", 1);
            } else {
                if (extractPayload() != 0) {
                    // extractPayload 已设 status
                } else {
                    g_pct = 100;
                    setStatus("解压完成", 0);
                    InvalidateRect(g_hwnd, NULL, TRUE);
                    UpdateWindow(g_hwnd);
                    Sleep(300);
                }
            }
        } else {
            if (extractPayload() != 0) {
                // extractPayload 已设 status
            } else {
                g_pct = 100;
                setStatus("解压完成", 0);
                InvalidateRect(g_hwnd, NULL, TRUE);
                UpdateWindow(g_hwnd);
                Sleep(300);
            }
        }
    } else {
        // ── 已安装 → ①应用暂存更新（上次后台下载的）→ ②清理残留 ──
        ShowWindow(g_hwnd, SW_SHOW);
        UpdateWindow(g_hwnd);

        // ① 应用暂存更新（r.next + .version-next）— 上次启动时后台下载的
        WCHAR rNextPath[MAX_PATH];
        swprintf(rNextPath, MAX_PATH, L"%s\\r.next", myDir);
        if (fileExistsW(rNextPath)) {
            applyStagedUpdate(myDir);
            g_pct = 0;
        }

        // ② 清理残留 r（上次解压可能没删掉）
        WCHAR rPath[MAX_PATH];
        swprintf(rPath, MAX_PATH, L"%s\\r", myDir);
        for (int retry = 0; retry < 6; retry++) {
            if (!fileExistsW(rPath)) break;
            if (DeleteFileW(rPath)) break;
            Sleep(300);
        }
        if (fileExistsW(rPath)) MoveFileExW(rPath, NULL, MOVEFILE_DELAY_UNTIL_REBOOT);
    }

    // ── 清除上次残留的 loading-status 文件 ──
    {
        WCHAR cleanPath[MAX_PATH];
        swprintf(cleanPath, MAX_PATH, L"%s\\gh555.com\\loading-status", myDir);
        DeleteFileW(cleanPath);
        swprintf(cleanPath, MAX_PATH, L"%s\\loading-status", myDir);
        DeleteFileW(cleanPath);
    }

    // 初始状态
    setStatus("正在启动…", 0);
    g_pct = 0;

    // 定时器（250ms 间隔）
    SetTimer(g_hwnd, 1, 250, NULL);

    // 显示窗口
    ShowWindow(g_hwnd, SW_SHOW);
    UpdateWindow(g_hwnd);

    // 消息循环
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    // exit cleanup — 等后台更新线程跑完（最多 120s）
    if (g_hUpdateThread) {
        DWORD waitResult = WaitForSingleObject(g_hUpdateThread, 120000);
        if (waitResult == WAIT_TIMEOUT) {
            TerminateThread(g_hUpdateThread, 0);
        }
        CloseHandle(g_hUpdateThread);
    }
    {
        WCHAR rPath[MAX_PATH];
        swprintf(rPath, MAX_PATH, L"%s\\r", g_exeDir);
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
