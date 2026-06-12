@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_public_site.ps1" -Refresh
pause
