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

echo "== dependencies"
npm install

echo "== native helpers (meeting detection and system audio)"
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

echo "== pure test suite"
npm test

echo "== building Yapper $VERSION (dmg + zip, arm64)"
npx electron-builder --mac

echo "== artefacts"
ls -lh dist/*.dmg dist/*-mac.zip 2>/dev/null || ls -lh dist/

DMG="dist/Yapper-$VERSION-arm64.dmg"
test -f "$DMG" || DMG="$(ls dist/*.dmg | head -1)"

echo "== uploading to release v$VERSION"
# latest-mac.yml goes up with the dmg, not as an afterthought: it is what an
# installed Mac reads to notice a new version. Without it the app falls back to
# latest.yml, which the Windows build owns — so a release cut only here would be
# invisible to every Mac already installed.
FEED="dist/latest-mac.yml"
# The zip goes up beside the dmg because it is what mac/install.sh installs:
# curl attaches no quarantine to what it downloads, so that route skips the
# Gatekeeper block the dmg does trigger. With no zip on the feed, the one-line
# installer has nothing to fetch.
ZIP="dist/Yapper-$VERSION-arm64-mac.zip"

# This script used to require that Windows had published the release first,
# which left the Mac unable to cut a version on its own. It creates one if it is
# missing now — and when it does, it carries the previous release's Windows
# assets forward.
NEW_RELEASE=0
if ! gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  echo "   v$VERSION did not exist; creating it"
  gh release create "v$VERSION" --repo "$REPO" \
    --title "Yapper $VERSION" \
    --notes "Yapper $VERSION.

macOS (Apple Silicon), without the Gatekeeper detour:

    curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash

Or download the dmg and follow docs/INSTALL-MACOS.md. Installed copies read this
same feed to tell you about new versions."
  NEW_RELEASE=1
fi

gh release upload "v$VERSION" "$DMG" --repo "$REPO" --clobber
test -f "$ZIP"  && gh release upload "v$VERSION" "$ZIP"  --repo "$REPO" --clobber
test -f "$FEED" && gh release upload "v$VERSION" "$FEED" --repo "$REPO" --clobber
# the installer is cut with the build it installs, rather than living on a branch
gh release upload "v$VERSION" mac/install.sh --repo "$REPO" --clobber

if [ "$NEW_RELEASE" = "1" ]; then
  # electron-updater ALWAYS looks for latest.yml on the most recent release. A
  # mac-only cut would leave it without one and Windows copies would stop seeing
  # updates — failing quietly, which is the worst way to fail. The previous
  # release's Windows assets travel forward untouched: their latest.yml still
  # declares the version those copies already have, so nobody is offered an
  # update that does not exist.
  PREV="$(gh release list --repo "$REPO" --limit 30 --json tagName --jq '.[].tagName' \
    | grep -vx "v$VERSION" | grep -v '^engine-' | head -1)"
  if [ -n "$PREV" ]; then
    CARRY="$(mktemp -d)"
    if gh release download "$PREV" --repo "$REPO" --dir "$CARRY" \
         --pattern 'latest.yml' --pattern 'Yapper-Setup-*' 2>/dev/null; then
      for f in "$CARRY"/*; do
        gh release upload "v$VERSION" "$f" --repo "$REPO" --clobber
      done
      echo "   Windows assets inherited from $PREV: $(ls "$CARRY" | tr '\n' ' ')"
    else
      echo "   WARNING: $PREV carried no Windows assets — Windows copies"
      echo "          will stop seeing this feed until a release is cut from there"
    fi
    rm -rf "$CARRY"
  fi
fi

echo ""
echo "done: https://github.com/$REPO/releases/tag/v$VERSION"
echo "local test: open \"$DMG\""
echo "clean install: curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash"
