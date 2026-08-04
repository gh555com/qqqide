// slave.c — legacy compat stub (2026-08-04)
// ============================================================================
// 历史: 早期 C 启动器硬编码启动 gh555.com/slave.exe（当时 Electron 二进制名）。
//       Electron 二进制改名 joker.exe 后，旧绿色包里的旧 qqqide.exe 仍只找 slave.exe，
//       收到新载荷（无 slave.exe）即报「找不到 gh555.com/slave.exe」并卡死恢复流程。
// 本 stub 职责: 旧启动器 → CreateProcess(slave.exe) → 本 stub → CreateProcess(joker.exe)
//               → 等待退出 → 透传退出码。让所有旧绿色包在新载荷下自动恢复。
// 新启动器(joker.exe 直启)完全忽略本文件，仅作兼容存在。
// 编译: build.bat（与 qqqide.exe 同批产出）
// ============================================================================

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE hPrev, LPWSTR lpCmdLine, int nShow) {
    (void)hInstance; (void)hPrev; (void)lpCmdLine; (void)nShow;

    // 自身目录 = gh555.com/
    WCHAR dir[MAX_PATH];
    GetModuleFileNameW(NULL, dir, MAX_PATH);
    WCHAR *p = wcsrchr(dir, L'\\');
    if (!p) return 1;
    *p = L'\0';

    WCHAR joker[MAX_PATH];
    swprintf(joker, MAX_PATH, L"%s\\joker.exe", dir);
    if (GetFileAttributesW(joker) == INVALID_FILE_ATTRIBUTES) return 1;

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = { 0 };
    si.dwFlags = STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_SHOW;
    if (!CreateProcessW(joker, NULL, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) return 1;
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD ec = 0;
    GetExitCodeProcess(pi.hProcess, &ec);
    CloseHandle(pi.hProcess);
    return (int)ec;
}
