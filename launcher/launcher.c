// ============================================================================
// launcher.c — qqq IDE 原生启动器（Win32 API，零外部依赖）
//
// 作用：瞬间弹出加载窗口，后台启动 Electron 主程序 qqqide-core.exe。
// 用户双击后不用傻等 5 分钟黑屏，立刻看到"正在启动…"提示。
// ============================================================================
// 编译：gcc -mwindows -O2 -s -o qqqide.exe launcher.c -lcomctl32
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <string.h>

// ── 窗口尺寸 ──
#define WW 420
#define WH 240

// ── 颜色（Solarized Light 色系） ──
#define COL_BG      RGB(0xfd, 0xf6, 0xe3)
#define COL_TITLE   RGB(0x07, 0x36, 0x42)
#define COL_STATUS  RGB(0x58, 0x6e, 0x75)
#define COL_DOT     RGB(0x85, 0x99, 0x00)
#define COL_ERR     RGB(0xdc, 0x32, 0x2f)

// ── 状态常量 ──
enum { PHASE_INIT, PHASE_LAUNCHING, PHASE_WAITING, PHASE_DONE, PHASE_ERROR };

static int  g_phase   = PHASE_INIT;
static int  g_dot     = 0;       // 动画帧 0-3
static int  g_err     = 0;       // 是否错误态
static char g_status[128] = "";

static HWND    g_hwnd      = NULL;
static HANDLE  g_hProcess  = NULL;
static int     g_tickCount = 0;

// ── 工具函数 ──
static void setStatus(const char *s, int isErr) {
    strncpy(g_status, s, sizeof(g_status) - 1);
    g_err = isErr;
    if (g_hwnd) InvalidateRect(g_hwnd, NULL, TRUE);
}

static void centerWindow(HWND hwnd) {
    RECT rc; GetWindowRect(hwnd, &rc);
    int sw = GetSystemMetrics(SM_CXSCREEN);
    int sh = GetSystemMetrics(SM_CYSCREEN);
    int x = (sw - (rc.right - rc.left)) / 2;
    int y = (sh - (rc.bottom - rc.top)) / 2 - 40;
    SetWindowPos(hwnd, NULL, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER);
}

// ── 启动 Electron 主程序 ──
static int launchCore(void) {
    WCHAR exePath[MAX_PATH];
    WCHAR exeDir[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);

    // 当前目录 = 启动器所在目录
    wcscpy(exeDir, exePath);
    WCHAR *p = wcsrchr(exeDir, L'\\');
    if (p) *p = L'\0';

    // 目标：同目录下的 qqqide-core.exe
    WCHAR corePath[MAX_PATH];
    swprintf(corePath, MAX_PATH, L"%s\\qqqide-core.exe", exeDir);

    if (GetFileAttributesW(corePath) == INVALID_FILE_ATTRIBUTES) {
        setStatus("找不到 qqqide-core.exe", 1);
        return -1;
    }

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {0};
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOW;

    // 在当前目录启动，继承工作目录
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

// ── 窗口过程 ──
static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM w, LPARAM l) {
    switch (msg) {
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;

    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);

        // 背景
        HBRUSH bg = CreateSolidBrush(COL_BG);
        RECT rc; GetClientRect(hwnd, &rc);
        FillRect(hdc, &rc, bg);
        DeleteObject(bg);

        // 标题
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

        // 状态文字
        HFONT hStat = CreateFontW(16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
            PROOF_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei");
        SelectObject(hdc, hStat);
        SetTextColor(hdc, g_err ? COL_ERR : COL_STATUS);

        WCHAR wbuf[128];
        MultiByteToWideChar(CP_UTF8, 0, g_status, -1, wbuf, 128);
        RECT sr = {20, 120, WW - 20, 170};
        DrawTextW(hdc, wbuf, -1, &sr, DT_CENTER | DT_VCENTER | DT_WORD_ELLIPSIS);

        // 动画小圆点
        SelectObject(hdc, GetStockObject(DC_PEN));
        HPEN hDotPen = CreatePen(PS_SOLID, 6, COL_DOT);
        SelectObject(hdc, hDotPen);
        for (int i = 0; i < 4; i++) {
            int x = WW / 2 - 30 + i * 20;
            int y = 180;
            if (i == g_dot) {
                // 当前点高亮
                HBRUSH hDot = CreateSolidBrush(COL_DOT);
                SelectObject(hdc, hDot);
                Ellipse(hdc, x - 4, y - 4, x + 4, y + 4);
                DeleteObject(hDot);
            } else {
                HBRUSH hDot = CreateSolidBrush(COL_BG);
                SelectObject(hdc, hDot);
                Ellipse(hdc, x - 4, y - 4, x + 4, y + 4);
                DeleteObject(hDot);
            }
        }
        DeleteObject(hDotPen);
        SelectObject(hdc, hOld);
        DeleteObject(hStat);

        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_TIMER: {
        g_tickCount++;

        // 动画：圆点循环
        g_dot = (g_dot + 1) % 4;

        // 阶段转换
        switch (g_phase) {
        case PHASE_INIT:
            if (g_tickCount >= 2) { // ~0.5s
                setStatus("正在启动主程序…", 0);
                g_phase = PHASE_LAUNCHING;
                launchCore();
            }
            break;
        case PHASE_LAUNCHING:
            if (g_tickCount >= 8) { // ~2s，给 Electron 一点初始化时间
                setStatus("正在连接服务器…", 0);
                g_phase = PHASE_WAITING;
            }
            break;
        case PHASE_WAITING:
            if (g_tickCount >= 120) { // ~30s 超时
                setStatus("正在等待主窗口…", 0);
                g_phase = PHASE_DONE;
            } else if (g_hProcess) {
                // 检查进程是否还在运行
                DWORD ec = 0;
                if (GetExitCodeProcess(g_hProcess, &ec) && ec != STILL_ACTIVE) {
                    setStatus("主程序已退出", 1);
                    g_phase = PHASE_ERROR;
                    break;
                }
                // 尝试找到 Electron 主窗口
                HWND target = FindWindowW(NULL, L"qqq IDE");
                if (target) {
                    // Electron 窗口已出现，关闭 splash
                    g_phase = PHASE_DONE;
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    return 0;
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
        // 点击可拖拽窗口
        SendMessage(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
        return 0;

    default:
        return DefWindowProcW(hwnd, msg, w, l);
    }
}

// ── 入口 ──
int WINAPI WinMain(HINSTANCE hi, HINSTANCE, LPSTR, int nShow) {
    // 初始化公共控件（视觉样式）
    INITCOMMONCONTROLSEX icc = {sizeof(icc), ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&icc);

    // 注册窗口类
    const WCHAR CLASS[] = L"QqqIdeLauncher";
    WNDCLASSEXW wc = {
        .cbSize        = sizeof(wc),
        .style         = CS_HREDRAW | CS_VREDRAW,
        .lpfnWndProc   = WndProc,
        .hInstance     = hi,
        .hCursor       = LoadCursor(NULL, IDC_ARROW),
        .hbrBackground = NULL,  // 我们自己在 WM_PAINT 画
        .lpszClassName = CLASS,
    };
    if (!RegisterClassExW(&wc)) return 1;

    // 查找是否有 qqqide-core.exe 已经在运行（防止双击多个）
    HWND existing = FindWindowW(CLASS, NULL);
    if (existing) {
        SetForegroundWindow(existing);
        return 0;
    }

    // 创建窗口
    g_hwnd = CreateWindowExW(
        0, CLASS, L"qqq IDE",
        WS_POPUP | WS_BORDER,
        0, 0, WW, WH,
        NULL, NULL, hi, NULL
    );
    if (!g_hwnd) return 1;

    centerWindow(g_hwnd);

    // 初始状态
    setStatus("正在启动…", 0);

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

    // 清理
    if (g_hProcess) CloseHandle(g_hProcess);
    return 0;
}
