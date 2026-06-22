@echo off
REM Double-click this to install GameSync as a Windows service.
REM It launches the PowerShell installer, which will prompt for the Hub URL
REM and device name, then elevate to Administrator automatically.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-GameSync.ps1"
