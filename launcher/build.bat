@echo off
REM build.bat — compile qqqide.exe with embedded icon
REM Uses MinGW-w64 from E:\s\d\gw\mingw64\bin\
REM Output: qqqide.exe (64-bit, ~123KB, with shell/icon.ico embedded)

set GW=E:\s\d\gw\mingw64\bin

echo [1/2] windres resource.rc -^> resource.o
"%GW%\windres.exe" resource.rc -O coff -o resource.o
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo [2/2] gcc -^> qqqide.exe
"%GW%\gcc.exe" -mwindows -O2 -s -o qqqide.exe launcher.c resource.o -lcomctl32 -lwinhttp
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

echo.
echo === DONE: qqqide.exe with embedded icon ===
