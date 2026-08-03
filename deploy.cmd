@echo off
setlocal
cd /d "%~dp0"

set "PORT=8000"

echo ============================================
echo   Material Management - LAN Deploy
echo ============================================
echo.

REM --- Open the Windows Firewall for the app port (needs admin; runs once) ---
netsh advfirewall firewall show rule name="Material Management %PORT%" >nul 2>&1
if errorlevel 1 (
  echo Adding firewall rule for TCP %PORT% ...
  netsh advfirewall firewall add rule name="Material Management %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
  if errorlevel 1 (
    echo   [!] Could not add firewall rule. Re-run this file as Administrator
    echo       if other machines cannot connect.
  ) else (
    echo   Firewall rule added.
  )
) else (
  echo Firewall rule already present.
)
echo.

REM --- Show this machine's LAN addresses ---
echo Other machines on the network can reach the app at:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  for /f "tokens=* delims= " %%b in ("%%a") do echo   http://%%b:%PORT%
)
echo.

echo Starting server (Ctrl+C to stop)...
echo.
node server.js

endlocal
