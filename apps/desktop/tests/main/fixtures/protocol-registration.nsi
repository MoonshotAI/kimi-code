Unicode true
!include "LogicLib.nsh"
!define APP_EXECUTABLE_FILENAME "Kimi Code.exe"
!include "${PROTOCOL_INCLUDE}"

Name "Protocol registration test"
OutFile "${TEST_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
InstallDir "$TEMP\Kimi Protocol Test"
Var installMode

Section
  SetShellVarContext current
  StrCpy $installMode "current"
  !ifdef TEST_UNINSTALL
    !insertmacro uninstallKimiProtocol
  !else
    !insertmacro installKimiProtocol
  !endif
SectionEnd
