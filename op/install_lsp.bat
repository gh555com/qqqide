@echo off
chcp 65001 >nul
set PYTHON=E:\s\d\python3810\python.exe
set SCRIPT=E:\s\wol\py\qqq-shell-v2\op\components.py

echo ================================================================
echo   LSP 组件一键安装
echo ================================================================
echo.

:menu
echo [1] 安装 clangd (C/C++) ~42MB
echo [2] 安装 rust-analyzer (Rust) ~18MB
echo [3] 安装 gopls (Go) — 需 go 工具链
echo [4] 安装 pyright (Python) — 需 npm
echo [5] 全部安装 (clangd + rust-analyzer)
echo [A] 全部 (含 gopls + pyright 尝试)
echo [0] 退出
echo.
set /p CHOICE="选: "

if "%CHOICE%"=="1" %PYTHON% -u %SCRIPT% ensure lsp/clangd & goto menu
if "%CHOICE%"=="2" %PYTHON% -u %SCRIPT% ensure lsp/rust-analyzer & goto menu
if "%CHOICE%"=="3" %PYTHON% -u %SCRIPT% ensure lsp/gopls & goto menu
if "%CHOICE%"=="4" %PYTHON% -u %SCRIPT% ensure lsp/pyright & goto menu
if "%CHOICE%"=="5" %PYTHON% -u %SCRIPT% ensure lsp/clangd lsp/rust-analyzer & goto menu
if /i "%CHOICE%"=="A" %PYTHON% -u %SCRIPT% ensure --all & goto menu
if "%CHOICE%"=="0" exit /b 0
goto menu
