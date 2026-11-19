Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APP "Apolloon Telsysteem"
!define INSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ApolloonNative"
!define POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define FIREWALL '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\apolloon-firewall.ps1"'

Name "${APP}"
OutFile "${SETUP_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Apolloon Telsysteem Native"
InstallDirRegKey HKCU "${INSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
!define MUI_ICON "${SOURCE_DIR}\build\icon.ico"
!define MUI_UNICON "${SOURCE_DIR}\build\icon.ico"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Dutch"

Section "Apolloon" Install
  SetOutPath "$INSTDIR"
  File /r "${PACKAGE_DIR}\*"
  File "${SOURCE_DIR}\build\apolloon-firewall.ps1"
  File "${SOURCE_DIR}\build\icon.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${INSTALL_KEY}" "DisplayName" "${APP} (Native)"
  WriteRegStr HKCU "${INSTALL_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${INSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${INSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  CreateShortcut "$SMPROGRAMS\Apolloon Telsysteem Native.lnk" "$INSTDIR\apolloon-native.exe" "" "$INSTDIR\icon.ico"
  CreateShortcut "$DESKTOP\Apolloon Telsysteem Native.lnk" "$INSTDIR\apolloon-native.exe" "" "$INSTDIR\icon.ico"
  nsExec::Exec '"${POWERSHELL}" ${FIREWALL} check "$INSTDIR\apolloon-native.exe" "Apolloon Native"'
  Pop $0
  ${If} $0 != 0
    ExecShellWait "runas" "${POWERSHELL}" '${FIREWALL} add "$INSTDIR\apolloon-native.exe" "Apolloon Native"' SW_HIDE
  ${EndIf}
SectionEnd

Section "Uninstall"
  nsExec::Exec '"${POWERSHELL}" ${FIREWALL} present "$INSTDIR\apolloon-native.exe" "Apolloon Native"'
  Pop $0
  ${If} $0 == 0
    ExecShellWait "runas" "${POWERSHELL}" '${FIREWALL} remove "$INSTDIR\apolloon-native.exe" "Apolloon Native"' SW_HIDE
  ${EndIf}
  Delete "$SMPROGRAMS\Apolloon Telsysteem Native.lnk"
  Delete "$DESKTOP\Apolloon Telsysteem Native.lnk"
  DeleteRegKey HKCU "${INSTALL_KEY}"
  Delete "$INSTDIR\apolloon-native.exe"
  Delete "$INSTDIR\apolloon-native.exe.old"
  Delete "$INSTDIR\apolloon-firewall.ps1"
  Delete "$INSTDIR\icon.ico"
  RMDir /r "$INSTDIR\web-dist"
  RMDir /r "$INSTDIR\web-dist.old"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
