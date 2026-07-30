# Yapper on macOS — build runbook and honest status

Everything platform-neutral already runs on macOS: the engine paths, the
first-run download, notes, search, digests, the UI. What follows is the part
that can only happen on a Mac, and the limitations that remain after it.

## Building (two commands, on an Apple Silicon Mac)

One-time setup: Xcode Command Line Tools (`xcode-select --install`),
`brew install cmake node gh`, `gh auth login` as `iamchuck504`.

```bash
git clone https://github.com/iamchuck504/yapper && cd yapper

bash mac/build-engine.sh   # once per engine version: compiles whisper.cpp
                           # (Metal, static) and publishes it to the feed
bash mac/build-app.sh      # every release: dmg + zip, uploaded to the
                           # current version's release
```

`build-engine.sh` exists because ggml-org publishes **no macOS binary at
all** — the engine on the feed is ours. `provision.js` downloads it on every
Mac's first run, exactly like the Windows first run.

## The icon, and why this build wants Xcode

macOS 26 stopped drawing legacy `.icns` files as authored: on a Mac set to dark
icons the system darkens the tile and keeps the artwork. Yapper's mark is
near-black on amber, so that pass eats it and the icon arrives in the dock as a
black slab — verified on the MacBook, not theorised.

The system leaves an icon alone only when the app ships the appearance itself,
which means a compiled asset catalog: `CFBundleIconName` → `AppIcon` inside
`Assets.car`, dark images tagged as dark. `build/after-pack.js` builds that
during packaging, from two sources:

- `build/yapper-icon.png` — the light variant, the icon as it always was
- `build/yapper-icon-dark.png` — amber on ink, written by `build/icon-dark.js`
  (run it with the bundled Electron; it re-mixes every seam pixel rather than
  swapping two colours, so the anti-aliasing survives)

Compiling the catalog needs `actool`, which comes with **full Xcode** — the
Command Line Tools ship a shim that only errors. Without it the build still
succeeds and still installs, and says so:

```
[icon] actool unavailable (needs full Xcode, not Command Line Tools).
```

That is deliberate. A Windows release must not depend on a 10 GB Xcode install,
so the missing catalog is a warning, never a failure. After installing Xcode,
run `sudo xcode-select -s /Applications/Xcode.app` once, then build normally.

## What a Mac user gets

- Recording with live transcript, notes, Today/This week, action items,
  search — the full app.
- First launch downloads the engine (Metal build + the two models) with
  progress on screen, same as Windows.
- Native notifications **with a real button** (better than Windows there).
- The Claude CLI is found even though GUI apps get a bare PATH
  (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` are checked).

## Honest limitations, in order of pain

1. **Microphone only.** Electron's system-audio loopback is Windows-only
   (their docs: *"currently only supported on Windows"*). On speakers the mic
   hears both sides of a call; on headphones it hears only this side. The
   existing warning ("only the mic is being recorded") states it in-app.
   Closing this needs a native ScreenCaptureKit capture path — real work, not
   configuration. Virtual audio drivers (BlackHole et al.) would also work but
   install system audio devices, and this project does not do that to people's
   machines by default.
2. **Unsigned: Gatekeeper blocks the first open.** No Apple Developer account
   ($99/year). The user right-clicks the app → Open → Open, once. Distribution
   without that friction needs the account plus notarization.
3. **Updates notify, they do not self-install.** Squirrel.Mac refuses unsigned
   updates, so the app checks the same feed, and the sidebar pill becomes
   "New version — download", opening the releases page. Auto-install arrives
   with signing.
4. **No meeting auto-detection.** The Windows implementation reads a Windows
   registry surface. A macOS equivalent (mic-in-use via CoreAudio) is
   possible but does not exist yet — the card and toast simply never fire.
5. **Intel Macs are not built.** arm64 only; an x64/universal build would need
   a second engine compile and doubles the artifact size for a shrinking
   audience.

## What has actually run on a Mac

The shakedown happened on 2026-07-30, on an M4 Pro running macOS 27. What was
verified, in the order it was done:

- **The engine compiles.** whisper.cpp v1.9.1, Metal and Accelerate/BLAS both
  detected, `whisper-server` at 3.5 MB. Published to the feed as
  `engine-v1.9.1`, which until then did not exist — every Mac's first run was
  404ing.
- **The app builds.** dmg and zip, arm64, via `electron-builder --mac`.
- **Gatekeeper did not block it.** With the quarantine attribute cleared the
  app opens directly; the right-click → Open dance was not needed.
- **Transcription works, on the GPU.** `engine.js` against a real wav:
  `using MTL0 backend`, 21.7 s of audio in 0.5 s, timestamps and windowing as
  in production. Notes came back from `llm.js` through the Claude CLI.
- **The whole suite passes here**, 13 files, after `test-provision.js` stopped
  assuming the host was Windows.

Not yet exercised: microphone permission and live capture (they need a person
at the keyboard), and the icon's asset catalog (needs Xcode, see above).

Two things bit during that first run and are worth knowing before the next one.
`electron-builder` rewrites `package.json` after packaging, dropping `scripts`,
`devDependencies` and the whole `build` block — check `git diff` before
committing. And publishing an engine release marks it *latest* on the feed
unless told otherwise, which points both update checks at a release that has no
`latest.yml`; `build-engine.sh` now passes `--latest=false`.
