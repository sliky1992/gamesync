@echo off
REM Double-click this to stop and remove the GameSync service.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-GameSync.ps1"
