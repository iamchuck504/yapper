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

# Este script solía exigir que Windows hubiera publicado el release primero, lo
# que dejaba a la Mac sin poder cortar una versión por su cuenta. Ahora lo crea
# si falta — y si lo crea, arrastra los assets de Windows del release anterior.
NEW_RELEASE=0
if ! gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  echo "   no existía v$VERSION; creándolo"
  gh release create "v$VERSION" --repo "$REPO" \
    --title "Yapper $VERSION" \
    --notes "Yapper $VERSION.

macOS (Apple Silicon), sin el rodeo de Gatekeeper:

    curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash

O baja el dmg y sigue docs/INSTALL-MACOS.md. Las copias instaladas leen este
mismo feed para avisar de versiones nuevas."
  NEW_RELEASE=1
fi

gh release upload "v$VERSION" "$DMG" --repo "$REPO" --clobber
test -f "$ZIP"  && gh release upload "v$VERSION" "$ZIP"  --repo "$REPO" --clobber
test -f "$FEED" && gh release upload "v$VERSION" "$FEED" --repo "$REPO" --clobber
# el instalador se corta con el build que instala, en vez de vivir en una rama
gh release upload "v$VERSION" mac/install.sh --repo "$REPO" --clobber

if [ "$NEW_RELEASE" = "1" ]; then
  # electron-updater busca latest.yml SIEMPRE en el release más reciente. Un
  # corte sólo-mac lo dejaría sin él y las copias de Windows dejarían de ver
  # actualizaciones — fallando calladas, que es la peor forma de fallar. Los
  # assets de Windows del release anterior viajan hacia adelante tal cual: su
  # latest.yml sigue declarando la versión que ya tienen instalada, así que
  # nadie recibe un aviso de actualización que no existe.
  PREV="$(gh release list --repo "$REPO" --limit 30 --json tagName --jq '.[].tagName' \
    | grep -vx "v$VERSION" | grep -v '^engine-' | head -1)"
  if [ -n "$PREV" ]; then
    CARRY="$(mktemp -d)"
    if gh release download "$PREV" --repo "$REPO" --dir "$CARRY" \
         --pattern 'latest.yml' --pattern 'Yapper-Setup-*' 2>/dev/null; then
      for f in "$CARRY"/*; do
        gh release upload "v$VERSION" "$f" --repo "$REPO" --clobber
      done
      echo "   assets de Windows heredados de $PREV: $(ls "$CARRY" | tr '\n' ' ')"
    else
      echo "   AVISO: $PREV no traía assets de Windows — las copias de Windows"
      echo "          dejarán de ver este feed hasta que se publique desde allá"
    fi
    rm -rf "$CARRY"
  fi
fi

echo ""
echo "listo: https://github.com/$REPO/releases/tag/v$VERSION"
echo "prueba local: open \"$DMG\""
echo "instalación limpia: curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash"
