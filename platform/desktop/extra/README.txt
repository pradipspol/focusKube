DESKTOP EXTRAS SETUP GUIDE
===========================

Tools are installed online through platform package-manager or vendor commands.
Windows uses WinGet; macOS uses Homebrew; Linux uses apt and vendor install
scripts. Helm and kubectl executables are not bundled in the desktop app.

This directory contains only the installation scripts required by the desktop app.

QUICK START CHECKLIST
=====================

For an online installation:
  ✓ Copy install-extras.ps1 here (already in repo)
  ✓ Copy install-extras.sh here for macOS/Linux packaging
  ✓ Run: npm run desktop:package
  ✗ Requires internet and WinGet on Windows, Homebrew on macOS, or apt on Linux

FILES NEEDED
============

install-extras.ps1        [PROVIDED]
├─ PowerShell script that runs on app startup
└─ Installs tools with WinGet when they are not already on PATH

az                        [INSTALLED ONLINE]
└─ Windows: winget install Microsoft.AzureCLI

helm                      [INSTALLED ONLINE]
└─ Windows: winget install Helm.Helm

kubectl                   [INSTALLED ONLINE]
└─ Windows: winget install Kubernetes.kubectl

kubelogin                 [INSTALLED ONLINE]
└─ Installed with az aks install-cli, or through WinGet when necessary

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
  
  winget available?
    YES → Install via winget + refresh PATH → Done
    NO → FAIL - Show error with download link
  ↓
main.js builds augmented PATH including:
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

2. WinGet unavailable?
  - Install it from: https://learn.microsoft.com/en-us/windows/package-manager/winget/
  - Or install the required CLI tool manually, then restart the app

3. Tools installed but still not found?
   - Run PowerShell terminal AFTER app installation
   - New shell will pick up updated PATH
   - Try: az --version, helm version, kubectl version, kubelogin

4. Run installer script manually:
   - Open PowerShell (Admin)
   - cd desktop\extra
   - .\install-extras.ps1 -Action install
   - Check output for specific errors

DEVELOPER NOTES
===============

- install-extras.ps1 runs automatically on every app launch (not just first time)
  → This ensures tools stay available even if user removes them later
  
- Script output appears in app console in dev mode
  → In packaged app, the installer script is available in resources/extras/
  
- afterPack.js does NOT copy extras; electron-builder does via extraResources
  → Configured in desktop/package.json build.extraResources


