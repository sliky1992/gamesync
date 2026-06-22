<#
.SYNOPSIS
  Stops and removes the GameSync Windows service. Double-click
  Uninstall-GameSync.cmd, or run this directly. Leaves installed files in place.
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "GameSync",
  [string]$InstallDir = "C:\Program Files\GameSync"
)
$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
  )
  return
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Stopping and removing service '$ServiceName' ..."
  Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Write-Host "Removed."
} else {
  Write-Host "Service '$ServiceName' is not installed."
}
Write-Host "(Files in $InstallDir were left in place; delete them manually if you want.)"
Read-Host "Press Enter to close"
