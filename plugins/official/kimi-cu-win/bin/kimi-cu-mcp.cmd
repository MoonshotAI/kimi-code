@echo off
setlocal
set "APP="

if defined KIMI_CU_WINDOWS_EXE (
  if exist "%KIMI_CU_WINDOWS_EXE%" set "APP=%KIMI_CU_WINDOWS_EXE%"
)

if not defined APP if defined KIMI_CU_WINDOWS_HOME (
  if exist "%KIMI_CU_WINDOWS_HOME%\kimi-cu.exe" set "APP=%KIMI_CU_WINDOWS_HOME%\kimi-cu.exe"
)

if not defined APP if exist "%LOCALAPPDATA%\KimiCU\kimi-cu.exe" (
  set "APP=%LOCALAPPDATA%\KimiCU\kimi-cu.exe"
)

if not defined APP if exist "%ProgramFiles%\KimiCU\kimi-cu.exe" (
  set "APP=%ProgramFiles%\KimiCU\kimi-cu.exe"
)

if not defined APP (
  echo KimiCU for Windows runtime is not installed. Run setup_windows.ps1 from the release bundle, or unzip kimi-cu-win-runtime.zip and run install_runtime.ps1. 1>&2
  exit /b 1
)

"%APP%" mcp
