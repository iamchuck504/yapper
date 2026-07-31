#!/bin/bash
# Install Yapper on an Apple Silicon Mac, without the Gatekeeper detour.
#
#   curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
#
# It rides along as a release asset rather than living on a branch, so the
# script and the build it installs are cut at the same moment and the feed
# repo needs no source tree of its own.
#
# Why this exists, stated plainly: the app is not signed with an Apple
# Developer certificate, so a dmg opened from the Finder is blocked and the
# user has to go and click "Open Anyway" in System Settings. That block comes
# from the `com.apple.quarantine` attribute the *browser* attaches to a
# download — not from macOS inspecting the app. curl does not attach it, so a
# copy installed this way opens normally.
#
# That means Apple is not vouching for these bytes. Nothing here pretends
# otherwise. What replaces it is a checksum: the zip is verified against the
# sha512 in the release manifest before anything is written to /Applications.
# That catches a corrupted or tampered download; it does not protect against
# the release feed itself being compromised, because both the manifest and the
# zip come from it. Installing this way is trusting whoever publishes that
# repo. Read the script before piping it to a shell — including this one.
set -euo pipefail

REPO="${YAPPER_REPO:-iamchuck504/yapper-releases}"
# YAPPER_FEED and YAPPER_APP exist so the whole thing can be run end to end
# against a local server and a throwaway folder — see mac/e2e-install.sh.
FEED="${YAPPER_FEED:-https://github.com/$REPO/releases/latest/download}"
APP="${YAPPER_APP:-/Applications/Yapper.app}"

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

# ${ZIP} con llaves a propósito: pegado a un carácter multibyte como "…",
# bash se lo traga dentro del nombre de la variable y muere con "unbound".
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

# Only now is the old copy touched, so a failure above leaves it working.
rm -rf "$APP"
ditto "$WORK/out/Yapper.app" "$APP" || fail "Could not write to /Applications."

# curl attaches no quarantine, but a previous install from a browser may have
# left the attribute on the folder; clear it so this copy opens either way.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

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
