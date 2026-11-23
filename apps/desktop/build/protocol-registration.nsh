!ifndef KIMI_PROTOCOL_REGISTRY_KEY
  !define KIMI_PROTOCOL_REGISTRY_KEY "Software\Classes\kimi-code"
!endif

!macro registerKimiProtocol ROOT
  WriteRegStr ${ROOT} "${KIMI_PROTOCOL_REGISTRY_KEY}" "" "URL:Kimi Code Protocol"
  WriteRegStr ${ROOT} "${KIMI_PROTOCOL_REGISTRY_KEY}" "URL Protocol" ""
  WriteRegStr ${ROOT} "${KIMI_PROTOCOL_REGISTRY_KEY}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr ${ROOT} "${KIMI_PROTOCOL_REGISTRY_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro unregisterKimiProtocol ROOT
  ReadRegStr $R0 ${ROOT} "${KIMI_PROTOCOL_REGISTRY_KEY}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey ${ROOT} "${KIMI_PROTOCOL_REGISTRY_KEY}"
  ${EndIf}
!macroend

!macro installKimiProtocol
  !insertmacro registerKimiProtocol SHELL_CONTEXT
  ${If} $installMode == "all"
    !insertmacro registerKimiProtocol HKCU
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro uninstallKimiProtocol
  !insertmacro unregisterKimiProtocol SHELL_CONTEXT
  ${If} $installMode == "all"
    !insertmacro unregisterKimiProtocol HKCU
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
