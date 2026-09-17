@echo off
rem Starts the Scrappia desktop app. Double-click this file.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Scrappia is not installed yet. Running setup once, this takes a few minutes...
  call npm install --no-audit --no-fund
  call npx patchright install chromium
  call npm run build
)
if not exist "apps\desktop\out\main\index.js" call npm run build
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0apps\desktop"
