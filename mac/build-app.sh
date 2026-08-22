#!/bin/bash
# Builds the macOS app (dmg + zip, arm64) and uploads it to the current
# version's release. Run on a Mac, from the repo root:
#
#   bash mac/build-app.sh
#
# Needs: Node 20+, and the gh CLI signed in as iamchuck504. The engine must
# already be on the feed (mac/build-engine.sh, once per engine version).
#
# Requires a Developer ID Application identity in the macOS keychain and a
# validated notarytool profile. Credentials stay in the keychain; this script
# never reads or prints them.
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
REPO="iamchuck504/yapper-releases"
APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-yapper-notary}"
CSC_NAME="${CSC_NAME:-6DA3D507B0277225D26570969C3E05D454228496}"
CSC_KEYCHAIN="${CSC_KEYCHAIN:-${HOME}/Library/Application Support/Yapper Signing/yapper-signing.keychain-db}"
export APPLE_KEYCHAIN_PROFILE
export CSC_NAME
export CSC_KEYCHAIN

if [ ! -f "$CSC_KEYCHAIN" ]; then
  echo "missing signing keychain: $CSC_KEYCHAIN" >&2
  exit 1
fi

if ! security find-identity -v -p codesigning "$CSC_KEYCHAIN" \
     | grep -q "$CSC_NAME.*Developer ID Application: Carlos Lopez (54H77VDNJY)"; then
  echo "missing expected Developer ID Application identity $CSC_NAME in $CSC_KEYCHAIN" >&2
  exit 1
fi

if ! xcrun notarytool history --keychain-profile "$APPLE_KEYCHAIN_PROFILE" \
     --output-format json >/dev/null; then
  echo "notarytool profile '$APPLE_KEYCHAIN_PROFILE' is missing or invalid" >&2
  exit 1
fi

echo "== dependencies"
npm_config_cache="${TMPDIR:-/tmp}/yapper-npm-cache" npm ci

echo "== native helpers (meeting detection, system audio and speaker detection)"
# All are required before packaging: electron-builder copies them into the app,
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
swift build -c release --package-path mac/speaker-diarize --product speaker-diarize
DIARIZER_BIN="$(swift build -c release --package-path mac/speaker-diarize --show-bin-path)/speaker-diarize"
test -x "$DIARIZER_BIN" || { echo "missing speaker diarizer: $DIARIZER_BIN" >&2; exit 1; }
cp "$DIARIZER_BIN" build/speaker-diarize
./build/mic-probe >/dev/null || true   # exits 0 with no output when nobody is capturing
./build/speaker-diarize --self-test >/dev/null

echo "== pure test suite"
npm test

echo "== real renderer smoke test"
npx electron build/test-smoke.js
npx electron build/test-record-cycle.js
npx electron build/test-two-track-app.js
npx electron build/test-speakers-ui.js
npx electron build/test-import.js

echo "== building Yapper $VERSION (dmg + zip, arm64)"
npx electron-builder --mac

echo "== the packaged app actually starts"
# Every test above runs the source through the electron binary. The packaged
# app — fuses flipped, asar sealed, hardened runtime, our entitlements — had
# never been launched by anything before 0.1.9 shipped and died on open.
bash build/packaged-launch-check.sh "dist/mac-arm64/Yapper.app"

echo "== artefacts"
ls -lh dist/*.dmg dist/*-mac.zip 2>/dev/null || ls -lh dist/

DMG="dist/Yapper-$VERSION-arm64.dmg"
test -f "$DMG" || DMG="$(ls dist/*.dmg | head -1)"
APP="dist/mac-arm64/Yapper.app"
test -d "$APP" || { echo "missing unpacked app: $APP" >&2; exit 1; }

# electron-builder notarizes and staples the .app before creating the zip and
# dmg. The zip therefore carries the ticket used by automatic updates. Submit
# the finished dmg too, so a browser-downloaded disk image has its own stapled
# ticket and can be assessed offline before it is mounted.
# electron-builder signs the app but not the disk image, and the gate below
# assesses the dmg by its primary signature — an unsigned one is "rejected:
# no usable signature" even with a stapled ticket. Sign first, then notarize,
# then staple: that order is what makes the ticket cover the signed image.
echo "== signing final dmg"
codesign --sign "$CSC_NAME" --keychain "$CSC_KEYCHAIN" --timestamp --force "$DMG"
codesign --verify --verbose=2 "$DMG"

echo "== notarizing final dmg"
xcrun notarytool submit "$DMG" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$DMG"

echo "== release gates"
node build/verify-package.js "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
TEAM="$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -1)"
test "$TEAM" = "54H77VDNJY" || { echo "unexpected signing Team ID: $TEAM" >&2; exit 1; }
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
spctl --assess --type execute --verbose=2 "$APP"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"

echo "== uploading to release v$VERSION"
# latest-mac.yml and the signed zip are what electron-updater uses to apply a
# Mac update; the dmg is the ordinary first install.
FEED="dist/latest-mac.yml"
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

macOS (Apple Silicon): download the signed and notarized dmg, or install with:

    curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash

Installed copies use this same feed for signed automatic updates."
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
