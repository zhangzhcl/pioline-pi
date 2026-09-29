param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:GH_TOKEN -or -not $env:GITHUB_REPOSITORY) {
  throw 'GH_TOKEN and GITHUB_REPOSITORY are required to locate the prior MSI.'
}

$configPath = Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json'
$currentVersionText = [string](Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).version
if ($currentVersionText -match '^(?<base>\d+\.\d+\.\d+)-(?<encodedPrerelease>\d+)$') {
  $currentVersion = [version]"$($Matches.base).$($Matches.encodedPrerelease)"
} elseif ($currentVersionText -match '^\d+\.\d+\.\d+(\.\d+)?$') {
  $currentVersion = [version]$currentVersionText
} else {
  throw "Configured MSI version cannot be compared with published stable releases: $currentVersionText"
}
$releasesJson = & gh release list `
  --repo $env:GITHUB_REPOSITORY `
  --limit 100 `
  --exclude-drafts `
  --json tagName,isPrerelease,isDraft
if ($LASTEXITCODE -ne 0) {
  throw 'Could not list Pipline releases for MSI upgrade verification.'
}
$releases = @()
if (-not [string]::IsNullOrWhiteSpace(($releasesJson -join ''))) {
  $releases = @($releasesJson | ConvertFrom-Json)
}
$priorStable = @(
  foreach ($release in $releases) {
    if ($release.isDraft -or $release.isPrerelease -or $release.tagName -notmatch '^v(?<version>\d+\.\d+\.\d+)$') {
      continue
    }
    $version = [version]$Matches.version
    if ($version -lt $currentVersion) {
      [pscustomobject]@{ Tag = $release.tagName; Version = $version }
    }
  }
) | Sort-Object Version -Descending | Select-Object -First 1

if (-not $priorStable) {
  if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value 'path=' -Encoding utf8
  }
  Write-Output "[prior-msi] no published stable release is older than $currentVersion; install-only smoke will run."
  exit 0
}

$destination = [IO.Path]::GetFullPath($DestinationPath)
if (Test-Path -LiteralPath $destination) {
  throw "Prior MSI destination already exists; refusing to use stale files: $destination"
}
New-Item -ItemType Directory -Path $destination | Out-Null
& gh release download $priorStable.Tag `
  --repo $env:GITHUB_REPOSITORY `
  --pattern 'Pipline_*_x64_en-US.msi' `
  --dir $destination
if ($LASTEXITCODE -ne 0) {
  throw "Could not download the x64 MSI for prior stable release $($priorStable.Tag)."
}
$msiFiles = @(Get-ChildItem -LiteralPath $destination -Filter '*.msi' -File)
if ($msiFiles.Count -ne 1) {
  throw "Expected one prior x64 MSI for $($priorStable.Tag), found $($msiFiles.Count)."
}
if ($env:GITHUB_OUTPUT) {
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "path=$($msiFiles[0].FullName)" -Encoding utf8
}
Write-Output "[prior-msi] selected $($priorStable.Tag) ($($priorStable.Version)): $($msiFiles[0].Name)"
