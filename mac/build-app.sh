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

echo "== ayudantes nativos (detección de reuniones y audio del sistema)"
# Both are required before packaging: electron-builder copies them into the app,
# and main.js degrades quietly if either is missing — auto-detection stays off,
# and recording falls back to the microphone alone. swiftc ships with the
# Command Line Tools, so neither needs Xcode.
# -target matters more than it looks: swiftc defaults to the SDK's own version,
# so building on a machine running a beta produces binaries that refuse to launch
# anywhere else. Each helper is pinned to the oldest macOS its APIs exist in —
# ScreenCaptureKit audio capture landed in 13.0, and the CoreAudio process list
# the mic probe reads in 14.4.
swiftc -O -target arm64-apple-macos14.4 mac/mic-probe.swift -o build/mic-probe
swiftc -O -target arm64-apple-macos13.0 mac/system-audio.swift -o build/system-audio
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
# latest-mac.yml goes up with the dmg, not as an afterthought: it is what an
# installed Mac reads to notice a new version. Without it the app falls back to
# latest.yml, which the Windows build owns — so a release cut only here would be
# invisible to every Mac already installed.
FEED="dist/latest-mac.yml"
# El zip sube junto al dmg porque es lo que instala mac/install.sh: curl no le
# pone cuarentena a lo que baja, así que esa vía se salta el bloqueo de
# Gatekeeper que el dmg sí provoca. Sin el zip en el feed, el instalador de una
# línea no tiene qué bajar.
ZIP="dist/Yapper-$VERSION-arm64-mac.zip"
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$DMG" --repo "$REPO" --clobber
  test -f "$ZIP"  && gh release upload "v$VERSION" "$ZIP"  --repo "$REPO" --clobber
  test -f "$FEED" && gh release upload "v$VERSION" "$FEED" --repo "$REPO" --clobber
  # el instalador se corta con el build que instala, en vez de vivir en una rama
  gh release upload "v$VERSION" mac/install.sh --repo "$REPO" --clobber
else
  echo "no existe el release v$VERSION en $REPO — publica primero desde Windows (npm run release)"
  exit 1
fi

echo ""
echo "listo: https://github.com/$REPO/releases/tag/v$VERSION"
echo "prueba local: open \"$DMG\""
echo "instalación limpia: curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash"
