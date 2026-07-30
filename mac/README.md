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

## The icon is inverted on macOS, on purpose

Windows gets the amber tile with a near-black mark. macOS gets the negative of
it — ink tile, amber mark — from `build/yapper-icon-dark.png`.

That is not a style preference. macOS 26 runs legacy `.icns` files through an
appearance pass: on a Mac set to dark icons it darkens the tile and keeps the
artwork. A near-black mark on a darkened tile is a black slab, which is exactly
how the icon arrived in the dock on the first build — verified by rendering
what `NSWorkspace` hands the Finder, and by comparing against Granola and
Claude, whose tiles get darkened too but whose marks carry their own colour and
survive. An amber mark survives the same way, in either appearance.

`build/icon-dark.js` writes that file from `yapper-icon.png`, with the bundled
Electron:

```bash
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/icon-dark.js
```

It re-mixes rather than swapping two colours: every seam pixel is measured
along the amber→ink ramp and rebuilt in the new order, so the anti-aliasing and
the cut-out corners survive intact.

Shipping both appearances instead — amber tile in light mode, inverted in dark
— is possible, but it needs a compiled asset catalog (`CFBundleIconName` →
`Assets.car`), and compiling one needs `actool` from full Xcode. That was built
and then dropped as not worth the dependency; see the history of
`build/after-pack.js` if it ever becomes worth it again.

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
   hears both sides of a call; on headphones it hears only this side. The app
   says so on screen when recording starts. Closing this needs a native
   ScreenCaptureKit capture path — real work, not configuration. Virtual audio
   drivers (BlackHole et al.) would also work but install system audio devices,
   and this project does not do that to people's machines by default.

   macOS does not even get asked for it: requesting `getDisplayMedia` there
   costs a Screen Recording permission and returns no system audio, and a
   refusal used to reject and take the whole recording down with it — the app
   could not record at all unless you granted a permission it had no use for.
2. **Unsigned: Gatekeeper blocks the first open.** No Apple Developer account
   ($99/year). The user right-clicks the app → Open → Open, once. Distribution
   without that friction needs the account plus notarization.
3. **Updates notify, they do not self-install.** Squirrel.Mac refuses unsigned
   updates, so the app checks the same feed, and the sidebar pill becomes
   "New version — download", opening the releases page. Auto-install arrives
   with signing.
4. **Intel Macs are not built.** arm64 only; an x64/universal build would need
   a second engine compile and doubles the artifact size for a shrinking
   audience.

Meeting auto-detection used to be on this list and no longer is: CoreAudio
answers the same question the Windows registry does, through
`mac/mic-probe.swift`. Note that the answer names a helper process — a Slack
huddle reports `com.tinyspeck.slackmacgap.helper` — so `meetings.js` matches
the app the helper belongs to, not the id itself.

Notifications were broken here too, and silently: electron-builder left the
ad-hoc signature Electron ships with, so the bundle's id said
`com.yapper.meetingnotes` while its signature said `Electron`. macOS keys
notification authorisation on the signature, so the app was never registered
and never asked. `identity: "-"` fixes it, and `hardenedRuntime` is off
alongside it — it is only worth carrying for notarisation, and it would have
demanded a microphone entitlement the defaults do not include.

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
