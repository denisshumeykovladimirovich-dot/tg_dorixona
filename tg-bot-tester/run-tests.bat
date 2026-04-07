@echo off
cd /d "%~dp0"

set "NODE_EXE=node"
set "NPM_CMD=npm"
if exist "%LOCALAPPDATA%\nodejs-portable\node-v22.14.0-win-x64\node.exe" (
  set "NODE_EXE=%LOCALAPPDATA%\nodejs-portable\node-v22.14.0-win-x64\node.exe"
)
if exist "%LOCALAPPDATA%\nodejs-portable\node-v22.14.0-win-x64\npm.cmd" (
  set "NPM_CMD=%LOCALAPPDATA%\nodejs-portable\node-v22.14.0-win-x64\npm.cmd"
)
if not defined COMET_BROWSER_PATH (
  set "COMET_BROWSER_PATH=%LOCALAPPDATA%\Perplexity\Comet\Application\comet.exe"
)

if not exist "node_modules\playwright" (
  call "%NPM_CMD%" install
  if errorlevel 1 exit /b 1
)

"%NODE_EXE%" tests\runner.js
if errorlevel 1 exit /b 1
"%NODE_EXE%" tests\analyzer.js
if errorlevel 1 exit /b 1

echo Gotovo
