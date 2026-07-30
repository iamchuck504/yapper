#!/bin/bash
# Builds the macOS app (dmg + zip, arm64) and uploads it to the current
# version's release. Run on a Mac, from the repo root:
#
#   bash mac/build-app.sh
#
# Needs: Node 20+, and the gh CLI signed in as iamchuck504. The engine must
# already be on the feed (mac/build-engine.sh, once per engine version).
#
# The build is NOT signed or notarized (no Apple Developer account), so
# Gatekeeper will block the first open: right-click the app -> Open -> Open.
# That is stated in the docs; signing is the known gap.
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
REPO="iamchuck504/yapper-releases"

echo "== dependencias"
npm install

echo "== sonda de micrófono (autodetección de reuniones)"
# Native, tiny, and required before packaging: electron-builder copies
# build/mic-probe into the app, and main.js leaves auto-detection off if it is
# not there. swiftc ships with the Command Line Tools, so this needs no Xcode.
swiftc -O mac/mic-probe.swift -o build/mic-probe
./build/mic-probe >/dev/null || true   # exits 0 with no output when nobody is capturing

echo "== suite de pruebas puras"
npm test

echo "== construyendo Yapper $VERSION (dmg + zip, arm64)"
npx electron-builder --mac

echo "== artefactos"
ls -lh dist/*.dmg dist/*-mac.zip 2>/dev/null || ls -lh dist/

DMG="dist/Yapper-$VERSION-arm64.dmg"
test -f "$DMG" || DMG="$(ls dist/*.dmg | head -1)"

echo "== subiendo al release v$VERSION"
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$DMG" --repo "$REPO" --clobber
else
  echo "no existe el release v$VERSION en $REPO — publica primero desde Windows (npm run release)"
  exit 1
fi

echo ""
echo "listo: https://github.com/$REPO/releases/tag/v$VERSION"
echo "prueba local: open \"$DMG\""
