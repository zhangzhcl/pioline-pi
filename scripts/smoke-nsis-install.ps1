param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'assert-installed-license-payload.ps1')

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$configPath = Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$expectedProductName = [string]$config.productName
$tempRoot = Join-Path $env:TEMP "pipline-nsis-smoke-$PID"
$tempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$fullTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
if (-not $fullTempRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "NSIS smoke path is outside TEMP: $fullTempRoot"
}
if (Test-Path -LiteralPath $fullTempRoot) {
  throw "NSIS smoke directory already exists; refusing to reuse it: $fullTempRoot"
}

$installDirectory = Join-Path $fullTempRoot 'Pipline'
$piAgentDirectory = Join-Path $fullTempRoot 'pi-agent'
$previousPiAgentDirectory = [Environment]::GetEnvironmentVariable('PI_CODING_AGENT_DIR', 'Process')
$appPath = Join-Path $installDirectory 'pipline.exe'
$expectedPiPath = Join-Path $installDirectory 'pi\pi.exe'
$expectedBridgePath = Join-Path $installDirectory 'extensions\picot-bridge.mjs'
$uninstallerPath = Join-Path $installDirectory 'uninstall.exe'
$appProcess = $null
$installerProcess = $null
$uninstallerProcess = $null

function Get-PiplineRegistration {
  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  @(
    $uninstallRoots | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } |
      Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $expectedProductName }
  )
}

$existingRegistrations = @(Get-PiplineRegistration)
if ($existingRegistrations.Count -ne 0) {
  throw "A '$expectedProductName' installation is already registered; refusing to modify it on the smoke runner."
}

New-Item -ItemType Directory -Path $fullTempRoot | Out-Null

function Stop-SmokeApplication {
  if (-not $script:appProcess) {
    return
  }
  $script:appProcess.Refresh()
  if (-not $script:appProcess.HasExited) {
    [void]$script:appProcess.CloseMainWindow()
    if (-not $script:appProcess.WaitForExit(10000)) {
      Stop-Process -Id $script:appProcess.Id -Force -ErrorAction SilentlyContinue
      [void]$script:appProcess.WaitForExit(5000)
    }
  }
  $script:appProcess.Dispose()
  $script:appProcess = $null
}

try {
  $installerProcess = Start-Process -FilePath $resolvedInstaller `
    -ArgumentList @('/S', "/D=$installDirectory") -WindowStyle Hidden -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installerProcess.ExitCode)."
  }
  foreach ($requiredPath in @($appPath, $expectedPiPath, $expectedBridgePath, $uninstallerPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "NSIS installation is missing required payload: $requiredPath"
    }
  }
  Assert-PiplineLicensePayload -InstallDirectory $installDirectory
  $publicDirectory = Join-Path $installDirectory 'public'
  $requiredFrontendAssets = @(
    (Join-Path $publicDirectory 'index.html'),
    (Join-Path $publicDirectory 'compat\bootstrap-entry.js'),
    (Join-Path $publicDirectory 'vendor\workflow-code-compiler-worker.js'),
    (Join-Path $publicDirectory 'vendor\esbuild.wasm')
  )
  foreach ($requiredPath in $requiredFrontendAssets) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "NSIS installation is missing required frontend asset: $requiredPath"
    }
  }
  $shippedTests = @(
    Get-ChildItem -LiteralPath $publicDirectory -Recurse -File |
      Where-Object { $_.Name -match '\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$' }
  )
  if ($shippedTests.Count -gt 0) {
    throw "NSIS installation contains frontend test modules: $($shippedTests.FullName -join ', ')"
  }
  $registrations = @(Get-PiplineRegistration)
  if ($registrations.Count -ne 1) {
    throw "NSIS installation did not create exactly one '$expectedProductName' registration."
  }
  $registeredLocation = ([string]$registrations[0].InstallLocation).Trim('"')
  $normalizedRegistration = [System.IO.Path]::GetFullPath($registeredLocation).TrimEnd('\')
  $normalizedInstallDirectory = [System.IO.Path]::GetFullPath($installDirectory).TrimEnd('\')
  if (-not [string]::Equals($normalizedRegistration, $normalizedInstallDirectory, [StringComparison]::OrdinalIgnoreCase)) {
    throw "NSIS registered install location '$registeredLocation' instead of '$installDirectory'."
  }

  New-Item -ItemType Directory -Path $piAgentDirectory | Out-Null
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piAgentDirectory, 'Process')
  $appProcess = Start-Process -FilePath $appPath -WorkingDirectory $installDirectory -WindowStyle Hidden -PassThru
  $script:appProcess = $appProcess
  $piRuntimeProcess = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
      throw "Installed Pipline exited during startup with code $($appProcess.ExitCode)."
    }
    $piRuntimeProcess = Get-Process -Name 'pi' -ErrorAction SilentlyContinue |
      Where-Object { try { $_.Path -eq $expectedPiPath } catch { $false } } |
      Select-Object -First 1
    if ($piRuntimeProcess) {
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $piRuntimeProcess) {
    throw "Installed Pipline did not start its bundled Pi Runtime at $expectedPiPath within 30 seconds."
  }
  Write-Output "[nsis-install-smoke] launched Pipline from $appPath with bundled Pi PID $($piRuntimeProcess.Id)"
  Stop-SmokeApplication

  $piStopped = $false
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    $remainingPi = Get-Process -Name 'pi' -ErrorAction SilentlyContinue |
      Where-Object { try { $_.Path -eq $expectedPiPath } catch { $false } } |
      Select-Object -First 1
    if (-not $remainingPi) {
      $piStopped = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $piStopped) {
    throw 'The bundled Pi Runtime did not stop after closing Pipline.'
  }

  $uninstallerProcess = Start-Process -FilePath $uninstallerPath -ArgumentList @('/S') `
    -WindowStyle Hidden -Wait -PassThru
  if ($uninstallerProcess.ExitCode -ne 0) {
    throw "NSIS uninstaller exited with code $($uninstallerProcess.ExitCode)."
  }
  if (Test-Path -LiteralPath $installDirectory) {
    throw "NSIS uninstall left the installation directory behind: $installDirectory"
  }
  $remainingRegistrations = @(Get-PiplineRegistration)
  if ($remainingRegistrations.Count -ne 0) {
    throw "NSIS uninstall left a '$expectedProductName' Add/Remove Programs registration."
  }
  Write-Output '[nsis-install-smoke] installed, launched, and uninstalled Pipline with its bundled Pi runtime'
}
finally {
  Stop-SmokeApplication
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $previousPiAgentDirectory, 'Process')
  Get-Process -Name 'pi' -ErrorAction SilentlyContinue |
    Where-Object { try { $_.Path -eq $expectedPiPath } catch { $false } } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $uninstallerPath) {
    $cleanup = Start-Process -FilePath $uninstallerPath -ArgumentList @('/S') `
      -WindowStyle Hidden -Wait -PassThru
    if ($cleanup.ExitCode -ne 0) {
      throw "NSIS smoke cleanup uninstaller exited with code $($cleanup.ExitCode)."
    }
  }
  if (Test-Path -LiteralPath $fullTempRoot) {
    Remove-Item -LiteralPath $fullTempRoot -Recurse -Force
  }
}
