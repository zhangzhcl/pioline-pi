function Assert-PiplineLicensePayload {
  param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDirectory
  )

  $sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\licenses')).Path
  $installedRoot = Join-Path $InstallDirectory 'licenses'
  if (-not (Test-Path -LiteralPath $installedRoot -PathType Container)) {
    throw "Installed application is missing its licenses directory: $installedRoot"
  }

  $sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse)
  if ($sourceFiles.Count -eq 0) {
    throw "No staged license files were found under $sourceRoot."
  }

  foreach ($sourceFile in $sourceFiles) {
    $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length + 1)
    $installedPath = Join-Path $installedRoot $relativePath
    if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) {
      throw "Installed application is missing license payload: $relativePath"
    }

    $installedFile = Get-Item -LiteralPath $installedPath
    if ($installedFile.Length -ne $sourceFile.Length) {
      throw "Installed license payload has a different size: $relativePath"
    }

    $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash
    if ($installedHash -ne $sourceHash) {
      throw "Installed license payload differs from its staged source: $relativePath"
    }
  }

  Write-Output "[installer-license-smoke] verified $($sourceFiles.Count) installed license files against staged SHA-256 hashes"
}
