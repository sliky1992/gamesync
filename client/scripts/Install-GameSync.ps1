<#
.SYNOPSIS
  Installs the GameSync client as a Windows service. Double-click
  Install-GameSync.cmd, or run this script directly.

  It will:
    1. Ask for the Hub URL and a device name (with sensible defaults).
    2. Elevate to Administrator.
    3. Copy the client to a stable folder (default C:\Program Files\GameSync).
    4. Write your settings into appsettings.json.
    5. Create (or repair) and start the "GameSync" service, set to auto-start.

  Safe to re-run: it updates the existing service instead of failing.
#>
[CmdletBinding()]
param(
  [string]$HubUrl,
  [string]$DeviceName,
  [string]$InstallDir = "C:\Program Files\GameSync",
  [string]$ServiceName = "GameSync"
)

$ErrorActionPreference = "Stop"
$exeName = "GameSync.Client.exe"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- Phase 1: gather input (as the normal user), then relaunch elevated -----
if (-not (Test-Admin)) {
  $srcCfg = Join-Path $PSScriptRoot "appsettings.json"
  $existingHub = "http://YOUR-HUB-IP:8080"
  if (Test-Path $srcCfg) {
    try { $existingHub = (Get-Content $srcCfg -Raw | ConvertFrom-Json).GameSync.HubUrl } catch {}
  }

  if (-not $HubUrl) {
    $ans = Read-Host "Hub URL [$existingHub]"
    $HubUrl = if ([string]::IsNullOrWhiteSpace($ans)) { $existingHub } else { $ans.Trim() }
  }
  if (-not $DeviceName) {
    $ans = Read-Host "Device name [$env:COMPUTERNAME]"
    $DeviceName = if ([string]::IsNullOrWhiteSpace($ans)) { $env:COMPUTERNAME } else { $ans.Trim() }
  }

  Write-Host "`nElevating to Administrator to install the service..." -ForegroundColor Cyan
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
    "-HubUrl", "`"$HubUrl`"", "-DeviceName", "`"$DeviceName`"", "-InstallDir", "`"$InstallDir`""
  )
  return
}

# --- Phase 2: elevated work -------------------------------------------------
Write-Host "GameSync installer (Administrator)" -ForegroundColor Green
$srcExe = Join-Path $PSScriptRoot $exeName
if (-not (Test-Path $srcExe)) {
  throw "Could not find $exeName next to this script ($PSScriptRoot). Unzip the whole package and run the installer from inside it."
}

# Copy the client into the install folder.
Write-Host "Copying client to $InstallDir ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $InstallDir -Recurse -Force
$destExe = Join-Path $InstallDir $exeName

# Write settings into appsettings.json.
$cfgPath = Join-Path $InstallDir "appsettings.json"
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if ($HubUrl)     { $cfg.GameSync.HubUrl = $HubUrl }
  if ($DeviceName) { $cfg.GameSync.DeviceName = $DeviceName }
  ($cfg | ConvertTo-Json -Depth 10) | Set-Content -Path $cfgPath -Encoding UTF8
  Write-Host "Configured HubUrl=$($cfg.GameSync.HubUrl)  DeviceName=$($cfg.GameSync.DeviceName)"
}

# Create or repair the service (delete + recreate keeps binPath correct).
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Service exists - stopping and recreating to fix its path..."
  Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

Write-Host "Creating service '$ServiceName' ..."
New-Service -Name $ServiceName -BinaryPathName "`"$destExe`"" -StartupType Automatic `
  -DisplayName "GameSync Save Sync" `
  -Description "Watches game-save folders and syncs them with the GameSync hub." | Out-Null

Write-Host "Starting service ..."
Start-Service $ServiceName
Start-Sleep -Seconds 2
$svc = Get-Service $ServiceName

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " GameSync service status: $($svc.Status)"
Write-Host " Installed at: $destExe"
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Open your hub dashboard -> Devices tab; '$DeviceName' should appear online."
Write-Host "Tip: this runs as LocalSystem, so use the dashboard's BROWSE button to pick"
Write-Host "save folders (absolute paths), rather than typing %APPDATA% / %USERPROFILE%."
Write-Host ""
Read-Host "Done. Press Enter to close"
