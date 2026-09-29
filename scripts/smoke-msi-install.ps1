param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath,
  [string]$PreviousMsiPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'assert-installed-license-payload.ps1')

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'The per-machine MSI smoke check requires an elevated Windows runner.'
}

$resolvedMsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$configPath = Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$expectedProductName = [string]$config.productName
$expectedUpgradeCode = ([guid]$config.bundle.windows.wix.upgradeCode).ToString('B').ToUpperInvariant()
$installAttempted = $false
$uninstallCompleted = $false
$appProcess = $null
$installLocation = $null
$installLog = Join-Path $env:TEMP "pipline-msi-install-$PID.log"
$upgradeLog = Join-Path $env:TEMP "pipline-msi-upgrade-$PID.log"
$uninstallLog = Join-Path $env:TEMP "pipline-msi-uninstall-$PID.log"
$piAgentDirectory = Join-Path $env:TEMP "pipline-msi-pi-agent-$PID"
$piAgentTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$fullPiAgentDirectory = [System.IO.Path]::GetFullPath($piAgentDirectory)
$previousPiAgentDirectory = [Environment]::GetEnvironmentVariable('PI_CODING_AGENT_DIR', 'Process')
if (-not $fullPiAgentDirectory.StartsWith($piAgentTempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "MSI smoke Pi profile path is outside TEMP: $fullPiAgentDirectory"
}
if (Test-Path -LiteralPath $fullPiAgentDirectory) {
  throw "MSI smoke Pi profile already exists; refusing to reuse it: $fullPiAgentDirectory"
}

function Get-ProductRegistration {
  @(
    Get-ItemProperty `
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', `
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*', `
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' `
      -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq $expectedProductName }
  )
}

function Get-MsiPropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Database,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $view = $Database.OpenView("SELECT Value FROM Property WHERE Property='$Name'")
  $record = $null
  try {
    [void]$view.Execute()
    $record = $view.Fetch()
    if (-not $record) {
      throw "MSI is missing the $Name property."
    }
    return $record.StringData(1).Trim()
  }
  finally {
    [void]$view.Close()
    if ($record) {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record)
    }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($view)
  }
}

function Get-MsiIdentity {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $databaseInstaller = New-Object -ComObject WindowsInstaller.Installer
  $database = $null
  $upgradeView = $null
  try {
    $database = $databaseInstaller.OpenDatabase($resolvedPath, 0)
    $upgradeView = $database.OpenView('SELECT UpgradeCode FROM Upgrade')
    $upgradeCodes = @()
    [void]$upgradeView.Execute()
    while ($record = $upgradeView.Fetch()) {
      $upgradeCodes += $record.StringData(1).Trim().ToUpperInvariant()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record)
    }
    [pscustomobject]@{
      Path = $resolvedPath
      ProductName = Get-MsiPropertyValue -Database $database -Name 'ProductName'
      ProductVersion = Get-MsiPropertyValue -Database $database -Name 'ProductVersion'
      ProductCode = Get-MsiPropertyValue -Database $database -Name 'ProductCode'
      UpgradeCodes = $upgradeCodes
    }
  }
  finally {
    if ($upgradeView) {
      [void]$upgradeView.Close()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($upgradeView)
    }
    if ($database) {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($database)
    }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($databaseInstaller)
  }
}

function Invoke-Msi {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$Operation,
    [Parameter(Mandatory = $true)]
    [string]$LogPath
  )

  $process = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
    -ArgumentList ($Arguments + @('/l*v', "`"$LogPath`"")) -Wait -PassThru
  if ($process.ExitCode -notin @(0, 3010)) {
    throw "MSI $Operation failed with exit code $($process.ExitCode). See $LogPath."
  }
  $process.ExitCode
}

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

$currentMsi = Get-MsiIdentity -Path $MsiPath
if ($currentMsi.ProductName -ne $expectedProductName) {
  throw "Current MSI product '$($currentMsi.ProductName)' does not match '$expectedProductName'."
}
if ($currentMsi.UpgradeCodes.Count -ne 1 -or $currentMsi.UpgradeCodes[0] -ne $expectedUpgradeCode) {
  throw "Current MSI Upgrade table does not contain exactly $expectedUpgradeCode."
}
if ($currentMsi.ProductVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
  throw "Current MSI version is invalid: $($currentMsi.ProductVersion)"
}
$previousMsi = $null
if (-not [string]::IsNullOrWhiteSpace($PreviousMsiPath)) {
  $previousMsi = Get-MsiIdentity -Path $PreviousMsiPath
  if ($previousMsi.ProductName -ne $expectedProductName -or
    $previousMsi.UpgradeCodes.Count -ne 1 -or
    $previousMsi.UpgradeCodes[0] -ne $expectedUpgradeCode) {
    throw 'Prior MSI does not have the configured Pipline product and UpgradeCode.'
  }
  if ([version]$previousMsi.ProductVersion -ge [version]$currentMsi.ProductVersion) {
    throw "Prior MSI $($previousMsi.ProductVersion) must be older than current MSI $($currentMsi.ProductVersion)."
  }
  if ($previousMsi.ProductCode -eq $currentMsi.ProductCode) {
    throw 'Prior and current MSI must use different ProductCodes for a major upgrade.'
  }
}

$installLocations = @()
try {
  if ((Get-ProductRegistration).Count -ne 0) {
    throw "A '$expectedProductName' installation is already registered; refusing to replace it on the smoke runner."
  }

  if ($previousMsi) {
    $installAttempted = $true
    $priorInstallCode = Invoke-Msi `
      -Arguments @('/i', "`"$($previousMsi.Path)`"", '/qn', '/norestart') `
      -Operation 'prior-version install' `
      -LogPath $installLog
    $priorRegistration = @(Get-ProductRegistration | Where-Object { $_.DisplayVersion -eq $previousMsi.ProductVersion })
    if ($priorRegistration.Count -ne 1) {
      throw "Prior MSI install returned $priorInstallCode but did not register exactly one $($previousMsi.ProductVersion) installation. See $installLog."
    }
    $installLocations += ([string]$priorRegistration[0].InstallLocation).Trim('"')
    Write-Output "[msi-install-smoke] installed prior version $($previousMsi.ProductVersion) at $($installLocations[-1])"
  }

  $installAttempted = $true
  $currentInstallCode = Invoke-Msi `
    -Arguments @('/i', "`"$($currentMsi.Path)`"", '/qn', '/norestart') `
    -Operation $(if ($previousMsi) { 'upgrade' } else { 'install' }) `
    -LogPath $(if ($previousMsi) { $upgradeLog } else { $installLog })
  $currentRegistration = @(Get-ProductRegistration | Where-Object { $_.DisplayVersion -eq $currentMsi.ProductVersion })
  if ($currentRegistration.Count -ne 1) {
    throw "Current MSI returned $currentInstallCode but did not leave exactly one $($currentMsi.ProductVersion) registration. See $upgradeLog."
  }
  $registration = $currentRegistration[0]
  $installLocation = ([string]$registration.InstallLocation).Trim('"')
  if (-not $installLocation -or -not (Test-Path -LiteralPath $installLocation)) {
    throw 'Installed MSI registration has no valid InstallLocation.'
  }
  if ($installLocations.Count -gt 0 -and $installLocations[-1] -ne $installLocation) {
    throw "MSI major upgrade moved the application from $($installLocations[-1]) to $installLocation."
  }
  foreach ($relativePath in @('pipline.exe', 'pi\pi.exe', 'extensions\picot-bridge.mjs', 'public\locales\zh.json', 'licenses\Pi-Coding-Agent-0.85.1-MIT.txt')) {
    $installedPath = Join-Path $installLocation $relativePath
    if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
      throw "MSI installed payload is missing: $relativePath"
    }
  }
  Assert-PiplineLicensePayload -InstallDirectory $installLocation
  $publicDirectory = Join-Path $installLocation 'public'
  foreach ($relativePath in @(
    'index.html',
    'compat\bootstrap-entry.js',
    'vendor\workflow-code-compiler-worker.js',
    'vendor\esbuild.wasm'
  )) {
    $installedPath = Join-Path $publicDirectory $relativePath
    if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
      throw "MSI installed frontend payload is missing: $relativePath"
    }
  }
  $shippedTests = @(
    Get-ChildItem -LiteralPath $publicDirectory -Recurse -File |
      Where-Object { $_.Name -match '\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$' }
  )
  if ($shippedTests.Count -gt 0) {
    throw "MSI installation contains frontend test modules: $($shippedTests.FullName -join ', ')"
  }
  $appPath = Join-Path $installLocation 'pipline.exe'
  $expectedPiPath = Join-Path $installLocation 'pi\pi.exe'
  New-Item -ItemType Directory -Path $fullPiAgentDirectory | Out-Null
  [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $piAgentDirectory, 'Process')
  $appProcess = Start-Process -FilePath $appPath -WorkingDirectory $installLocation -WindowStyle Hidden -PassThru
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
  Write-Output "[msi-install-smoke] launched Pipline from $appPath with bundled Pi PID $($piRuntimeProcess.Id)"
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
  if ((Get-ProductRegistration).Count -ne 1) {
    throw 'MSI upgrade left multiple Pipline Add/Remove Programs registrations.'
  }
  if ($previousMsi) {
    Write-Output "[msi-install-smoke] upgraded $expectedProductName from $($previousMsi.ProductVersion) to $($registration.DisplayVersion) at $installLocation"
  } else {
    Write-Output "[msi-install-smoke] installed $expectedProductName $($registration.DisplayVersion) at $installLocation"
  }

  $uninstallCode = Invoke-Msi `
    -Arguments @('/x', $currentMsi.ProductCode, '/qn', '/norestart') `
    -Operation 'uninstall' `
    -LogPath $uninstallLog
  if ((Get-ProductRegistration).Count -ne 0) {
    throw "MSI uninstall returned $uninstallCode but the product remains registered. See $uninstallLog."
  }
  if (Test-Path -LiteralPath $installLocation) {
    throw "MSI uninstall left the install directory behind: $installLocation"
  }
  $uninstallCompleted = $true
  Write-Output "[msi-install-smoke] uninstalled $expectedProductName; registration and install directory are absent"
}
finally {
  try {
    Stop-SmokeApplication
    if ($installLocation) {
      $expectedPiPath = Join-Path $installLocation 'pi\pi.exe'
      Get-Process -Name 'pi' -ErrorAction SilentlyContinue |
        Where-Object { try { $_.Path -eq $expectedPiPath } catch { $false } } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if ($installAttempted -and -not $uninstallCompleted) {
      $cleanupCodes = @($currentMsi.ProductCode)
      if ($previousMsi) {
        $cleanupCodes += $previousMsi.ProductCode
      }
      foreach ($cleanupCode in $cleanupCodes) {
        $cleanup = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" `
          -ArgumentList @('/x', $cleanupCode, '/qn', '/norestart', '/l*v', "`"$uninstallLog`"") `
          -Wait -PassThru
        if ($cleanup.ExitCode -notin @(0, 3010, 1605)) {
          throw "MSI smoke cleanup failed with exit code $($cleanup.ExitCode). See $uninstallLog."
        }
      }
    }
  }
  finally {
    [Environment]::SetEnvironmentVariable('PI_CODING_AGENT_DIR', $previousPiAgentDirectory, 'Process')
    if (Test-Path -LiteralPath $fullPiAgentDirectory) {
      Remove-Item -LiteralPath $fullPiAgentDirectory -Recurse -Force
    }
  }
}
