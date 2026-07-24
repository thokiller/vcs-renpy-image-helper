@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed or not on PATH.
    echo Install Node.js LTS first, then run this file again.
    pause
    exit /b 1
)

where npx.cmd >nul 2>nul
if errorlevel 1 (
    echo npx.cmd was not found on PATH.
    echo Make sure Node.js was installed correctly, then run this file again.
    pause
    exit /b 1
)

echo Building VSIX package...
call npx.cmd @vscode/vsce package --allow-missing-repository
if errorlevel 1 (
    echo.
    echo Build failed.
    pause
    exit /b 1
)

echo.
echo Build complete.
dir /b *.vsix
pause
exit /b 0