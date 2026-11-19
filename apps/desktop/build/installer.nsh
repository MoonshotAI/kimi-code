!ifmacrodef installKimiProtocol
  !macro customInstall
    !insertmacro installKimiProtocol
  !macroend
!endif

!macro customUnInstall
  ${IfNot} ${isUpdated}
    StrCpy $0 1
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --restore-lid-sleep-on-uninstall' $0
    ${If} ${Errors}
      StrCpy $0 1
    ${EndIf}
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "Could not restore lid-close power settings. Open ${PRODUCT_NAME}, turn off Keep awake when lid is closed, then retry uninstalling." /SD IDOK
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  !ifmacrodef uninstallKimiProtocol
    !insertmacro uninstallKimiProtocol
  !endif
!macroend
