#!/usr/bin/env bash
#
# install-extras.sh — macOS/Linux counterpart to install-extras.ps1.
# Ensures node, az (Azure CLI), helm, and Azure kubelogin are available,
# installing them via Homebrew (macOS) or apt (Debian/Ubuntu Linux) when missing.
# Best-effort: a tool that can't be auto-installed is logged with a manual
# install link rather than failing the whole run.
#
# Usage: install-extras.sh [install|uninstall]

set -uo pipefail

ACTION="${1:-install}"
UNAME_S="$(uname -s)"
IS_MAC=false
IS_LINUX=false
case "$UNAME_S" in
  Darwin) IS_MAC=true ;;
  Linux)  IS_LINUX=true ;;
esac

log()  { printf '[%s] [%s] [install-extras] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${2:-INFO}" "$1"; }
step() { log ">>> $1" 'STEP'; }
ok()   { log "$1" 'OK'; }
fail() { log "$1" 'FAIL'; }

have() { command -v "$1" >/dev/null 2>&1; }

# ─── Homebrew helpers (macOS) ─────────────────────────────────────────────

ensure_brew() {
  if have brew; then return 0; fi
  log 'Homebrew not found; cannot auto-install tools on macOS without it.' 'WARN'
  log 'Install Homebrew from https://brew.sh and re-run, or install tools manually.' 'WARN'
  return 1
}

# ─── apt helpers (Debian/Ubuntu Linux) ────────────────────────────────────

apt_available() { have apt-get; }

apt_install() {
  local pkg="$1"
  if [ "$(id -u)" -eq 0 ]; then
    apt-get update -y >/dev/null 2>&1 && apt-get install -y "$pkg" >/dev/null 2>&1
  elif have sudo; then
    sudo apt-get update -y >/dev/null 2>&1 && sudo apt-get install -y "$pkg" >/dev/null 2>&1
  else
    return 1
  fi
}

# ─── node ──────────────────────────────────────────────────────────────────

ensure_node() {
  step 'Ensuring tool: node'
  if have node; then
    ok "node already on PATH: $(command -v node) ($(node --version 2>/dev/null))"
    return 0
  fi

  if $IS_MAC && ensure_brew; then
    step 'brew install node'
    if brew install node >/dev/null 2>&1 && have node; then
      ok "node installed via Homebrew: $(command -v node)"
      return 0
    fi
  elif $IS_LINUX && apt_available; then
    step 'apt-get install nodejs npm'
    if apt_install nodejs && have node; then
      ok "node installed via apt: $(command -v node)"
      return 0
    fi
  fi

  fail 'node could not be installed automatically.'
  log 'Please install manually: https://nodejs.org/' 'WARN'
  return 1
}

# ─── az (Azure CLI) ─────────────────────────────────────────────────────────

ensure_az() {
  step 'Ensuring tool: az'
  if have az; then
    ok "az already on PATH: $(command -v az)"
    return 0
  fi

  if $IS_MAC && ensure_brew; then
    step 'brew install azure-cli'
    if brew install azure-cli >/dev/null 2>&1 && have az; then
      ok "az installed via Homebrew: $(command -v az)"
      return 0
    fi
  elif $IS_LINUX; then
    step 'Installing Azure CLI via Microsoft install script'
    if curl -sL https://aka.ms/InstallAzureCLIDeb 2>/dev/null | bash >/dev/null 2>&1 && have az; then
      ok "az installed: $(command -v az)"
      return 0
    fi
  fi

  fail 'az could not be installed automatically.'
  log 'Please install manually: https://learn.microsoft.com/cli/azure/install-azure-cli' 'WARN'
  return 1
}

# ─── helm ───────────────────────────────────────────────────────────────────

ensure_helm() {
  step 'Ensuring tool: helm'
  if have helm; then
    ok "helm already on PATH: $(command -v helm)"
    return 0
  fi

  if $IS_MAC && ensure_brew; then
    step 'brew install helm'
    if brew install helm >/dev/null 2>&1 && have helm; then
      ok "helm installed via Homebrew: $(command -v helm)"
      return 0
    fi
  else
    step 'Installing Helm via official install script'
    if curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 2>/dev/null | bash >/dev/null 2>&1 && have helm; then
      ok "helm installed: $(command -v helm)"
      return 0
    fi
  fi

  fail 'helm could not be installed automatically.'
  log 'Please install manually: https://helm.sh/docs/intro/install/' 'WARN'
  return 1
}

# ─── Azure kubelogin ─────────────────────────────────────────────────────────
# Azure kubelogin (Azure/kubelogin) is different from OIDC kubelogin
# (int128/kubelogin). The official cross-platform install path is
# `az aks install-cli`, which drops it into ~/.azure-kubelogin/.

ensure_azure_kubelogin() {
  step 'Ensuring Azure kubelogin (Azure/kubelogin)'
  if have kubelogin; then
    ok "kubelogin already on PATH: $(command -v kubelogin)"
    return 0
  fi

  local kubelogin_dir="$HOME/.azure-kubelogin"
  if [ -x "$kubelogin_dir/kubelogin" ]; then
    ok "Azure kubelogin found at: $kubelogin_dir/kubelogin"
    return 0
  fi

  if have az; then
    step 'Trying: az aks install-cli'
    if az aks install-cli >/dev/null 2>&1 && [ -x "$kubelogin_dir/kubelogin" ]; then
      ok "Azure kubelogin installed via az aks install-cli: $kubelogin_dir/kubelogin"
      return 0
    fi
    log 'az aks install-cli did not produce a kubelogin binary' 'WARN'
  else
    log 'az not available yet; skipping az aks install-cli' 'WARN'
  fi

  if $IS_MAC && have brew; then
    step 'brew install Azure/kubelogin/kubelogin'
    if brew install Azure/kubelogin/kubelogin >/dev/null 2>&1 && have kubelogin; then
      ok "kubelogin installed via Homebrew: $(command -v kubelogin)"
      return 0
    fi
  fi

  fail 'Azure kubelogin could not be installed automatically.'
  log 'Recommended: run `az aks install-cli` in a terminal after Azure CLI is installed.' 'WARN'
  log 'Or download from: https://github.com/Azure/kubelogin/releases' 'WARN'
  return 1
}

# ─── Main ────────────────────────────────────────────────────────────────────

log "=== install-extras starting (Action=$ACTION, OS=$UNAME_S) ==="

if [ "$ACTION" = 'install' ]; then
  any_failed=0
  ensure_node || any_failed=1
  ensure_az || any_failed=1
  ensure_helm || any_failed=1
  ensure_azure_kubelogin || any_failed=1

  if [ "$any_failed" -eq 1 ]; then
    fail 'One or more tools failed to install. See log above for details.'
    exit 1
  fi
  ok 'All tools installed successfully.'
else
  log '=== Uninstall not automated on this platform ==='
  log 'Remove tools manually via brew/apt if desired (e.g. `brew uninstall helm`).' 'WARN'
fi
