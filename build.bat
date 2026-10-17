@echo off
setlocal
cd /d "%~dp0"
title Waifu Pet - build single-file executable

echo ============================================================
echo  Building WaifuPet.exe  (one portable file, no installer)
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install the LTS version from https://nodejs.org and run this again.
  goto :fail
)

echo [1/3] Installing dependencies (first run downloads Electron, ~100 MB)...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/3] Running tests...
call npm test
if errorlevel 1 (
  echo [ERROR] Tests failed - not building.
  goto :fail
)

echo.
echo [3/3] Packaging...
call npm run dist
if errorlevel 1 (
  echo.
  echo Packaging failed. This is often the Windows symbolic-link permission problem
  echo ^(turn on Developer Mode, or run this file as Administrator^).
  echo Retrying without editing the .exe icon and version info...
  echo.
  call npx electron-builder --win portable --x64 -c.win.signAndEditExecutable=false
  if errorlevel 1 goto :fail
  set ICONNOTE=1
)

echo.
echo ============================================================
echo  Done:  %~dp0dist\WaifuPet.exe
echo ============================================================
echo.
echo  * Double-click WaifuPet.exe to run. It is one file; you can move it anywhere.
echo  * To add models: put a model folder into a "models" folder next to the .exe
echo    (or use the tray menu: Open Models Folder).
echo  * Settings are kept in %%APPDATA%%\waifu-pet and are shared with "npm start".
if defined ICONNOTE echo  * Note: this build uses the default Electron file icon (see the message above).
echo.
pause
exit /b 0

:fail
echo.
echo Build failed - see the messages above.
pause
exit /b 1
