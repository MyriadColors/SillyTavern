@echo off
pushd %~dp0
set NODE_ENV=production

rem Check if install is needed
set NEED_INSTALL=0
if not exist node_modules set NEED_INSTALL=1
if not exist .deps.hash set NEED_INSTALL=1

if %NEED_INSTALL%==0 (
    bun -e "const fs=require('fs');const crypto=require('crypto');try{const hash1=crypto.createHash('sha256').update(fs.readFileSync('package.json')).digest('hex');const hash2=crypto.createHash('sha256').update(fs.readFileSync('bun.lock')).digest('hex');const combined=hash1+'\n---\n'+hash2;const current=fs.readFileSync('.deps.hash','utf8').trim();if(combined!==current)process.exit(1);}catch(e){process.exit(1);}"
    if errorlevel 1 set NEED_INSTALL=1
)

if %NEED_INSTALL%==1 (
    call bun install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
    bun -e "const fs=require('fs');const crypto=require('crypto');const hash1=crypto.createHash('sha256').update(fs.readFileSync('package.json')).digest('hex');const hash2=crypto.createHash('sha256').update(fs.readFileSync('bun.lock')).digest('hex');fs.writeFileSync('.deps.hash',hash1+'\n---\n'+hash2);"
)

bun server.js %*
pause
popd
