param(
  [Parameter(Mandatory = $true)]
  [string]$MsiPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedMsiPath = (Resolve-Path -LiteralPath $MsiPath).Path
$configPath = Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$expectedUpgradeCode = ([guid]$config.bundle.windows.wix.upgradeCode).ToString('B').ToUpperInvariant()
$expectedProductName = [string]$config.productName

$installer = $null
$database = $null
try {
  $installer = New-Object -ComObject WindowsInstaller.Installer
  $database = $installer.OpenDatabase($resolvedMsiPath, 0)

  function Get-MsiProperty {
    param(
      [Parameter(Mandatory = $true)]
      [object]$Database,
      [Parameter(Mandatory = $true)]
      [string]$PropertyName
    )

    $view = $Database.OpenView("SELECT Value FROM Property WHERE Property='$PropertyName'")
    $record = $null
    try {
      [void]$view.Execute()
      $record = $view.Fetch()
      if (-not $record) {
        throw "MSI is missing the $PropertyName property."
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

  $productName = Get-MsiProperty -Database $database -PropertyName 'ProductName'
  $productVersion = Get-MsiProperty -Database $database -PropertyName 'ProductVersion'
  $productCode = Get-MsiProperty -Database $database -PropertyName 'ProductCode'
  $allUsers = Get-MsiProperty -Database $database -PropertyName 'ALLUSERS'
  if ($productName -ne $expectedProductName) {
    throw "MSI product name '$productName' does not match configured product '$expectedProductName'."
  }
  if ($allUsers -ne '1') {
    throw "MSI must be per-machine with ALLUSERS=1; found '$allUsers'."
  }
  if ($productVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "MSI product version '$productVersion' is not a valid Windows Installer version."
  }
  $parsedProductCode = [guid]::Empty
  if (-not [guid]::TryParse($productCode.Trim('{}'), [ref]$parsedProductCode)) {
    throw "MSI ProductCode '$productCode' is not a valid GUID."
  }

  $upgradeView = $database.OpenView('SELECT UpgradeCode FROM Upgrade')
  $upgradeCodes = @()
  try {
    [void]$upgradeView.Execute()
    while ($record = $upgradeView.Fetch()) {
      $upgradeCodes += $record.StringData(1).Trim().ToUpperInvariant()
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record)
    }
  }
  finally {
    [void]$upgradeView.Close()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($upgradeView)
  }

  if ($upgradeCodes.Count -ne 1 -or $upgradeCodes[0] -ne $expectedUpgradeCode) {
    throw "MSI Upgrade table must contain exactly the configured UpgradeCode $expectedUpgradeCode; found: $($upgradeCodes -join ', ')."
  }

  Write-Output "[msi-upgrade-code] $([IO.Path]::GetFileName($resolvedMsiPath)): $productName $productVersion, ProductCode $productCode, UpgradeCode $($upgradeCodes[0]), ALLUSERS=$allUsers"
}
finally {
  if ($database) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($database)
  }
  if ($installer) {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer)
  }
}
