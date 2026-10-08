; Opens the firewall for the linked laptops (resources\apolloon-firewall.ps1). The per-user
; installer runs without admin, so it asks Windows for permission only when a rule is
; missing: once on a new laptop, not on every update. Saying no still installs the app;
; Beheer > Systeem > Vast netwerkadres adds the same rules later.

!define APOLLOON_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define APOLLOON_FIREWALL '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\apolloon-firewall.ps1"'

!macro customInstall
  Push $0
  nsExec::Exec '"${APOLLOON_POWERSHELL}" ${APOLLOON_FIREWALL} check "$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ${if} $0 != 0
    ExecShellWait "runas" "${APOLLOON_POWERSHELL}" '${APOLLOON_FIREWALL} add "$INSTDIR\${APP_EXECUTABLE_FILENAME}"' SW_HIDE
    ClearErrors
  ${endIf}
  Pop $0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    nsExec::Exec '"${APOLLOON_POWERSHELL}" ${APOLLOON_FIREWALL} present'
    Pop $0
    ${if} $0 == 0
      ExecShellWait "runas" "${APOLLOON_POWERSHELL}" '${APOLLOON_FIREWALL} remove' SW_HIDE
      ClearErrors
    ${endIf}
    Pop $0
  ${endIf}
!macroend
