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
check() {  # check <nombre> <condición-ya-evaluada:0|1>
  if [ "$2" -eq 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; fails=$((fails+1)); fi
}

VERSION="$(node -p "require('$ROOT/package.json').version")"
ZIP="Yapper-$VERSION-arm64-mac.zip"

if [ ! -f "$ROOT/dist/$ZIP" ] || [ ! -f "$ROOT/dist/latest-mac.yml" ]; then
  echo "faltan dist/$ZIP y dist/latest-mac.yml — corre antes: npx electron-builder --mac"
  exit 2
fi

# ---- un feed local que sirve exactamente lo que sirve GitHub ----
mkdir -p "$WORK/feed"
cp "$ROOT/dist/$ZIP" "$ROOT/dist/latest-mac.yml" "$WORK/feed/"
# -u o la línea del puerto se queda en el buffer; --bind porque por defecto
# escucha en :: y el script pide 127.0.0.1
(cd "$WORK/feed" && python3 -u -m http.server 0 --bind 127.0.0.1 >"$WORK/srv.log" 2>&1) &
SRV=$!
for _ in $(seq 1 40); do grep -q "port" "$WORK/srv.log" 2>/dev/null && break; sleep 0.1; done
PORT="$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$WORK/srv.log" | head -1)"
[ -n "$PORT" ] || { echo "no arrancó el servidor local"; exit 2; }
FEED="http://127.0.0.1:$PORT"

export YAPPER_FEED="$FEED"
export YAPPER_APP="$WORK/Applications/Yapper.app"
export YAPPER_NO_OPEN=1
mkdir -p "$WORK/Applications"

# ---- 1. instalación limpia ----
echo "== instalación limpia"
bash "$ROOT/mac/install.sh" >"$WORK/install.log" 2>&1; rc=$?
check "el instalador termina bien" "$rc"
[ -d "$YAPPER_APP" ]; check "Yapper.app quedó en su lugar" $?
[ -x "$YAPPER_APP/Contents/MacOS/Yapper" ]; check "el binario conserva el bit de ejecución" $?

# El framework de Electron trae symlinks; unzip los aplana y la app no arranca.
[ -L "$YAPPER_APP/Contents/Frameworks/Electron Framework.framework/Versions/Current" ]
check "los symlinks del framework sobrevivieron" $?

PLIST_VER="$(defaults read "$YAPPER_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
[ "$PLIST_VER" = "$VERSION" ]; check "la versión instalada es $VERSION" $?

# Lo que justifica todo el script: sin cuarentena, sin paso de Gatekeeper.
! xattr -p com.apple.quarantine "$YAPPER_APP" >/dev/null 2>&1
check "la copia instalada no trae cuarentena" $?

# ---- 2. un zip alterado tiene que ser rechazado ----
echo "== zip alterado"
printf 'x' >> "$WORK/feed/$ZIP"
BEFORE="$(defaults read "$YAPPER_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
bash "$ROOT/mac/install.sh" >"$WORK/tampered.log" 2>&1; rc=$?
[ "$rc" -ne 0 ]; check "el instalador falla con checksum distinto" $?
grep -qi "checksum mismatch" "$WORK/tampered.log"; check "y dice por qué" $?
AFTER="$(defaults read "$YAPPER_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
[ "$BEFORE" = "$AFTER" ]; check "la copia que ya estaba quedó intacta" $?

# ---- 3. reinstalar encima ----
echo "== reinstalar encima"
cp "$ROOT/dist/$ZIP" "$WORK/feed/$ZIP"
bash "$ROOT/mac/install.sh" >"$WORK/reinstall.log" 2>&1; rc=$?
check "reinstalar sobre una copia existente funciona" "$rc"
grep -qi "replacing it" "$WORK/reinstall.log"; check "y avisa que reemplaza" $?

echo ""
[ "$fails" -eq 0 ] && echo "PASS" || echo "$fails fallos"
exit $((fails > 0))
