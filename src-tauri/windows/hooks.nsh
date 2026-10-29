; YAOC-specific integration; no runtime shortcut writes and no user-data removal.
!include "StrFunc.nsh"
${StrRep}

!macro YAOC_CheckFunction PREFIX
Function ${PREFIX}YAOCCheckInstalledExecutable
  IfFileExists "$INSTDIR\yaoc.exe" 0 done
  StrCpy $2 0
  retry:
    ; Opening a mapped executable for writing fails. Check this exact path only.
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\yaoc.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0'
    ${If} $0 != -1
      System::Call 'kernel32::CloseHandle(p r0)'
      Goto done
    ${EndIf}
    IntOp $2 $2 + 1
    ${If} $2 < 60
      Sleep 500
      Goto retry
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close YAOC at $INSTDIR\yaoc.exe (including its tray icon), then retry. No other copy will be closed automatically." /SD IDOK
    Abort
  done:
FunctionEnd
!macroend
!insertmacro YAOC_CheckFunction ""
!insertmacro YAOC_CheckFunction "un."

!macro NSIS_HOOK_POSTINSTALL
  ; Windows paths cannot contain quotes; escape backslashes for JSON.
  ${StrRep} $0 "$INSTDIR" "\" "\\"
  ClearErrors
  FileOpen $1 "$INSTDIR\install-metadata.json" w
  IfErrors metadata_error
  FileWriteUTF16LE /BOM $1 '{$\"formatVersion$\":1,$\"installDirectory$\":$\"$0$\"}'
  FileClose $1
  IfErrors metadata_error
  WriteRegStr HKCU "Software\Classes\AppUserModelId\${BUNDLEID}" "DisplayName" "YAOC"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\${BUNDLEID}" "IconUri" "$INSTDIR\yaoc.exe"
  Goto metadata_done
  metadata_error:
    MessageBox MB_OK|MB_ICONSTOP "Could not write YAOC installation metadata. Reinstall before launching." /SD IDOK
    Abort
  metadata_done:
!macroend
