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

## Installing

`mac/install.sh` rides along as a release asset and installs from the zip:

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
```

The ordinary route is the dmg. Release builds are signed with the Developer ID
Application identity for team `54H77VDNJY`, use hardened runtime, and are sent
to Apple's notary service by electron-builder. `mac/build-app.sh` verifies the
identity and the `yapper-notary` keychain profile before it builds. The app is
notarized before the update zip is created, and the finished dmg is submitted
and stapled separately so both distribution formats carry offline-verifiable
tickets.

The script above remains an alternate route. It verifies the zip against the
sha512 in `latest-mac.yml`, then requires the expected Developer ID Team ID,
stapled notarization ticket and Gatekeeper acceptance before replacing the app.
It does not clear quarantine as a workaround.

Two things the release flow now depends on, both in `build-app.sh`: the **zip**
goes up alongside the dmg (the installer has nothing to fetch otherwise), and
`install.sh` goes up with it so the script and the build it installs are cut
together.

`bash mac/e2e-install.sh` drives the whole thing against a local feed and a
throwaway folder — it checks the checksum is really enforced, that a tampered
zip leaves the existing copy alone, that the framework symlinks survive
unpacking, and that an activation failure restores the installed copy. It needs
`dist/` populated by `npx electron-builder --mac` first.

## Deployment targets are not optional

`swiftc` defaults to the SDK's own version, so a build made on a beta produces
helpers stamped `minos 27.0` that refuse to launch on any other Mac — the app
still opens, and silently has neither system audio nor meeting detection. Both
are pinned explicitly in `build-app.sh`:

| Helper | Target | Why that version |
|---|---|---|
| `system-audio` | `macos13.0` | the ScreenCaptureKit fallback; the process tap it prefers is gated to 14.4 at runtime |
| `mic-probe` | `macos14.4` | the CoreAudio process list it reads |
| `speaker-diarize` | `macos14.0` | FluidAudio's offline Core ML diarizer; the app falls back to track labels on macOS 13 |

`minimumSystemVersion` in package.json says 13.0 to match. Check a build with
`vtool -show-build build/system-audio` — it costs a second, and this is
invisible on the machine that built it.

## The icon is inverted on macOS, on purpose — and Windows adopted it

macOS gets the negative of the original artwork — ink tile, amber mark — from
`build/yapper-icon-dark.png`. It began as a necessity here (below) and ended as
the version the owner prefers, so Windows now ships the same inverted art:
`build/icon-win-invert.js` packs it into `yapper-icon.ico` and derives the two
Windows tray images from it. The amber original survives only as
`icon-source.png`/`yapper-icon.png`, the input `icon-dark.js` remixes.

That is not a style preference. macOS 26 runs legacy `.icns` files through an
appearance pass: on a Mac set to dark icons it darkens the tile and keeps the
artwork. A near-black mark on a darkened tile is a black slab, which is exactly
how the icon arrived in the dock on the first build — verified by rendering
what `NSWorkspace` hands the Finder, and by comparing against another meeting-notes app and
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

1. **A system-audio permission has to be granted, once.** Both sides of a call
   are recorded here, but not through Electron: its loopback is Windows-only,
   so `mac/system-audio.swift` captures system audio and `sysaudio.js` adds
   those samples to the microphone's in `main.js`. On macOS 14.4+ that is a
   Core Audio process tap asking for **System Audio Recording Only**; on 13 it
   falls back to ScreenCaptureKit, which can only be reached through **Screen
   Recording** — a permission wide enough to read the display, for audio.

   Without it the app records the microphone alone and says so, offering both
   Settings and the reopen macOS requires. That is a degraded recording, not a
   failed one.

   **If the helper dies mid-meeting, it restarts itself once** and, if it will
   not come back, says so on screen. Silence there was the dangerous outcome:
   `take()` starts returning null, the microphone carries on alone, and the
   recording quietly becomes half a conversation that nobody notices until
   afterwards. Killing the helper during a recording is how that was found.

   **A sleeping display only costs the fallback.** ScreenCaptureKit lists no
   displays while the screen is asleep and a filter needs one even for audio
   alone, so on that route `main.js` holds the display awake for the length of
   the recording — found by the suite failing at 4 a.m. with the lid shut. A
   tap does not care, so the block is released as soon as the helper reports it
   took that door, and a laptop may dim through a meeting again.
2. **Every release must pass Apple notarization.** The certificate and
   credentials are configured; `build-app.sh` refuses upload unless package
   contents, fuses, signature, Team ID, stapling and Gatekeeper all validate.
   Publishing remains explicit; local remediation builds are not uploaded.
3. **Signed updates self-install.** The app checks the feed, downloads the
   signed zip and offers a restart; ignoring the pill applies it on quit.

   electron-builder writes **`latest-mac.yml`** for this platform, and
   `build-app.sh` uploads it with the signed zip and dmg.

   Updating is also cheap: the engine and models live in
   `~/Library/Application Support/yapper`, outside the bundle, so a new version
   is the ~95 MB dmg and not another 650 MB. Meetings and granted permissions
   survive, since neither belongs to the app bundle and the bundle id is stable.
4. **Intel Macs are not built.** arm64 only; an x64/universal build would need
   a second engine compile and doubles the artifact size for a shrinking
   audience.

Meeting auto-detection used to be on this list and no longer is: CoreAudio
answers the same question the Windows registry does, through
`mac/mic-probe.swift`. Note that the answer names a helper process — a Slack
huddle reports `com.tinyspeck.slackmacgap.helper` — so `meetings.js` matches
the app the helper belongs to, not the id itself.

Notifications were broken here too, and silently: electron-builder once left
the ad-hoc signature Electron ships with, so the bundle id and signature
identity disagreed. Release builds now use the Developer ID identity plus
hardened runtime and explicit inherited entitlements.

## What has actually run on a Mac

The shakedown happened on 2026-07-30, on an M4 Pro running macOS 27. What was
verified, in the order it was done:

- **The engine compiles.** whisper.cpp v1.9.1, Metal and Accelerate/BLAS both
  detected, `whisper-server` at 3.5 MB. Published to the feed as
  `engine-v1.9.1`, which until then did not exist — every Mac's first run was
  404ing.
- **The app builds.** dmg and zip, arm64, via `electron-builder --mac`.
- **The original ad-hoc build opened only after a local quarantine workaround.**
  That historical shakedown is not the current release policy: the signed path
  now requires normal Gatekeeper acceptance and never clears quarantine.
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

## Two doors to the system audio

`system-audio.swift` prefers a **Core Audio process tap** and keeps
ScreenCaptureKit as a fallback. The difference is not performance, it is what
the app has to ask the user for:

| Route | Since | Permission |
|---|---|---|
| Process tap | macOS 14.4 | **System Audio Recording Only** — what it says |
| ScreenCaptureKit | macOS 13 | **Screen Recording** — wide enough to read the display |

Asking for Screen Recording in order to hear a call was the worst step in the
whole install, and the reason the docs needed a paragraph explaining that no
screen content is read. The tap removes it. It also removes the display block:
ScreenCaptureKit cannot capture with the screen asleep, a tap does not care, so
on 14.4+ a laptop is allowed to dim through a meeting.

Verify a build with `build/probe-system-audio.js`, which is the only honest
test — it mutes the output, plays a clip and checks the recording still has
signal. Energy alone proves nothing, because the microphone hears the speakers
too; muting is what makes the capture path the only possible source. Measured
here: peak 476 through ScreenCaptureKit when it silently failed to start,
29,677 through the tap.

`YAPPER_FORCE_SCK=1` runs the helper down the fallback path on a machine new
enough to take the tap — otherwise that branch would only ever execute on
hardware nobody testing this owns.
