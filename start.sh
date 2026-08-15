#!/usr/bin/env bash

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

if ! command -v bun &> /dev/null
then
    echo -e "\033[0;31mbun could not be found in PATH. Please install bun from https://bun.sh/\033[0m"
fi

export NODE_ENV=production

# Check if install is needed
NEED_INSTALL=0
if [ ! -d node_modules ]; then NEED_INSTALL=1; fi
if [ ! -f .deps.hash ]; then NEED_INSTALL=1; fi

if [ "$NEED_INSTALL" = "0" ]; then
    sha256sum package.json bun.lock > .deps.tmp 2>/dev/null
    cmp -s .deps.hash .deps.tmp || NEED_INSTALL=1
    rm -f .deps.tmp
fi

if [ "$NEED_INSTALL" = "1" ]; then
    bun install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
    sha256sum package.json bun.lock > .deps.hash 2>/dev/null
fi

echo "Entering SillyTavern..."
node "server.js" "$@"
