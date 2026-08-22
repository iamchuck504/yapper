#!/bin/bash
# Install a signed and notarized Yapper release on an Apple Silicon Mac.
#
#   curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
#
# It rides along as a release asset rather than living on a branch, so the
# script and the build it installs are cut at the same moment and the feed
# repo needs no source tree of its own.
#
# The feed checksum catches corruption first. Before replacing an installed
# copy, macOS then verifies the Developer ID signature, the expected Team ID,
# Apple's stapled notarization ticket and Gatekeeper acceptance. The script
# never clears quarantine to bypass a failed trust check.
set -euo pipefail

REPO="${YAPPER_REPO:-iamchuck504/yapper-releases}"
# YAPPER_FEED and YAPPER_APP exist so the whole thing can be run end to end
# against a local server and a throwaway folder — see mac/e2e-install.sh.
FEED="${YAPPER_FEED:-https://github.com/$REPO/releases/latest/download}"
APP="${YAPPER_APP:-/Applications/Yapper.app}"
EXPECTED_TEAM="54H77VDNJY"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- the machine

[ "$(uname -s)" = "Darwin" ] || fail "Yapper is a macOS app; this is $(uname -s)."

if [ "$(uname -m)" != "arm64" ]; then
  fail "Yapper needs Apple Silicon (M1 or newer). This Mac reports $(uname -m)."
fi

OS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$OS_MAJOR" -lt 13 ]; then
  fail "Yapper needs macOS 13 or newer. This Mac runs $(sw_vers -productVersion)."
fi

[ "$(id -u)" -ne 0 ] || fail "Do not run this with sudo. Yapper installs per-user and needs no admin rights."

# The end-to-end installer test uses an unsigned local build in a throwaway
# folder. Its bypass is accepted only for a loopback feed and a temporary
# destination, so it cannot weaken an ordinary install by accident.
TEST_MODE=0
if [ -n "${YAPPER_TEST_ALLOW_UNTRUSTED:-}" ]; then
  case "$FEED" in http://127.0.0.1:*|http://localhost:*) ;; *) fail "The test-only trust bypass requires a loopback feed." ;; esac
  case "$APP" in /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*) ;; *) fail "The test-only trust bypass requires a temporary destination." ;; esac
  TEST_MODE=1
fi

# ---------------------------------------------------------------- the manifest

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say "Reading the release feed…"
curl -fsSL "$FEED/latest-mac.yml" -o "$WORK/latest-mac.yml" \
  || fail "Could not reach the release feed. Check the connection and try again."

# The nested per-file entries are indented; the top-level ones are not, which is
# how `path` and its `sha512` are told apart from the dmg's without a YAML parser.
VERSION="$(sed -n 's/^version: *//p'  "$WORK/latest-mac.yml" | head -1)"
ZIP="$(    sed -n 's/^path: *//p'     "$WORK/latest-mac.yml" | head -1)"
WANT="$(   sed -n 's/^sha512: *//p'   "$WORK/latest-mac.yml" | head -1)"

[ -n "$VERSION" ] && [ -n "$ZIP" ] && [ -n "$WANT" ] \
  || fail "The release manifest is not in the shape this script expects."

case "$ZIP" in
  *.zip) ;;
  *) fail "The manifest points at '$ZIP', which is not a zip. Refusing to guess." ;;
esac

if [ -d "$APP" ]; then
  HAVE="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"
  say "Yapper $HAVE is installed; replacing it with $VERSION."
else
  say "Installing Yapper $VERSION."
fi

# ---------------------------------------------------------------- the download

# ${ZIP} braced on purpose: next to a multibyte character such as "…", bash
# swallows it into the variable name and dies with "unbound".
say "Downloading ${ZIP}…"
curl -fL --retry 3 --retry-delay 2 --progress-bar "$FEED/$ZIP" -o "$WORK/$ZIP" \
  || fail "The download failed. Nothing was changed."

say "Verifying the checksum…"
GOT="$(openssl dgst -sha512 -binary "$WORK/$ZIP" | openssl base64 -A)"
if [ "$GOT" != "$WANT" ]; then
  fail "Checksum mismatch — this is not the file the feed says it is. Nothing was installed.
  expected: $WANT
  got:      $GOT"
fi

# ---------------------------------------------------------------- installing

if pgrep -f "Yapper.app/Contents/MacOS/Yapper" >/dev/null 2>&1; then
  say "Quitting the running copy…"
  osascript -e 'tell application "Yapper" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "Yapper.app/Contents/MacOS/Yapper" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -f "Yapper.app/Contents/MacOS/Yapper" >/dev/null 2>&1 || true
fi

say "Unpacking…"
# ditto, not unzip: an .app bundle carries symlinks (the Electron framework's
# Versions/Current) and executable bits that unzip does not reliably restore.
ditto -x -k "$WORK/$ZIP" "$WORK/out" || fail "Could not unpack the download."
[ -d "$WORK/out/Yapper.app" ] || fail "The zip did not contain Yapper.app."

CANDIDATE="$WORK/out/Yapper.app"
if [ "$TEST_MODE" -eq 0 ]; then
  say "Verifying Apple's signature and notarization…"
  codesign --verify --deep --strict --verbose=2 "$CANDIDATE" \
    || fail "The app's Developer ID signature is not valid. Nothing was installed."
  TEAM="$(codesign -dv --verbose=4 "$CANDIDATE" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -1)"
  [ "$TEAM" = "$EXPECTED_TEAM" ] \
    || fail "The app is signed by unexpected team '$TEAM'. Nothing was installed."
  xcrun stapler validate "$CANDIDATE" >/dev/null \
    || fail "The app has no valid Apple notarization ticket. Nothing was installed."
  spctl --assess --type execute --verbose=2 "$CANDIDATE" \
    || fail "Gatekeeper does not accept this app. Nothing was installed."
else
  say "Test mode: trust checks are intentionally limited to the local fixture."
fi

# The new copy is written beside the old one first. The old bundle is then
# renamed to a backup on the same filesystem and restored if activation fails.
STAGE="$(dirname "$APP")/.Yapper.app.incoming"
BACKUP="$(dirname "$APP")/.Yapper.app.previous.$$"
rm -rf "$STAGE"
rm -rf "$BACKUP"
ditto "$WORK/out/Yapper.app" "$STAGE" || {
  rm -rf "$STAGE"
  fail "Could not write to $(dirname "$APP"). The copy you had is untouched."
}
HAD_OLD=0
if [ -e "$APP" ]; then
  mv "$APP" "$BACKUP" || fail "Could not preserve the installed copy. Nothing was changed."
  HAD_OLD=1
fi
if { [ "$TEST_MODE" -eq 1 ] && [ -n "${YAPPER_TEST_FAIL_ACTIVATE:-}" ]; } || ! mv "$STAGE" "$APP"; then
  if [ "$HAD_OLD" -eq 1 ]; then
    mv "$BACKUP" "$APP" 2>/dev/null \
      || fail "Activation failed and the previous copy could not be restored from $BACKUP."
  fi
  fail "Could not put Yapper in place. The previous copy was restored."
fi
if [ "$HAD_OLD" -eq 1 ]; then rm -rf "$BACKUP"; fi

# Re-register the replaced bundle so LaunchServices sees the current version.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" 2>/dev/null || true

INSTALLED="$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "$VERSION")"
say "Yapper $INSTALLED is in /Applications."

cat <<'EOF'

First launch downloads the transcription engine. You do not wait for all of
it: recording opens after the first ~160 MB and the larger model keeps
arriving behind it.

The first time you record, macOS asks for two permissions. The second one,
Screen Recording, is what captures the other side of the call — and it needs
Yapper quit and reopened before it applies. docs/INSTALL-MACOS.md explains
why, and why no screen content is ever read.

EOF

if [ -n "${YAPPER_NO_OPEN:-}" ]; then
  say "Open Yapper from /Applications when you are ready."
else
  open -a "$APP" 2>/dev/null || say "Open Yapper from /Applications when you are ready."
fi
