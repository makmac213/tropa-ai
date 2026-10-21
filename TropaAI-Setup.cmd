@echo off
rem TropaAI setup for Windows: double-click this file.
rem It downloads and runs install.ps1 from GitHub (the same as pasting the PowerShell command in the README).
title TropaAI Setup
echo.
echo   TropaAI Setup
echo   This window shows each step. Keep it open until it says Done.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { irm https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.ps1 | iex } catch { Write-Host $_ -ForegroundColor Red }"
echo.
echo   You can close this window now.
pause >nul
