@echo off
setlocal
for /f "delims=" %%I in ('powershell.exe -NoProfile -Command "[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)"') do set "YAOC_BUILD_ROOT=%%I\Builds\yaoc"
if not defined YAOC_BUILD_ROOT exit /b 1
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    if exist "%YAOC_BUILD_ROOT%\release\yaoc-arm64.exe" (
        start "" "%YAOC_BUILD_ROOT%\release\yaoc-arm64.exe"
        exit /b 0
    )
)
if exist "%YAOC_BUILD_ROOT%\release\yaoc-x64.exe" (
    start "" "%YAOC_BUILD_ROOT%\release\yaoc-x64.exe"
    exit /b 0
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-local.ps1" -BuildRoot "%YAOC_BUILD_ROOT%"
if errorlevel 1 exit /b %errorlevel%
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    start "" "%YAOC_BUILD_ROOT%\release\yaoc-arm64.exe"
) else (
    start "" "%YAOC_BUILD_ROOT%\release\yaoc-x64.exe"
)
