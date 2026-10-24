@echo off
cd /d "%~dp0"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    if exist "release\yaoc-arm64.exe" (
        start "" "release\yaoc-arm64.exe"
        exit /b 0
    )
)
if exist "release\yaoc-x64.exe" (
    start "" "release\yaoc-x64.exe"
    exit /b 0
)
set "PATH=%USERPROFILE%\.cargo\bin;%LOCALAPPDATA%\Programs\llvm-mingw\bin;%LOCALAPPDATA%\Programs\nodejs;%PATH%"
call npm.cmd run build:tauri
if errorlevel 1 exit /b %errorlevel%
start "" "src-tauri\target\release\yaoc.exe"
