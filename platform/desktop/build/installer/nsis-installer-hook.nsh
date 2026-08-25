; Runs the bundled extras provisioning script (helm, az CLI, PATH setup) during
; NSIS install/uninstall.

!macro customInstall
	DetailPrint "Running FocusKube extras install script..."
	nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$INSTDIR\resources\extras\install-extras.ps1"'
!macroend

!macro customUnInit
	DetailPrint "Running FocusKube extras uninstall script..."
	nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$INSTDIR\resources\extras\install-extras.ps1" -Action uninstall'
!macroend
