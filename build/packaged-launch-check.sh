#!/bin/bash
# Launches the packaged app the way a user does and checks it is still alive
# ten seconds later. This is the only check that sees the packaged binary as
# a whole: fuses, asar integrity, hardened runtime and entitlements together.
#
#   bash build/packaged-launch-check.sh dist/mac-arm64/Yapper.app
#
# YAPPER_HOME points the app at a scratch directory (macOS resolves
# Application Support through the system, not $HOME, so HOME alone isolates
# nothing): no real settings or meetings are touched, the single-instance lock
# does not collide with a running Yapper, and the first-run engine download
# that starts into the scratch dies with the app.
set -euo pipefail
APP="${1:?path to the packaged .app}"
BIN="$APP/Contents/MacOS/$(defaults read "$(cd "$APP" && pwd)/Contents/Info.plist" CFBundleExecutable)"
test -x "$BIN" || { echo "no executable at $BIN" >&2; exit 1; }

SCRATCH="$(mktemp -d)"
LOG="$SCRATCH/launch.log"
YAPPER_HOME="$SCRATCH" "$BIN" >"$LOG" 2>&1 &
PID=$!
sleep 10

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  if grep -q "FATAL" "$LOG"; then
    echo "the packaged app logged a FATAL while starting:" >&2
    grep "FATAL" "$LOG" >&2
    rm -rf "$SCRATCH"; exit 1
  fi
  echo "ok    the packaged app is alive 10 s after launch"
  rm -rf "$SCRATCH"; exit 0
fi

wait "$PID" && STATUS=0 || STATUS=$?
echo "FAIL  the packaged app exited within 10 s (status $STATUS)" >&2
grep -v "^$" "$LOG" | tail -20 >&2
rm -rf "$SCRATCH"; exit 1
