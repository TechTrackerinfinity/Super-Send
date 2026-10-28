Unicode true
!include "MUI2.nsh"
Name "Super Send"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Super Send"
InstallDirRegKey HKCU "Software\LocalSendRebuilt" "InstallDir"
RequestExecutionLevel user
SetCompressor zlib
BrandingText "Super Send - Local file sharing"
!define MUI_ICON "${PROJECT_ROOT}\renderer\assets\super-send.ico"
!define MUI_UNICON "${PROJECT_ROOT}\renderer\assets\super-send.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Super Send.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Super Send"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT_ROOT}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
check_running:
  FindWindow $0 "Chrome_WidgetWin_1" "Super Send"
  StrCmp $0 0 +2
  Goto found_running
  FindWindow $0 "Chrome_WidgetWin_1" "LocalSend Rebuilt"
  StrCmp $0 0 done
found_running:
  IfSilent abort_install
  MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "Close Super Send or LocalSend Rebuilt before installing or updating. Your files and settings are kept." IDRETRY check_running
abort_install:
  Abort
done:
FunctionEnd

Section "Super Send" SEC_APP
  SetOutPath "$INSTDIR"
  File /r /x data /x received "${PAYLOAD}\*"
  FileOpen $0 "$INSTDIR\installed.flag" w
  FileWrite $0 "${APP_VERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\LocalSend Rebuilt.lnk"
  Delete "$INSTDIR\LocalSend Rebuilt.exe"
  CreateShortCut "$SMPROGRAMS\Super Send.lnk" "$INSTDIR\Super Send.exe"
  WriteRegStr HKCU "Software\LocalSendRebuilt" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt" "DisplayName" "Super Send"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
un_check_running:
  FindWindow $0 "Chrome_WidgetWin_1" "Super Send"
  StrCmp $0 0 +2
  Goto un_found_running
  FindWindow $0 "Chrome_WidgetWin_1" "LocalSend Rebuilt"
  StrCmp $0 0 un_done
un_found_running:
  IfSilent un_abort
  MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "Close Super Send or LocalSend Rebuilt before uninstalling. Received files and settings are kept." IDRETRY un_check_running
un_abort:
  Abort
un_done:
FunctionEnd

Section "Uninstall"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=windows-network.ps1 "${PROJECT_ROOT}\scripts\windows-network.ps1"
  ; Clean both owned executable names when uninstalling a renamed installation.
  StrCpy $R0 "$INSTDIR\Super Send.exe"
  Call un.RemoveOwnedRules
  StrCpy $R0 "$INSTDIR\LocalSend Rebuilt.exe"
  Call un.RemoveOwnedRules
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\installed.flag"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Super Send.lnk"
  Delete "$SMPROGRAMS\LocalSend Rebuilt.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalSendRebuilt"
  DeleteRegKey HKCU "Software\LocalSendRebuilt"
SectionEnd

Function un.RemoveOwnedRules
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\windows-network.ps1" -Action Remove -Program "$R0" -ResultPath "$PLUGINSDIR\network-result.json"'
  Pop $0
  Pop $1
  StrCmp $0 0 rules_done
  MessageBox MB_OK|MB_ICONEXCLAMATION "App network rules could not be removed. Approve Windows cleanup, then run uninstall again. Application files have been kept." /SD IDOK
  Abort
rules_done:
FunctionEnd
