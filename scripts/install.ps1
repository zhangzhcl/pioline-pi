# Pipline installer — Windows 10 x64 (PowerShell 5.1+)
# Usage:
#   $env:PIPLINE_GITHUB_REPOSITORY = 'owner/repository'
#   irm "https://raw.githubusercontent.com/$env:PIPLINE_GITHUB_REPOSITORY/main/scripts/install.ps1" | iex
# Or with a pinned version:
#   & ([scriptblock]::Create((irm "https://raw.githubusercontent.com/$env:PIPLINE_GITHUB_REPOSITORY/main/scripts/install.ps1"))) -Version v0.1.0
# Or with MSI (for enterprise/GPO deployment):
#   & ([scriptblock]::Create((irm "https://raw.githubusercontent.com/$env:PIPLINE_GITHUB_REPOSITORY/main/scripts/install.ps1"))) -MSI
[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$Repository = $env:PIPLINE_GITHUB_REPOSITORY,
  # Use MSI installer instead of NSIS .exe (for enterprise/GPO deployment)
  [switch]$MSI,
  [switch]$Help
)

if ($Help) {
  Write-Host @"
Pipline Windows 10 x64 Installer

Usage: install.ps1 -Repository <owner/repository> [-Version <tag>] [-MSI]
  -Repository GitHub repository containing Pipline releases. May also be set with PIPLINE_GITHUB_REPOSITORY.
  -Version   Install a specific release tag (e.g. v0.1.0). Defaults to latest.
  -MSI       Use MSI installer instead of NSIS .exe (for enterprise/GPO deployment).
  -Help      Show this help message.
"@
  exit 0
}

# ── Helpers ───────────────────────────────────────────────────────────────────
$ESC = [char]27
function Write-Info    { Write-Host "  $ESC[36m•$ESC[0m $args" }
function Write-Success { Write-Host "  $ESC[32m✓$ESC[0m $args" }
function Write-Warn    { Write-Host "  $ESC[33m⚠$ESC[0m $args" }
function Write-Header  { Write-Host "`n$ESC[1m$args$ESC[0m" }
function Fail([string]$msg) { Write-Host "  $ESC[31m✗$ESC[0m $msg" -ForegroundColor Red; exit 1 }

# ── Detect arch ───────────────────────────────────────────────────────────────
$CpuArch = $env:PROCESSOR_ARCHITECTURE
$ArchNorm = switch ($CpuArch) {
  "AMD64" { "x64" }
  default { Fail "Pipline's first release supports Windows 10 x64 only. Detected architecture: $CpuArch" }
}

# ── Constants ─────────────────────────────────────────────────────────────────
$Repo       = if ([string]::IsNullOrWhiteSpace($Repository)) { "" } else { $Repository.Trim() }
if ($Repo -notmatch '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') {
  Fail "Set -Repository <owner/repository> or PIPLINE_GITHUB_REPOSITORY to the Pipline GitHub repository."
}
$ApiBase    = "https://api.github.com/repos/$Repo/releases"
$DlBase     = "https://github.com/$Repo/releases/download"
$AppName    = "Pipline"

# ── Resolve version ───────────────────────────────────────────────────────────
Write-Header "🎯  $AppName Installer (Windows)"

if ($Version -ne "") {
  Write-Info "Using pinned version: $Version"
} else {
  Write-Info "Fetching latest release from GitHub..."
  try {
    $release = Invoke-RestMethod -Uri "$ApiBase/latest" -Headers @{ "User-Agent" = "pipline-installer" }
    $Version = $release.tag_name
  } catch {
    Fail "Failed to fetch latest release: $_"
  }
  Write-Info "Latest version: $Version"
}

# Strip leading 'v' for filename
$Ver = $Version -replace '^v', ''

# ── Build filename ────────────────────────────────────────────────────────────
# Default: NSIS .exe (lighter, has uninstall support, preferred for end-users)
# -MSI flag: MSI package (for enterprise/GPO deployment)
if ($MSI) {
  $Filename = "${AppName}_${Ver}_${ArchNorm}_en-US.msi"
} else {
  $Filename = "${AppName}_${Ver}_${ArchNorm}-setup.exe"
}
$DownloadUrl = "$DlBase/$Version/$Filename"

# ── Download ──────────────────────────────────────────────────────────────────
Write-Header "⬇️   Downloading"
Write-Info "URL:  $DownloadUrl"
Write-Info "File: $Filename"

$TempDir  = [System.IO.Path]::GetTempPath()
$Dest     = Join-Path $TempDir $Filename

try {
  $ProgressPreference = 'SilentlyContinue'   # speeds up Invoke-WebRequest significantly
  Invoke-WebRequest -Uri $DownloadUrl -OutFile $Dest -UseBasicParsing
} catch {
  Fail "Download failed: $_"
}

if (-not (Test-Path $Dest)) { Fail "Downloaded file not found at $Dest" }
Write-Success "Downloaded $Filename"

# ── Install ───────────────────────────────────────────────────────────────────
Write-Header "📦  Installing"
Write-Info "Running NSIS installer (silent)..."

# NSIS: /S = silent install
# MSI:  /quiet /norestart
$installArgs = if ($MSI) { @("/i", $Dest, "/quiet", "/norestart") } else { @("/S") }
$installExe  = if ($MSI) { "msiexec.exe" } else { $Dest }
$proc = Start-Process -FilePath $installExe -ArgumentList $installArgs -Wait -PassThru

if ($proc.ExitCode -ne 0) {
  Fail "Installer exited with code $($proc.ExitCode). Try running the file manually: $Dest"
}

# Clean up (MSI must be kept until install finishes; already waited above)
Remove-Item $Dest -ErrorAction SilentlyContinue
Write-Success "Installed $AppName $Version"

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  $ESC[1;32m✓ $AppName $Version installed successfully!$ESC[0m"
Write-Host "  $ESC[36m•$ESC[0m Launch it from the Start Menu or Desktop shortcut."
Write-Host ""
