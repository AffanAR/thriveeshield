# Opens Microsoft Edge with a separate, empty profile and the ThriveeShield extension loaded.
# Your normal Edge profile is not touched. Windows only.
#   .\scripts\open-test-browser.ps1                 opens the given pages (default: Meteor's site)
#   .\scripts\open-test-browser.ps1 -DebugPort 9333 also opens a local debug port (testing only;
#                                                   never use it on a profile that holds a real wallet)
param(
  [string[]]$Url = @('https://meteorwallet.app/'),
  [int]$DebugPort = 0
)

$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) { Write-Error 'Microsoft Edge was not found.'; exit 1 }

$extension = Join-Path (Split-Path $PSScriptRoot -Parent) 'extension'
$profileDir = Join-Path $env:LOCALAPPDATA 'ThriveeShield\edge-profile'
New-Item -ItemType Directory -Force $profileDir | Out-Null

$edgeArgs = @(
  "--user-data-dir=`"$profileDir`"",
  "--load-extension=`"$extension`"",
  '--no-first-run',
  '--no-default-browser-check'
)
if ($DebugPort -gt 0) { $edgeArgs += "--remote-debugging-port=$DebugPort" }
$edgeArgs += $Url

Start-Process -FilePath $edge -ArgumentList $edgeArgs
Write-Host "Edge started with profile $profileDir"
Write-Host "Extension folder: $extension"
