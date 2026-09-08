// Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.
//
// qmd-conpty.c — ConPTY bridge for goods qmd (Win10 1809+)
// 行协议（全部 UTF-8 文本行，前缀 ASCII）:
//   父 → 本 (stdin):  W <base64>           写字节到 ConPTY 键入
//                     R <cols> <rows>      resize
//   本 → 父 (stdout): R <pid>              ready（spawn 成功）
//                     D <base64>           ConPTY 输出字节
//                     E <code>             shell 退出
//                     X <msg>              spawn 失败（随后退出）
// 配置经环境变量 QMD_CMDLINE（完整命令行）/ QMD_CWD / QMD_COLS / QMD_ROWS 传入
// （环境变量传递避免 argv 引号地狱；UTF-16 由 Node spawn 原生保证）。
//
// ★★ ConPTY 全链路机制（2026-09-07/08 排雷定案，node-pty conpty.cc 同款时序）:
//   系统 CreatePseudoConsole（kernel32）+ 匿名/命名管道在本机全部失败（attribute
//   无效/conhost 不连接）→ 必须用 conpty.dll（微软官方，node-pty 同款）的
//   ConptyCreatePseudoConsole + 命名管道 client/server 配对:
//     1. CreateNamedPipeW（server 端 S_in/S_out，128KB，bInheritHandle=FALSE）
//     2. ConptyCreatePseudoConsole(size, S_in, S_out, 0, &hPC)
//        → dll 内部 spawn conhost --headless 并复制 S_in/S_out 给它
//        → conhost 对副本调 ConnectNamedPipe（阻塞等 client）
//     3. 宿主 CreateFileW(管道名) → client 句柄 C_in/C_out（触发 conhost 配对完成）
//     4. ConnectNamedPipe(S) 幂等保险（已连则失败无害，node-pty 不查返回值）
//     5. CreateProcessW(shell, attribute=PSEUDOCONSOLE hPC, bInheritHandles=FALSE)
//     6. ConptyReleasePseudoConsole(hPC)（dll 扩展 API，node-pty 创建进程后即调）
//     7. CloseHandle(S_in/S_out)（server 端使命结束，conhost 副本仍持有）
//   此后 IO 全走 client 端: 写键入 → C_in；读输出 ← C_out
//   失败实锤: 匿名管道版输出通键入不通（缺握手）；命名管道无 client 版
//   WriteFile 536 ERROR_PIPE_LISTENING（conhost 配对永不完成）。
// 编译: gcc -O2 -s -o qmd-conpty.exe qmd-conpty.c   （与 conpty.dll 同目录部署）
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600 /* STARTUPINFOEXW/ProcThreadAttribute 需要 */
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* MinGW w32api 旧版缺 ConPTY 声明 → 手动补齐 */
#ifndef PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
#define PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 0x00020016
#endif
#ifndef _HPCON_DEFINED
typedef struct _HPCON__ *HPCON;
#endif

/* conpty.dll 扩展 API（微软官方，node-pty 同款；kernel32 系统 API 已实测失败） */
typedef HRESULT(WINAPI *FN_CONPTY_CREATE)(COORD, HANDLE, HANDLE, DWORD, HPCON *);
typedef HRESULT(WINAPI *FN_CONPTY_RESIZE)(HPCON, COORD);
typedef VOID(WINAPI *FN_CONPTY_CLOSE)(HPCON);
typedef HRESULT(WINAPI *FN_CONPTY_RELEASE)(HPCON);

static HANDLE g_hPC = NULL, g_hInClient = NULL, g_hOutClient = NULL;
static FN_CONPTY_RESIZE g_pfnResize = NULL;
static CRITICAL_SECTION g_outLock;

static void emit_line(const char *prefix, const char *body) {
    EnterCriticalSection(&g_outLock);
    fputs(prefix, stdout);
    if (body) fputs(body, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    LeaveCriticalSection(&g_outLock);
}

static const char B64T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static int b64val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}
/* 解码 in -> out，返回字节数（out 需足够大） */
static size_t b64_decode(unsigned char *out, const char *in) {
    size_t o = 0;
    int buf = 0, bits = 0;
    for (; *in; in++) {
        if (*in == '=' || *in == '\r' || *in == '\n') continue;
        int v = b64val(*in);
        if (v < 0) continue;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (unsigned char)((buf >> bits) & 0xFF);
        }
    }
    return o;
}
static size_t b64_encode(char *out, const unsigned char *in, size_t n) {
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = in[i] << 16;
        if (i + 1 < n) v |= in[i + 1] << 8;
        if (i + 2 < n) v |= in[i + 2];
        out[o++] = B64T[(v >> 18) & 63];
        out[o++] = B64T[(v >> 12) & 63];
        out[o++] = (i + 1 < n) ? B64T[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < n) ? B64T[v & 63] : '=';
    }
    out[o] = 0;
    return o;
}

/* 读线程：ConPTY 输出 → D 行 */
static DWORD WINAPI reader_thread(LPVOID p) {
    (void)p;
    char b64buf[65536];
    unsigned char raw[16384];
    while (1) {
        DWORD n = 0;
        if (!ReadFile(g_hOutClient, raw, sizeof(raw), &n, NULL)) return 0; /* 109/995 = 收尾 */
        if (n > 0) {
            size_t len = b64_encode(b64buf, raw, n);
            (void)len;
            emit_line("D ", b64buf);
        }
    }
    return 0;
}

/* waiter 线程：shell 退出 → E 行 → 进程收尾 */
static DWORD WINAPI waiter_thread(LPVOID p) {
    HANDLE hProc = (HANDLE)p;
    WaitForSingleObject(hProc, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(hProc, &code);
    char buf[24];
    _itoa_s((int)code, buf, sizeof(buf), 10);
    emit_line("E ", buf);
    Sleep(300); /* 让 reader 线程把剩余输出写完再退（防行撕裂） */
    ExitProcess(0);
    return 0;
}

/* 主循环：处理 stdin 指令行 */
static void main_loop(void) {
    char line[131072];
    while (fgets(line, sizeof(line), stdin)) {
        size_t l = strlen(line);
        while (l && (line[l - 1] == '\n' || line[l - 1] == '\r')) line[--l] = 0;
        if (l < 2) continue;
        char op = line[0];
        const char *rest = line + 2;
        if (op == 'W') {
            static unsigned char dec[131072];
            size_t n = b64_decode(dec, rest);
            if (n > 0 && g_hInClient) {
                DWORD written = 0, off = 0;
                while (off < n) {
                    if (!WriteFile(g_hInClient, dec + off, (DWORD)(n - off), &written, NULL)) break;
                    if (written == 0) break;
                    off += written;
                }
            }
        } else if (op == 'R') {
            int cols = 120, rows = 30;
            if (sscanf_s(rest, "%d %d", &cols, &rows) == 2) {
                COORD sz;
                sz.X = (SHORT)cols;
                sz.Y = (SHORT)rows;
                if (g_hPC && g_pfnResize) g_pfnResize(g_hPC, sz);
            }
        }
    }
}

int wmain(void) {
    InitializeCriticalSection(&g_outLock);

    const wchar_t *cmdline_env = _wgetenv(L"QMD_CMDLINE");
    const wchar_t *cwd_env = _wgetenv(L"QMD_CWD");
    const wchar_t *cols_env = _wgetenv(L"QMD_COLS");
    const wchar_t *rows_env = _wgetenv(L"QMD_ROWS");
    if (!cmdline_env || !cmdline_env[0]) {
        fprintf(stderr, "[qmd-conpty] QMD_CMDLINE missing\n");
        return 1;
    }
    int cols = cols_env ? _wtoi(cols_env) : 120;
    int rows = rows_env ? _wtoi(rows_env) : 30;
    if (cols < 20) cols = 80;
    if (rows < 5) rows = 24;

    /* ① 加载 conpty.dll（exe 同目录；QMD_CONPTY_DLL 可覆盖绝对路径） */
    const wchar_t *dll_override = _wgetenv(L"QMD_CONPTY_DLL");
    HMODULE hDll = dll_override && dll_override[0]
                       ? LoadLibraryW(dll_override)
                       : LoadLibraryW(L"conpty.dll");
    if (!hDll) {
        fprintf(stderr, "[qmd-conpty] conpty.dll load fail %lu\n", GetLastError());
        return 1;
    }
    FN_CONPTY_CREATE pfnCreate = (FN_CONPTY_CREATE)GetProcAddress(hDll, "ConptyCreatePseudoConsole");
    g_pfnResize = (FN_CONPTY_RESIZE)GetProcAddress(hDll, "ConptyResizePseudoConsole");
    FN_CONPTY_CLOSE pfnClose = (FN_CONPTY_CLOSE)GetProcAddress(hDll, "ConptyClosePseudoConsole");
    FN_CONPTY_RELEASE pfnRelease = (FN_CONPTY_RELEASE)GetProcAddress(hDll, "ConptyReleasePseudoConsole");
    if (!pfnCreate || !pfnClose) {
        fprintf(stderr, "[qmd-conpty] conpty.dll exports missing\n");
        return 1;
    }

    /* ② 命名管道 server 端（node-pty 同款参数: 双工 FIRST_PIPE_INSTANCE BYTE WAIT
       128KB×2，sa.bInheritHandle=FALSE——conpty.dll 内部 DuplicateHandle 复制） */
    wchar_t inName[96], outName[96];
    inName[0] = L'\\'; inName[1] = L'\\'; inName[2] = L'.'; inName[3] = L'\\';
    swprintf(inName + 4, 92, L"pipe\\qmd-%lu-in", (unsigned long)GetCurrentProcessId());
    outName[0] = L'\\'; outName[1] = L'\\'; outName[2] = L'.'; outName[3] = L'\\';
    swprintf(outName + 4, 92, L"pipe\\qmd-%lu-out", (unsigned long)GetCurrentProcessId());
    SECURITY_ATTRIBUTES saPipe;
    saPipe.nLength = sizeof(saPipe);
    saPipe.lpSecurityDescriptor = NULL;
    saPipe.bInheritHandle = FALSE;
    const DWORD OPEN_MODE = PIPE_ACCESS_INBOUND | PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED; /* OVERLAPPED: Connect 先行挂起不阻塞 */
    const DWORD PIPE_MODE = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT;
    HANDLE hIn = CreateNamedPipeW(inName, OPEN_MODE, PIPE_MODE, 1, 131072, 131072, 30000, &saPipe);
    HANDLE hOut = CreateNamedPipeW(outName, OPEN_MODE, PIPE_MODE, 1, 131072, 131072, 30000, &saPipe);
    if (hIn == INVALID_HANDLE_VALUE || hOut == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "[qmd-conpty] CreateNamedPipe fail %lu\n", GetLastError());
        return 1;
    }

    /* ③ ConptyCreatePseudoConsole: dll 内部 spawn conhost --headless 并复制
       S_in/S_out 给它，conhost 对副本 ConnectNamedPipe 阻塞等 client */
    COORD size;
    size.X = (SHORT)cols;
    size.Y = (SHORT)rows;
    HPCON hPC = NULL;
    HRESULT hr = pfnCreate(size, hIn, hOut, 0, &hPC);
    if (FAILED(hr)) {
        fprintf(stderr, "[qmd-conpty] ConptyCreatePseudoConsole fail 0x%08lX\n", (unsigned long)hr);
        return 1;
    }
    g_hPC = hPC;

    /* ④ 双端配对（2026-09-08 死锁实锤修复）: 同步 client CreateFileW 在 server
       未 ConnectNamedPipe 挂起时会永久阻塞（v2 首版卡死根因）；同步 server
       ConnectNamedPipe 在 client 未到时也永久阻塞（probe1 卡死根因）。
       破局 = OVERLAPPED Connect 先行挂起 → client CreateFileW 立即完成配对。
       conhost 持有的 server 副本在管道 connected 后同样可 IO（node-pty 实证
       native Connect + socket CreateFile 配对后 conhost 正常工作，conhost 自身
       不依赖 Connect 成功）。 */
    OVERLAPPED ovIn, ovOut;
    ZeroMemory(&ovIn, sizeof(ovIn));
    ZeroMemory(&ovOut, sizeof(ovOut));
    ovIn.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    ovOut.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    BOOL ci1 = ConnectNamedPipe(hIn, &ovIn);
    DWORD ce1 = GetLastError();
    BOOL ci2 = ConnectNamedPipe(hOut, &ovOut);
    DWORD ce2 = GetLastError();
    /* 已连（client 已到）或 I/O pending（挂起等 client）都正常 */
    if (!ci1 && ce1 != ERROR_IO_PENDING && ce1 != ERROR_PIPE_CONNECTED) {
        fprintf(stderr, "[qmd-conpty] ConnectNamedPipe in fail %lu\n", ce1);
        return 1;
    }
    if (!ci2 && ce2 != ERROR_IO_PENDING && ce2 != ERROR_PIPE_CONNECTED) {
        fprintf(stderr, "[qmd-conpty] ConnectNamedPipe out fail %lu\n", ce2);
        return 1;
    }

    HANDLE hInClient = CreateFileW(inName, GENERIC_READ | GENERIC_WRITE,
                                   FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                   OPEN_EXISTING, 0, NULL);
    HANDLE hOutClient = CreateFileW(outName, GENERIC_READ | GENERIC_WRITE,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                    OPEN_EXISTING, 0, NULL);
    if (hInClient == INVALID_HANDLE_VALUE || hOutClient == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "[qmd-conpty] CreateFile pipe fail %lu\n", GetLastError());
        return 1;
    }
    g_hInClient = hInClient;
    g_hOutClient = hOutClient;

    /* ⑤ 等配对完成（client 已到则立即返回） */
    if (!ci1) WaitForSingleObject(ovIn.hEvent, 5000);
    if (!ci2) WaitForSingleObject(ovOut.hEvent, 5000);
    CloseHandle(ovIn.hEvent);
    CloseHandle(ovOut.hEvent);

    /* ⑥ attribute list (HeapAlloc = 8 对齐) + lpValue = hPC 值（微软 sample/node-pty 同款） */
    SIZE_T sz = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &sz);
    PPROC_THREAD_ATTRIBUTE_LIST list = (PPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, sz);
    if (!list) { fprintf(stderr, "[qmd-conpty] HeapAlloc fail\n"); return 1; }
    if (!InitializeProcThreadAttributeList(list, 1, 0, &sz)) {
        fprintf(stderr, "[qmd-conpty] InitAttrList fail %lu\n", GetLastError());
        return 1;
    }
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hPC, sizeof(HPCON), NULL, NULL)) {
        fprintf(stderr, "[qmd-conpty] UpdateAttr fail %lu\n", GetLastError());
        return 1;
    }

    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(STARTUPINFOEXW);
    /* ★ 必须显式置空 std（node-pty 同款）: 不设 STARTF_USESTDHANDLES 时 cmd
       继承父进程 stdout（=行协议管道）→ 检测到重定向 → echo 输出明文直写管道
       完全绕开 ConPTY（2026-09-08 裸跑实锤: HI_XYZ 明文先到、VT init 后到
       分叉双流）。置 nullptr 后 cmd 写 stdout 无效句柄 → 回退 console → 走
       ConPTY attribute → 输出全进 VT 流。 */
    si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
    si.StartupInfo.hStdError = NULL;
    si.StartupInfo.hStdInput = NULL;
    si.StartupInfo.hStdOutput = NULL;
    si.lpAttributeList = list;

    wchar_t *cmdline = _wcsdup(cmdline_env);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    /* bInheritHandles=FALSE 至关重要（node-pty 注释: VERY IMPORTANT） */
    BOOL ok = CreateProcessW(NULL, cmdline, NULL, NULL, FALSE,
                             EXTENDED_STARTUPINFO_PRESENT, NULL,
                             (cwd_env && cwd_env[0]) ? cwd_env : NULL,
                             &si.StartupInfo, &pi);
    if (!ok) {
        fprintf(stderr, "[qmd-conpty] CreateProcessW fail %lu\n", GetLastError());
        return 1;
    }
    free(cmdline);
    HeapFree(GetProcessHeap(), 0, list);

    /* ⑦ 进程已挂上 ConPTY → release + 关闭 server 端（conhost 副本仍持有，
       client 端 IO 不受影响） */
    if (pfnRelease) pfnRelease(hPC);
    CloseHandle(hIn);
    CloseHandle(hOut);

    char pidbuf[24];
    _itoa_s((int)pi.dwProcessId, pidbuf, sizeof(pidbuf), 10);
    emit_line("R ", pidbuf);

    CreateThread(NULL, 0, reader_thread, NULL, 0, NULL);
    CreateThread(NULL, 0, waiter_thread, (LPVOID)pi.hProcess, 0, NULL);

    main_loop();

    /* stdin EOF：收尾 */
    if (g_hInClient) CloseHandle(g_hInClient);
    if (g_hOutClient) CloseHandle(g_hOutClient);
    if (g_hPC && pfnClose) pfnClose(g_hPC);
    return 0;
}
