
Param(
    [ValidateSet('install','uninstall')]
    [string]$Action = 'install'
)

$Script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# ─── Logging ────────────────────────────────────────────────────────────────

function Write-Log {
    param([string]$msg, [string]$Level = 'INFO')
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    Write-Output "[$ts] [$Level] [install-extras] $msg"
}

function Write-Step {
    param([string]$msg)
    Write-Log ">>> $msg" 'STEP'
}

function Write-Ok {
    param([string]$msg)
    Write-Log $msg 'OK'
}

function Write-Fail {
    param([string]$msg)
    Write-Log $msg 'FAIL'
}

# ─── PATH helpers ────────────────────────────────────────────────────────────

# Read the persistent machine + user PATH from the registry and refresh the
# current session so that tools installed seconds ago are immediately visible.
function Refresh-SessionPath {
    try {
        $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
        $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
        $combined    = ($machinePath, $userPath | Where-Object { $_ }) -join ';'
        $env:PATH    = $combined
        Write-Log "Session PATH refreshed (machine + user)"
    } catch {
        Write-Log "Could not refresh session PATH: $($_.Exception.Message)" 'WARN'
    }
}

# Permanently add a directory to the current user's PATH (HKCU).
function Add-ToUserPath {
    param([string]$dir)
    if (-not (Test-Path $dir)) { return }
    try {
        $current = [System.Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not $current) { $current = '' }
        $parts   = $current -split ';' | Where-Object { $_ -ne '' }
        if ($parts -contains $dir) {
            Write-Log "Directory already in user PATH: $dir"
            return
        }
        $newPath = ($parts + $dir) -join ';'
        [System.Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        # Also update current session
        if ($env:PATH -notlike "*$dir*") { $env:PATH = "$env:PATH;$dir" }
        Write-Ok "Added to user PATH: $dir"
    } catch {
        Write-Log "Could not add '$dir' to user PATH: $($_.Exception.Message)" 'WARN'
    }
}

# ─── Command existence ───────────────────────────────────────────────────────

function Test-CommandExists {
    param([string]$cmd)
    return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

# Try to resolve where a command lives; returns the path or $null.
function Resolve-CommandPath {
    param([string]$cmd)
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

# Verify a tool is runnable by executing it with a version flag.
function Test-ToolRunnable {
    param([string]$exe, [string]$versionArg = 'version')
    try {
        $out = & $exe $versionArg 2>&1
        if ($LASTEXITCODE -eq 0 -or ($out -match '\d+\.\d+')) {
            Write-Ok "${exe}: $(($out | Select-Object -First 1) -replace '\s+',' ')"
            return $true
        }
        Write-Log "${exe} exited $LASTEXITCODE during version check" 'WARN'
        return $false
    } catch {
        Write-Log "${exe} version check threw: $($_.Exception.Message)" 'WARN'
        return $false
    }
}

# ─── winget helpers ──────────────────────────────────────────────────────────

# winget exit code 0x8A15002B (-1978335189) means "already installed" — treat as success.
$WINGET_ALREADY_INSTALLED = -1978335189

function Try-Install-WithWinget {
    param([string]$id, [string]$display)
    if (-not (Test-CommandExists 'winget')) {
        Write-Log "winget not available; skipping $display" 'WARN'
        return $false
    }
    Write-Step "winget install $display ($id)"
    try {
        & winget install --id $id -e --accept-package-agreements --accept-source-agreements --disable-interactivity
        $code = $LASTEXITCODE
        if ($code -eq 0 -or $code -eq $WINGET_ALREADY_INSTALLED) {
            Write-Ok "winget install succeeded for $display (exit $code)"
            return $true
        }
        Write-Fail "winget exited $code for $display"
        return $false
    } catch {
        Write-Fail "winget threw for ${display}: $($_.Exception.Message)"
        return $false
    }
}

function Try-Uninstall-WithWinget {
    param([string]$id, [string]$display)
    if (-not (Test-CommandExists 'winget')) { return $false }
    Write-Step "winget uninstall $display ($id)"
    try {
        & winget uninstall --id $id -e --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -eq 0) { Write-Ok "$display uninstalled via winget"; return $true }
        Write-Log "winget uninstall exited $LASTEXITCODE for $display" 'WARN'
        return $false
    } catch {
        Write-Log "winget uninstall threw for ${display}: $($_.Exception.Message)" 'WARN'
        return $false
    }
}

# ─── Download URL helpers ───────────────────────────────────────────────────

function Get-ToolDownloadUrl {
    param([string]$tool)
    $urls = @{
        'az'        = 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows'
        'kubelogin' = 'https://github.com/Azure/kubelogin/releases'
        'node'      = 'https://nodejs.org/'
    }
    return $urls[$tool]
}

# ─── Azure kubelogin installer ───────────────────────────────────────────────
# Azure kubelogin (Azure/kubelogin) is different from OIDC kubelogin (int128/kubelogin).
# It is installed by `az aks install-cli` into ~/.azure-kubelogin/.
# We must NOT use the bundled kubelogin.exe approach because that would use the wrong tool.

function Ensure-AzureKubelogin {
    Write-Step 'Ensuring Azure kubelogin (Azure/kubelogin)'

    # Check if already on PATH
    $existing = Resolve-CommandPath 'kubelogin'
    if ($existing) {
        Write-Ok "kubelogin already on PATH: $existing"
        return $true
    }

    # Check well-known install location used by `az aks install-cli`
    $azureKubeloginDir = Join-Path $env:USERPROFILE '.azure-kubelogin'
    $azureKubeloginExe = Join-Path $azureKubeloginDir 'kubelogin.exe'
    if (Test-Path $azureKubeloginExe) {
        Write-Ok "Azure kubelogin found at: $azureKubeloginExe"
        Add-ToUserPath $azureKubeloginDir
        return $true
    }

    # Try `az aks install-cli` (official method; installs to ~/.azure-kubelogin)
    if (Test-CommandExists 'az') {
        Write-Step 'Trying: az aks install-cli'
        try {
            & az aks install-cli 2>&1 | ForEach-Object { Write-Log $_ }
            if ($LASTEXITCODE -eq 0) {
                if (Test-Path $azureKubeloginExe) {
                    Add-ToUserPath $azureKubeloginDir
                    Write-Ok "Azure kubelogin installed via az aks install-cli: $azureKubeloginExe"
                    return $true
                }
                Write-Log "az aks install-cli exited 0 but kubelogin.exe not found at $azureKubeloginExe" 'WARN'
            } else {
                Write-Log "az aks install-cli exited $LASTEXITCODE" 'WARN'
            }
        } catch {
            Write-Log "az aks install-cli threw: $($_.Exception.Message)" 'WARN'
        }
    } else {
        Write-Log 'az not available yet; skipping az aks install-cli' 'WARN'
    }

    # Fallback: winget with the Azure kubelogin package ID
    if (Try-Install-WithWinget 'Microsoft.Azure.Kubelogin' 'kubelogin (Azure)') {
        Refresh-SessionPath
        if (Test-Path $azureKubeloginExe) { Add-ToUserPath $azureKubeloginDir }
        $installed = Resolve-CommandPath 'kubelogin'
        if ($installed) {
            Write-Ok "kubelogin installed via winget: $installed"
        } else {
            Write-Log 'kubelogin winget install reported success; PATH refresh may need a new shell' 'WARN'
        }
        return $true
    }

    Write-Fail 'Azure kubelogin could not be installed automatically.'
    Write-Log 'Recommended: run `az aks install-cli` in a terminal after Azure CLI is installed.'
    Write-Log 'Or download from: https://github.com/Azure/kubelogin/releases'
    return $false
}

function Uninstall-AzureKubelogin {
    Write-Step 'Uninstalling Azure kubelogin'
    Try-Uninstall-WithWinget 'Microsoft.Azure.Kubelogin' 'kubelogin (Azure)' | Out-Null
    $azureKubeloginExe = Join-Path $env:USERPROFILE '.azure-kubelogin\kubelogin.exe'
    if (Test-Path $azureKubeloginExe) {
        try {
            Remove-Item $azureKubeloginExe -Force -ErrorAction Stop
            Write-Ok "Removed: $azureKubeloginExe"
        } catch {
            Write-Log "Could not remove $azureKubeloginExe : $($_.Exception.Message)" 'WARN'
        }
    }
}

# ─── Ensure-Tool ─────────────────────────────────────────────────────────────

function Ensure-Tool {
    param(
        [string]$cmd,
        [string[]]$wingetIds
    )

    Write-Step "Ensuring tool: $cmd"

    # ── Check if already on PATH ────────────────────────────────────────────
    $existing = Resolve-CommandPath $cmd
    if ($existing) {
        Write-Ok "$cmd already on PATH: $existing"
        Test-ToolRunnable $existing | Out-Null
        return $true
    }

    # ── Try winget ──────────────────────────────────────────────────────────
    foreach ($id in $wingetIds) {
        if (Try-Install-WithWinget $id $cmd) {
            Write-Log "winget install reported success for $cmd; refreshing PATH"
            # Refresh PATH so the newly installed binary is visible
            Refresh-SessionPath
            Start-Sleep -Milliseconds 500  # Give Windows a moment to update registry
            $installed = Resolve-CommandPath $cmd
            if ($installed) {
                Write-Ok "$cmd installed and found at: $installed"
                Test-ToolRunnable $installed | Out-Null
                return $true
            }
            # WinGet may place links in %LOCALAPPDATA%\Microsoft\WinGet\Links
            $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
            Write-Log "Checking WinGet links dir: $wingetLinks"
            if (Test-Path $wingetLinks) {
                $linkExe     = Join-Path $wingetLinks "$cmd.exe"
                $linkCmd     = Join-Path $wingetLinks "$cmd.cmd"
                Write-Log "  Contents: $(Get-ChildItem $wingetLinks -Name | Out-String | ForEach-Object { '    ' + $_ })"
                foreach ($link in @($linkExe, $linkCmd)) {
                    if (Test-Path $link) {
                        Write-Ok "$cmd found in WinGet links: $link"
                        Add-ToUserPath $wingetLinks
                        Test-ToolRunnable $link | Out-Null
                        return $true
                    }
                }
            }
            Write-Log "$cmd installed via winget but still not found on PATH; PATH may need a new shell" 'WARN'
            return $true  # install succeeded even if PATH needs refresh
        }
    }

    Write-Fail "$cmd could not be installed automatically."
    $dlUrl = Get-ToolDownloadUrl $cmd
    if ($dlUrl) { Write-Log "Please install manually or download from: $dlUrl" }
    Write-Log "Extras directory: $Script:ScriptDir"
    return $false
}

function Ensure-NodeJs {
    Write-Step 'Ensuring tool: node'

    # Check if already installed
    $existing = Resolve-CommandPath 'node'
    if ($existing) {
        Write-Ok "node already on PATH: $existing"

        try {
            $version = & node --version 2>&1
            Write-Ok "Node.js version: $version"
        } catch {
            Write-Log "Unable to determine Node.js version" 'WARN'
        }

        return $true
    }

    # Try winget installation
    if (Try-Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS') {
        Refresh-SessionPath
        Start-Sleep -Seconds 2

        $installed = Resolve-CommandPath 'node'
        if ($installed) {
            Write-Ok "Node.js installed and found at: $installed"

            try {
                $version = & node --version 2>&1
                Write-Ok "Node.js version: $version"
            } catch {
                Write-Log "Unable to determine Node.js version" 'WARN'
            }

            return $true
        }

        Write-Log 'Node.js installed but PATH may require a new terminal session' 'WARN'
        return $true
    }

    Write-Fail 'Node.js could not be installed automatically.'
    Write-Log 'Please install manually from: https://nodejs.org/'
    return $false
}

# ─── Main ────────────────────────────────────────────────────────────────────

Write-Log "=== install-extras starting (Action=$Action, ScriptDir=$Script:ScriptDir) ==="
Write-Log "PowerShell version: $($PSVersionTable.PSVersion)"
Write-Log "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Log "Running as: $([System.Environment]::UserName)"
Write-Log "Current PATH entries:"
$env:PATH -split ';' | Where-Object { $_ } | ForEach-Object { Write-Log "  $_" }

if ($Action -eq 'install') {
    $results = [ordered]@{}
    $results['node']      = Ensure-NodeJs
    $results['az']        = Ensure-Tool -cmd 'az'        -wingetIds @('Microsoft.AzureCLI')
    $results['helm']      = Ensure-Tool -cmd 'helm'      -wingetIds @('Helm.Helm')
    $results['kubectl']   = Ensure-Tool -cmd 'kubectl'   -wingetIds @('Kubernetes.kubectl', 'kubernetes.kubectl')
    $results['kubelogin'] = Ensure-AzureKubelogin

    Write-Log "=== Installation summary ==="
    $anyFailed = $false
    foreach ($tool in $results.Keys) {
        $ok = $results[$tool]
        $status = if ($ok) { 'OK' } else { 'FAILED' }
        Write-Log "  $tool : $status"
        if (-not $ok) { $anyFailed = $true }
    }

    if ($anyFailed) {
        Write-Fail "One or more tools failed to install. See log above for details."
        exit 1
    }
    Write-Ok "All tools installed successfully."
} else {
    Write-Log "=== Uninstall complete ==="
}
