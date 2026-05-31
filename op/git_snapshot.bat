@echo off
set GIT=E:\s\d\git\bin\git.exe
cd /d "E:\s\wol\py\qqq-shell-v2"

%GIT% add -A 2>&1
%GIT% commit --no-verify -m "%*" 2>&1
if %ERRORLEVEL% equ 0 (
    echo [git-snapshot] OK
) else (
    echo [git-snapshot] nothing to commit or no changes
)
