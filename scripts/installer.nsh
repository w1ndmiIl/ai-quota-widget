; Keep portable data outside the directory removed by the previous uninstaller.
; Retain the backup after installation so a failed/cancelled upgrade is recoverable.
!ifndef BUILD_UNINSTALLER
Var aiBarOldDirectory
Var aiBarDataBackup

!macro customInit
  ReadRegStr $aiBarOldDirectory SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $aiBarOldDirectory == ""
    StrCpy $aiBarOldDirectory "$INSTDIR"
  ${EndIf}
  StrCpy $aiBarDataBackup "$aiBarOldDirectory.ai-bar-data-backup"
  ${If} ${FileExists} "$aiBarOldDirectory\.userdata\*.*"
    CreateDirectory "$aiBarDataBackup"
    ClearErrors
    CopyFiles /SILENT "$aiBarOldDirectory\.userdata" "$aiBarDataBackup"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Could not back up AI_bar data. Close AI_bar and retry."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!endif

!macro customInstall
  ${If} ${FileExists} "$aiBarDataBackup\.userdata\*.*"
    CreateDirectory "$INSTDIR"
    ClearErrors
    CopyFiles /SILENT "$aiBarDataBackup\.userdata" "$INSTDIR"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "AI_bar data could not be restored. Your backup is at $aiBarDataBackup"
      Abort
    ${EndIf}
  ${EndIf}
!macroend
