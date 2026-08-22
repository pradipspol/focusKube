; Runs the bundled extras provisioning script (helm, az CLI, PATH setup) during
; NSIS install/uninstall, mirroring the WiX custom actions used for the MSI
; installer in package.js.

!macro customInstall
  DetailPrint "Running k8-explorer extras install script..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$INSTDIR\resources\extras\install-extras.ps1"'
!macroend

!macro customUnInit
  DetailPrint "Running k8-explorer extras uninstall script..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$INSTDIR\resources\extras\install-extras.ps1" -Action uninstall'
!macroend
