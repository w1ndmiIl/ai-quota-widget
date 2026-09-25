param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath((Join-Path $projectRoot '.cache\installer-test'))
if (-not $target.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer test path is outside the project' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
New-Item -ItemType Directory -Force -Path $target | Out-Null
function Install-TestPackage {
    $process = Start-Process -FilePath $installerPath -ArgumentList "/S /D=$target" -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { $process.Kill(); throw 'Installer timed out' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
}
Install-TestPackage
$data = Join-Path $target '.userdata'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$config = @{ enableCodex=$false; enableClaudeCode=$false; enableOpenCode=$false; enableGeminiCli=$false; enableCline=$false; enableAntigravity=$false; pinned=$false; marker='upgrade-preserved'; hotkeys=@{togglePanel='';toggleCompact='';refresh='';togglePin=''} }
[IO.File]::WriteAllText((Join-Path $data 'config.json'), ($config | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Install-TestPackage
$saved = Get-Content -LiteralPath (Join-Path $data 'config.json') -Raw | ConvertFrom-Json
if ($saved.marker -ne 'upgrade-preserved' -or $saved.pinned -ne $false) { throw 'Upgrade lost configuration' }
$appExe = Join-Path $target 'AI_bar.exe'
$process = Start-Process -FilePath $appExe -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Installed app startup timed out' }
$result = Get-Content -LiteralPath (Join-Path $data 'smoke-result.json') -Raw | ConvertFrom-Json
if (-not $result.ok) { throw "Installed app failed: $($result.error)" }
Write-Output ('Installed startup and configuration preservation passed: ' + ($result | ConvertTo-Json -Compress))
