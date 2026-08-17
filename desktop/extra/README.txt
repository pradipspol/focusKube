DESKTOP EXTRAS SETUP GUIDE
===========================

This directory must contain required CLI tools before packaging the desktop app.

QUICK START CHECKLIST
=====================

For a fully bundled installation (RECOMMENDED - works offline):
  ✓ Copy install-extras.ps1 here (already in repo)
  ✓ Download az_installer.msi and place here as "az_installer.msi"
  ✓ Download kubectl.exe and place here as "kubectl.exe"
  ✓ Download helm.exe and place here as "helm.exe"
  ✓ Download kubelogin.exe and place here as "kubelogin.exe"
  ✓ Run: npm run desktop:package

For minimal bundling (uses winget fallback):
  ✓ Copy install-extras.ps1 here (already in repo)
  ✓ Run: npm run desktop:package
  ✗ Note: Requires internet + winget on target machine

FILES NEEDED
============

install-extras.ps1        [PROVIDED]
├─ PowerShell script that runs on app startup
└─ Checks/installs tools from bundled files or winget

az_installer.msi          [YOU MUST DOWNLOAD]
├─ Download: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows
├─ Look for: "MSI Installer" or "azure-cli-<version>.msi"
├─ Rename to: az_installer.msi
├─ Size: ~100 MB
└─ Required for Azure CLI support

kubectl.exe               [YOU MUST DOWNLOAD]
├─ Download: https://dl.k8s.io/release/v1.28.0/bin/windows/amd64/kubectl.exe
├─ Place as: kubectl.exe
├─ Size: ~50 MB
└─ Alternative: winget install Kubernetes.kubectl

helm.exe                  [YOU MUST DOWNLOAD]
├─ Download: https://get.helm.sh/helm-v3.14.0-windows-amd64.zip (extract .exe)
├─ Place as: helm.exe
├─ Size: ~70 MB
└─ Alternative: winget install Helm.Helm

kubelogin.exe             [YOU MUST DOWNLOAD]
├─ Download: https://github.com/Azure/kubelogin/releases/download/v0.0.33/kubelogin.exe
├─ Place as: kubelogin.exe
├─ Size: ~30 MB
└─ Alternative: winget install kubernetes-sigs.kubelogin

INSTALLATION FLOW
=================

User launches app →
  ↓
main.js runs ensureCliTools() →
  ↓
Executes install-extras.ps1 with detailed logging [you will see output]
  ↓
Script checks each tool:
  
  Tool Found on PATH?
    YES → Log path and verify version → Done
    NO → Continue
  
  Bundled binary present?
    YES → Add to user PATH + verify → Done
    NO → Continue
  
  Bundled MSI present (az only)?
    YES → Run MSI silently + refresh PATH → Done
    NO → Continue
  
  winget available?
    YES → Install via winget + refresh PATH → Done
    NO → FAIL - Show error with download link
  ↓
main.js builds augmented PATH including:
  - resources/extras/ (bundled binaries)
  - %LOCALAPPDATA%\Microsoft\WinGet\Links
  - C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin
  ↓
Backend starts with augmented PATH
  ↓
az/helm/kubectl/kubelogin commands work!

TROUBLESHOOTING
===============

If tools still don't work after app starts:

1. Check console output for [tools] log lines showing:
   - Where install-extras.ps1 was found
   - What each tool returned (OK, FAILED, fallback attempted)
   - If script wasn't found, check paths logged

2. Bundled files missing?
   - Script falls back to winget
   - Requires: winget installed + internet connection
   - Download files manually from links above

3. No winget?
   - Install from: https://learn.microsoft.com/en-us/windows/package-manager/winget/
   - Or download tools manually and place in this directory

4. Tools installed but still not found?
   - Run PowerShell terminal AFTER app installation
   - New shell will pick up updated PATH
   - Try: az --version, helm version, kubectl version, kubelogin

5. Run installer script manually:
   - Open PowerShell (Admin)
   - cd desktop\extra
   - .\install-extras.ps1 -Action install
   - Check output for specific errors

DEVELOPER NOTES
===============

- install-extras.ps1 runs automatically on every app launch (not just first time)
  → This ensures tools stay available even if user removes them later
  
- Bundled binaries are added to user PATH permanently (HKCU registry)
  → Persist across app restarts and other terminals
  
- MSI tools (az) rely on system PATH + session PATH augmentation
  → Session PATH is augmented before backend starts for immediate access
  
- Script output appears in app console in dev mode
  → In packaged app, check resources/extras/ directory was created
  
- afterPack.js does NOT copy extras; electron-builder does via extraResources
  → Configured in desktop/package.json build.extraResources


