#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node; do
    if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
      export PATH="$(dirname "$candidate"):$PATH"
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node 24 or newer is needed. See README.md.'
  read -r -p 'Press Return to close.'
  exit 1
fi
if [ ! -d node_modules ] || [ ! -f dist/index.html ]; then
  echo 'Run npm ci --ignore-scripts and npm run build once from this folder. See README.md.'
  read -r -p 'Press Return to close.'
  exit 1
fi
exec node scripts/launch.mjs
