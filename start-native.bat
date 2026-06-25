@echo off
REM Kimi Code launcher with native Rust tools built.
REM Usage: double-click or run from cmd/powershell.

setlocal

REM Ensure native module is built.
if not exist "%~dp0packages\kimi-native-tools\kimi_native_tools.win32-x64.node" (
    echo Building native tools...
    cd /d "%~dp0\packages\kimi-native-tools"
    cargo build --release 2>nul
    if errorlevel 1 (
        echo [ERROR] cargo build failed. Make sure Rust is installed.
        echo         https://rustup.rs
        pause
        exit /b 1
    )
    copy /y "target\release\kimi_native_tools.dll" "kimi_native_tools.win32-x64.node" >nul
    cd /d "%~dp0"
)

REM Launch kimi-code CLI via pnpm.
cd /d "%~dp0"
pnpm dev:cli %*

endlocal
