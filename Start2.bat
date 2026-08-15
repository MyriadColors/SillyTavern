@echo off
pushd %~dp0
set NODE_ENV=production

rem Check if install is needed
set NEED_INSTALL=0
if not exist node_modules set NEED_INSTALL=1
if not exist .deps.hash set NEED_INSTALL=1

if %NEED_INSTALL%==0 (
    certutil -hashfile package.json SHA256 > .deps.tmp 2>nul
    echo --- >> .deps.tmp 2>nul
    certutil -hashfile bun.lock SHA256 >> .deps.tmp 2>nul
    fc .deps.hash .deps.tmp >nul 2>&1
    if errorlevel 1 set NEED_INSTALL=1
    del .deps.tmp 2>nul
)

if %NEED_INSTALL%==1 (
    call bun install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
    certutil -hashfile package.json SHA256 > .deps.hash 2>nul
    echo --- >> .deps.hash 2>nul
    certutil -hashfile bun.lock SHA256 >> .deps.hash 2>nul
)

node server.js %*
pause
popd
