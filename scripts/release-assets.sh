#!/bin/bash
# Builds the files install.sh downloads from the latest GitHub release, with stable names:
#   release-assets/network-builder.tgz            the CLI (npm pack: prebuilt dist/, extension/, skills/)
#   release-assets/Network-Builder-mac-arm64.zip  the desktop app
#   release-assets/install.sh                     a copy of the installer
# Then: gh release create vX.Y.Z release-assets/* --title "network-builder X.Y.Z" --notes-file <notes>
set -euo pipefail
cd "$(dirname "$0")/.."
out="$PWD/release-assets"
rm -rf "$out" && mkdir -p "$out"

pnpm typecheck && pnpm test && pnpm build
tgz="$(npm pack --silent --pack-destination "$out" | tail -1)"
mv "$out/$tgz" "$out/network-builder.tgz"

(cd desktop && pnpm install --frozen-lockfile && pnpm build)
app="$(ls -d desktop/release/mac-arm64/"Network Builder.app")"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/Network-Builder-mac-arm64.zip"

cp install.sh "$out/install.sh"
ls -lh "$out"
