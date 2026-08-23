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

# The microphone under hardened runtime is an entitlement, not a permission:
# without com.apple.security.device.audio-input macOS refuses it silently — no
# prompt, no error the app can see — and the meeting is recorded one-sided.
# 0.1.10 shipped exactly that way and nothing noticed, because a launch check
# cannot hear. Every bundle that touches audio has to carry it: the app and
# the helpers Chromium runs its audio service in.
#
# Only under hardened runtime, which is where the entitlement is enforced. CI
# packages the app unsigned (identity=null) to check that it launches, and an
# unsigned or ad-hoc build records the microphone without any entitlement —
# 0.1.8 shipped that way and worked. Demanding it there failed every CI run.
# (Captured first: under pipefail, `grep -q` closing the pipe early would turn
# codesign's SIGPIPE into a false "not hardened".)
SIGNING="$(codesign -d --verbose=2 "$APP" 2>&1 || true)"
if grep -q "flags=.*(runtime)" <<<"$SIGNING"; then
  for BUNDLE in "$APP" "$APP"/Contents/Frameworks/*Helper*.app; do
    # Capture this one too: with pipefail, grep -q may close the pipe as soon
    # as it finds the entitlement and turn codesign's SIGPIPE into a false
    # failure of the entire pipeline.
    ENTITLEMENTS="$(codesign -d --entitlements :- "$BUNDLE" 2>/dev/null || true)"
    if ! grep -q "com.apple.security.device.audio-input" <<<"$ENTITLEMENTS"; then
      echo "FAIL  $(basename "$BUNDLE") is signed without the microphone entitlement" >&2
      echo "      (com.apple.security.device.audio-input — see build/entitlements.mac*.plist)" >&2
      exit 1
    fi
  done
  echo "ok    the app and its helpers carry the microphone entitlement"
else
  echo "ok    not a hardened-runtime build; the microphone entitlement is not required here"
fi

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
