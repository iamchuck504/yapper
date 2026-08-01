#!/bin/bash
# Compiles the whisper.cpp engine for Apple Silicon and publishes it to the
# release feed, where provision.js downloads it on every Mac's first run.
#
# Run ONCE per whisper.cpp version, on a Mac with Apple Silicon:
#
#   bash mac/build-engine.sh
#
# Needs: Xcode Command Line Tools (xcode-select --install), cmake
# (brew install cmake), and the gh CLI signed in as iamchuck504.
set -euo pipefail

TAG="v1.9.1"                      # keep in step with WHISPER_TAG in provision.js
REPO="iamchuck504/yapper-releases"
WORK="$(mktemp -d)"
OUT="$PWD/whisper-mac-arm64.zip"

echo "== cloning whisper.cpp $TAG"
git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp "$WORK/whisper.cpp"

echo "== building (Metal, static)"
cmake -B "$WORK/whisper.cpp/build" -S "$WORK/whisper.cpp" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build "$WORK/whisper.cpp/build" --config Release -j "$(sysctl -n hw.ncpu)" --target whisper-server

BIN="$WORK/whisper.cpp/build/bin"
test -x "$BIN/whisper-server" || { echo "FAILED: whisper-server was not produced"; exit 1; }

echo "== checking it starts"
"$BIN/whisper-server" --help >/dev/null 2>&1 || true   # exits nonzero on --help, that is fine
file "$BIN/whisper-server"

echo "== packaging"
# any .metallib next to the binary comes along; static build should need none
(cd "$BIN" && zip -r "$OUT" whisper-server ./*.metallib 2>/dev/null || (cd "$BIN" && zip "$OUT" whisper-server))
unzip -l "$OUT"

echo "== publishing to the feed ($REPO, tag engine-$TAG)"
if gh release view "engine-$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "engine-$TAG" "$OUT" --repo "$REPO" --clobber
else
  # --latest=false matters: the app (and electron-updater) read the feed's
  # "latest" release to find latest.yml, and an engine release has none —
  # publishing it as latest makes every update check 404.
  gh release create "engine-$TAG" "$OUT" --repo "$REPO" --latest=false \
    --title "whisper.cpp $TAG — macOS arm64" \
    --notes "Metal build of whisper-server, compiled on Apple Silicon. Downloaded by the app's first run on macOS."
fi

rm -rf "$WORK"
echo ""
echo "done: https://github.com/$REPO/releases/tag/engine-$TAG"
