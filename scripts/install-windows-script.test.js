import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Pipline Windows install script", () => {
  it.skipIf(process.platform !== "win32")(
    "downloads matching Pipline MSI and NSIS release assets",
    () => {
      const powershell = `
$ErrorActionPreference = 'Stop'
$global:downloads = @()
$global:installs = @()
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  $global:downloads += $Uri
  [System.IO.File]::WriteAllText($OutFile, 'installer-fixture')
}
function Start-Process {
  param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
  $global:installs += [pscustomobject]@{ filePath = $FilePath; argumentList = $ArgumentList }
  return [pscustomobject]@{ ExitCode = 0 }
}
& $env:PIPLINE_INSTALL_SCRIPT -Version 'v0.1.0' -Repository 'owner/Pipline'
& $env:PIPLINE_INSTALL_SCRIPT -Version 'v0.1.0' -Repository 'owner/Pipline' -MSI
Write-Output ('CONTRACT:' + (ConvertTo-Json -InputObject @{ downloads = $global:downloads; installs = $global:installs } -Compress -Depth 5))
`;
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", powershell],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PROCESSOR_ARCHITECTURE: "AMD64",
            PIPLINE_INSTALL_SCRIPT: join(process.cwd(), "scripts", "install.ps1"),
          },
        },
      );
      const contractLine = output.split(/\r?\n/).find((line) => line.startsWith("CONTRACT:"));
      expect(contractLine).toBeDefined();
      const contract = JSON.parse(contractLine.slice("CONTRACT:".length));
      expect(contract.downloads).toEqual([
        "https://github.com/owner/Pipline/releases/download/v0.1.0/Pipline_0.1.0_x64-setup.exe",
        "https://github.com/owner/Pipline/releases/download/v0.1.0/Pipline_0.1.0_x64_en-US.msi",
      ]);
      expect(contract.installs).toEqual([
        expect.objectContaining({
          filePath: expect.stringMatching(/Pipline_0\.1\.0_x64-setup\.exe$/),
          argumentList: ["/S"],
        }),
        expect.objectContaining({
          filePath: "msiexec.exe",
          argumentList: [
            "/i",
            expect.stringMatching(/Pipline_0\.1\.0_x64_en-US\.msi$/),
            "/quiet",
            "/norestart",
          ],
        }),
      ]);
    },
  );
});
