#!/bin/bash
# Renders docs/hero/hero.html → docs/hero.png (2560×1360) with headless Chrome. Fictional data only.
set -euo pipefail
cd "$(dirname "$0")/.."
profile="$(mktemp -d)"; trap 'rm -rf "$profile"' EXIT
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --user-data-dir="$profile" --allow-file-access-from-files --force-device-scale-factor=2 --window-size=1280,680 \
  --screenshot="$PWD/docs/hero.png" "file://$PWD/docs/hero/hero.html" >/dev/null 2>&1
ls -lh docs/hero.png
