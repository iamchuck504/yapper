#!/bin/bash
# Drives mac/install.sh end to end against a local feed and a throwaway
# install folder, using the real zip and the real manifest out of dist/.
#
#   bash mac/e2e-install.sh
#
# What it proves: the manifest is parsed, the checksum is actually checked
# (a tampered zip must be refused), the bundle survives unpacking with its
# symlinks and executable bits, and the installed copy carries no quarantine —
# which is the entire reason the script exists.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null' EXIT

fails=0
check() {  # check <name> <already-evaluated-condition:0|1>
  if [ "$2" -eq 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi
}

VERSION="$(node -p "require('$ROOT/package.json').version")"
ZIP="Yapper-$VERSION-arm64-mac.zip"

if [ ! -f "$ROOT/dist/$ZIP" ] || [ ! -f "$ROOT/dist/latest-mac.yml" ]; then
  echo "faltan dist/$ZIP y dist/latest-mac.yml — corre antes: npx electron-builder --mac"
  exit 2
fi

# ---- a local feed serving exactly what GitHub serves ----
mkdir -p "$WORK/feed"
cp "$ROOT/dist/$ZIP" "$ROOT/dist/latest-mac.yml" "$WORK/feed/"
# -u or the port line sits in the buffer; --bind because it listens on :: by
# default and the script asks for 127.0.0.1
(cd "$WORK/feed" && python3 -u -m http.server 0 --bind 127.0.0.1 >"$WORK/srv.log" 2>&1) &
SRV=$!
for _ in $(seq 1 40); do grep -q "port" "$WORK/srv.log" 2>/dev/null && break; sleep 0.1; done
PORT="$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$WORK/srv.log" | head -1)"
[ -n "$PORT" ] || { echo "the local server did not start"; exit 2; }
FEED="http://127.0.0.1:$PORT"

export YAPPER_FEED="$FEED"
export YAPPER_APP="$WORK/Applications/Yapper.app"
export YAPPER_NO_OPEN=1
mkdir -p "$WORK/Applications"

# ---- 1. clean install ----
echo "== clean install"
bash "$ROOT/mac/install.sh" >"$WORK/install.log" 2>&1; rc=$?
check "the installer finishes cleanly" "$rc"
[ -d "$YAPPER_APP" ]; check "Yapper.app landed in place" $?
[ -x "$YAPPER_APP/Contents/MacOS/Yapper" ]; check "the binary keeps its executable bit" $?

# Electron's framework carries symlinks; unzip flattens them and the app will not start.
[ -L "$YAPPER_APP/Contents/Frameworks/Electron Framework.framework/Versions/Current" ]
check "the framework symlinks survived" $?

PLIST_VER="$(defaults read "$YAPPER_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
[ "$PLIST_VER" = "$VERSION" ]; check "the installed version is $VERSION" $?

# What justifies the whole script: no quarantine, no Gatekeeper detour.
! xattr -p com.apple.quarantine "$YAPPER_APP" >/dev/null 2>&1
check "the installed copy carries no quarantine" $?

# ---- 2. a tampered zip has to be rejected ----
echo "== zip alterado"
printf 'x' >> "$WORK/feed/$ZIP"
BEFORE="$(defaults read "$YAPPER_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
bash "$ROOT/mac/install.sh" >"$WORK/tampered.log" 2>&1; rc=$?
[ "$rc" -ne 0 ]; check "the installer fails on a different checksum" $?
grep -qi "checksum mismatch" "$WORK/tampered.log"; check "and says why" $?
AFTER="$(defaults read "$YAPPER_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
[ "$BEFORE" = "$AFTER" ]; check "the copy that was already there is untouched" $?

# ---- 3. reinstalar encima ----
echo "== reinstalar encima"
cp "$ROOT/dist/$ZIP" "$WORK/feed/$ZIP"
bash "$ROOT/mac/install.sh" >"$WORK/reinstall.log" 2>&1; rc=$?
check "reinstalling over an existing copy works" "$rc"
grep -qi "replacing it" "$WORK/reinstall.log"; check "and says it is replacing it" $?

echo ""
[ "$fails" -eq 0 ] && echo "PASS" || echo "$fails fallos"
exit $((fails > 0))
