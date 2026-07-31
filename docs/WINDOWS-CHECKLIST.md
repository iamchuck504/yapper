# What still has to be checked on Windows

Everything below was written and verified on a Mac. Some of it is
platform-neutral code that Windows runs too, some of it changes what Windows
does specifically, and some is macOS-only and needs nothing. The point of this
list is to keep those apart, so the Windows session goes at the parts that can
actually break.

**The one fact that shapes the rest:** the Windows installers published as
0.1.2, 0.1.3 and 0.1.4 were **cross-built from the Mac and have never run on
Windows.** electron-builder makes an NSIS installer from macOS without wine,
and the packaged asar was checked to contain the changed code — but "it
packaged" is not "it runs". A Windows copy has likely auto-updated to 0.1.4
already, since that path installs on quit without asking.

---

## 1. Run these first

They exist for this and cannot run off Windows:

```powershell
powershell -ExecutionPolicy Bypass -File build\e2e-install.ps1    # shortcuts, unpacked wav, feed config, engine found, calibration
powershell -ExecutionPolicy Bypass -File build\e2e-update.ps1     # install 0.1.0, serve 0.1.1, quit, check the exe on disk
powershell -ExecutionPolicy Bypass -File build\e2e-uninstall.ps1  # removes every trace
npm test                                                          # the pure suite, on Windows this time
```

`npm test` matters more than it looks: `test-provision.js` pins the Windows
ordering cases (CPU build, CUDA build, both models) with the platform forced to
`win-x64`, but it has only ever executed on a Mac.

There is also `build/e2e-live-feed.ps1` for the update feed end of it.

**The heavier tests need fixtures first**, and the failure reads like a broken
test rather than a missing file — `ENOENT ... yapper-60s.wav`. Cost twenty
minutes here:

```powershell
node build\make-fixtures.js       # builds the 10 s and 60 s clips from calibration.wav
```

`test-live-vs-final.js` and `test-faults.js` both want them, and `test-faults`
additionally wants the `small` model present.

---

## 2. Changed for Windows, biggest first

### The CUDA build moved to the end

`provision.js` used to download the 646 MB CUDA build **before** the models, so
a machine with an NVIDIA card sat in front of a progress bar for the better
part of an hour before it could record anything. It is last now: server binary,
then both models, then CUDA as a bonus on top.

**Test on a machine with an NVIDIA GPU**, which is the only place this changes
anything. Expected: recording opens after ~160 MB, the CUDA build keeps
downloading behind it, and the tier re-calibrates by itself when it lands —
`ensureTier` re-measures because the binary flavour changed from `win-x64` to
`win-x64-gpu`. That re-calibration is the part most likely to be wrong.

### Downloads resume instead of restarting

A dropped connection used to delete the partial file. Now the fragment survives
and the next attempt asks for the rest with a `Range` header. Verified against
HuggingFace's CDN from here; GitHub Releases (where the CUDA build and the
Windows engine come from) has not been exercised the same way.

**Test:** start a fresh install, pull the network mid-download, restore it.
Expect it to continue rather than start over. Also try quitting mid-download
and reopening — the `.part` lives beside the final file and should be picked
up.

### One inference at a time

Two `/inference` requests in flight wedged whisper-server: sockets open, no
CPU, no answer ever again. Found on a real 24-minute meeting. The race is in
`live.js` and is not platform-specific, so Windows had it too — it just had not
been hit yet.

**Test:** start a recording, and while it is running hit *Transcribe* on an
older meeting. The live transcript should pause and resume with no errors, and
the transcription should complete. `test-live-vs-final.js` covers this and can
run on Windows.

### The notes CLI gets an explicit working directory

`llm.js` spawned the Claude Code CLI with no `cwd`, so it inherited the app's —
`/` on macOS, which made the CLI walk into protected folders and made macOS
attribute those requests to Yapper. Windows has no equivalent permission
prompt, but the spawn changed for everyone.

**Test:** generate notes with the Claude Code provider. That is the whole
check — it either produces notes or it does not.

---

## 3. Cross-platform UI, unverified on Windows

Written and screenshotted on macOS. None of it is behind a platform guard, so
Windows renders the same code with different fonts and metrics.

- **The sidebar button becomes the recording indicator.** `New meeting` turns
  into `Recording — 12:34` with a pip while one is running, and is the way back
  to the stop control from Action items or Search. Check it fits the sidebar
  width and that the clock does not make the button jitter each second — it is
  set to tabular numerals for that reason.
- **The bubble's starting corner.** Four corners, default bottom left.
  **This is the one with a real Windows-specific risk:** the position comes
  from the display's *work area*, and on Windows the taskbar can be on any
  edge. A taskbar docked left or top shifts the work area's origin, and the
  first version of this code got exactly that wrong on macOS by using
  `workAreaSize` (no origin) instead of `workArea`. Test all four corners with
  the taskbar moved to the top and to the left.
- **The System meter and its gain slider.** These already worked on Windows,
  where the loopback runs through the renderer's audio graph. The macOS fix is
  behind a `platform === 'darwin'` branch and the Windows path was not touched.
  **Confirm it still moves** — that is a regression check, not a new feature.

---

## 4. macOS-only — nothing to do

Listed so no time is spent on them:

- The system-audio process tap, the ScreenCaptureKit fallback, and the
  System Audio Recording Only permission
- The Screen Recording prompt with its Settings and reopen buttons
- `mac/install.sh`, `mac/e2e-install.sh`, the LaunchServices re-registration
- The menu bar item and `build/icon-tray.js`
- The notch clearance on the top corners
- The dropped `NSCamera`/`NSBluetooth` declarations — those are macOS keys

**One open question rather than a task:** the menu bar item is macOS-only.
Windows has a system tray that could hold the same thing — start, stop, and
whether a recording is running — and the same argument applies, since the app
is behind the call either way. Not built, because it was not asked for.

---

## 5. Releasing from Windows

`npm run release` still works and is the normal path. Worth knowing:

`mac/build-app.sh` now creates the release if it does not exist, and when it
does, it carries the previous release's Windows assets forward — otherwise a
mac-only version would leave `latest.yml` off the newest release and Windows
copies would stop seeing updates, silently. Cutting from Windows afterwards
replaces those with real ones.

Six changes are committed but unpublished, waiting on a reason to cut a
version: the System meter, `llm.js` finally being tracked in git, the
LaunchServices fix, the menu bar item, the recording indicator, and the bubble
corner.

---

## 6. Known, not scheduled

- **Permissions do not survive an update on macOS.** An ad-hoc signature
  changes identity with every build, so macOS treats each update as a new app.
  A stable self-signed certificate would fix it; a Developer ID certificate
  would fix Gatekeeper too. Windows has the equivalent problem as SmartScreen
  warnings, which signing also fixes.
- **`llm.js` was never in git until today.** It was not ignored — it had simply
  never been added, so any clone was missing the note providers and would fail
  at require time. Worth a glance at whether anything else escaped the same
  way; a check of the other modules came back clean.
