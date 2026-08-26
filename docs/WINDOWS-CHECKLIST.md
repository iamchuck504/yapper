# What still has to be checked on Windows

> **Run on Windows, 2026-08-02 — nearly all of it holds.** The cross-built
> 0.1.4 installs, finds the engine, calibrates and answers its update check
> correctly; the full Electron battery passes; and **0.1.6 is the first
> release cut from Windows since 0.1.1**, verified end to end on the live
> feed: an installed 0.1.4 noticed it, downloaded it in the background and
> was 0.1.6 on disk after quitting. Four real problems surfaced and were
> fixed at the cause — the "zero words lost" assertion is unsound on CUDA
> (the backend disagrees with *itself* by up to 34 words; the test now
> measures that floor), `ensureTier` still had the settings race §6 warned
> about (a theme picked mid-calibration was reverted), the capsule drifted
> out of its corner on fractional display scales (1.104 here; it re-places
> from the corner's origin now), and `test-steady-cpu` could be killed with
> the GPU build still hidden — which then made everything on the machine
> silently calibrate `steady`, and incidentally proved the flavour-change
> recalibration live: steady/759 ms → fast/77 ms, unprompted. GitHub
> Releases answers 206 to Range requests, so resumes work against the real
> engine source.
>
> **Second pass, 2026-08-02:** §3's System-meter glance done (both meters
> move with real capture, 1454→1475 px frame to frame), and §4's two open
> questions are closed as features: **Windows has the tray** (same menu as
> the macOS menu bar item, wearing the app icon, recording state shown by an
> amber-dot variant since setTitle is macOS-only), and the application menu
> is now set on **both** platforms — the early return on Windows had left
> Electron's *default* menu installed under the hidden bar, whose Ctrl+R
> accelerator still worked and would have reloaded the renderer
> mid-recording. Windows also adopted the inverted icon (ink tile, amber
> mark) by preference: `build/icon-win-invert.js` packs the mac artwork into
> the .ico and the tray images. Still unexercised: 125 % display scaling,
> and the taskbar docked top or left.

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

**Then the Electron suites**, which `npm test` does not run — they need a window,
so they go one at a time with `npx electron build/test-<name>.js`. These are the
ones that cover what changed since this list was written and are not macOS-only:

```
test-theme          Auto/Light/Dark, the default, and that the choice sticks
test-options-ui     the fold: closed on every launch, and the summary under it
test-actions-ui     …including the theme button clearing the content column
test-smoke          every view, control and export, listening for renderer errors
test-recording-signpost  the sidebar indicator and the way back
test-record-cycle   record → transcribe → notes, end to end
test-bubble-corner  the four corners, measured against the work area
test-llm-ui         the provider rows now that they live inside the fold
```

`test-app-menu.js`, `test-permissions-early.js`, `test-sys-meter.js`,
`test-tray.js`, `test-screen-prompt.js` and `test-audio-orphans.js` skip
themselves off macOS — see §4 for what that leaves worth checking by hand.

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

### Transcription now runs during the meeting

The biggest change since this list was written, and it is platform-neutral
code Windows will run. Windows are transcribed as the audio arrives, so
stopping leaves only the tail — measured on macOS: 0.9 s instead of 5.8 s on a
seven-minute meeting, identical-content transcript.

**Test:** record ~5 minutes, stop, and watch how long "Transcribing…" shows.
Seconds, not tens of seconds. Then compare the transcript against one produced
by *Transcribe* on the same meeting reopened (kill the app between, so the
head start is lost and the full pass runs) — the content should match.

**The tier detail that matters here:** the head start is disabled on `steady`
(`engine.canGetAhead`) because there live uses `base` while the final pass
uses `small`, and alternating models restarts the shared server every few
seconds. A CPU-only Windows machine that calibrates to `steady` should behave
exactly as before this feature existed — verify the live transcript stays
smooth there and that stopping still takes the old full-pass time.

**And the deadline:** requests to whisper-server now time out against the
machine's measured pace (`tierMs`), with a proportional fallback before
calibration. A wedged server costs a retried window, not the transcript. The
budget scales with the measured speed, so a slow CPU machine gets a
correspondingly wide deadline — nothing healthy should ever trip it.

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
- **The bubble's starting corner.** Four corners, **default top right** since
  this list was written — the bottom right is the strip a video call fills with
  its own controls.
  **This is the one with a real Windows-specific risk:** the position comes
  from the display's *work area*, and on Windows the taskbar can be on any
  edge. A taskbar docked left or top shifts the work area's origin, and the
  first version of this code got exactly that wrong on macOS by using
  `workAreaSize` (no origin) instead of `workArea`. Test all four corners with
  the taskbar moved to the top and to the left.
  Two more things changed here and are worth the same taskbar treatment:
  the whole capsule is a drag handle (`-webkit-app-region: drag`, with the
  controls marked `no-drag`), and **expanding anchors to where the window
  actually is**, not to the configured corner — a dragged capsule used to jump
  348 px sideways to open. `build/test-bubble-corner.js` measures all of this
  geometrically and runs on Windows.
- **The System meter and its gain slider.** These already worked on Windows,
  where the loopback runs through the renderer's audio graph. The macOS fix is
  behind a `platform === 'darwin'` branch and the Windows path was not touched.
  **Confirm it still moves** — that is a regression check, not a new feature.
  What *did* change for both is the drawing: the trace is normalised to a
  rolling peak so a quiet source is still visible, and then multiplied by the
  chosen gain so the slider has a visible effect again. On Windows both meters
  are fed by analysers on the same clock, so the pacing problem that produced
  the macOS ring buffer does not exist there — but the two meters should now
  look like siblings rather than one smooth and one stuttering.

---

## 3b. The record view, rebuilt — all of it cross-platform

Written and screenshotted on macOS at 1000, 1180 and 1440 px. Nothing here is
behind a platform guard, so the risk on Windows is metrics: different default
fonts, a scrollbar that takes width, and display scaling at 125 % or 150 %,
which is where a layout tuned on a Retina Mac usually first shows a seam.

- **Start recording and Import voice note are at the top of the view**, above
  the microphone picker and the title. Everything else folds away behind one
  line: `Meeting options — General · Concise`, with a sliders icon, the summary
  of what is chosen, and a **Show / Hide** pill with a chevron that turns.
  Folded on every launch, deliberately — it does not remember being open.
- **The options are grouped**, not one stack of fourteen rows: **Notes**
  (style, detail, instructions, provider and its key/model/endpoint rows),
  **Recording** (noise reduction, participants, keep audio), **While it runs**
  (bubble, auto-detect, start at login, starting corner) and **App** (theme).
  Check the group captions and the hairlines survive at 125 % scaling, and that
  the label column (110 px) still holds "Noise reduction" on one line.
- **Recording state.** Start and Import disappear (they cannot be used
  mid-meeting), the microphone picker stays, and the meters take a full-width
  row of their own instead of sharing one with the clock and three buttons.
- **The theme button clears the content column.** It is fixed to the window and
  floats over whatever is under it; on a narrow window the action-items bar ran
  underneath it. The right gutter now clears its 16 + 32 px.
  `build/test-actions-ui.js` measures the two rectangles at 1000 px wide and
  runs on Windows — **the Windows scrollbar takes width from the same gutter**,
  so this is the check most likely to come back different.
- **"Start at login"** reads *Start with Windows* there, from `#startup-label`.
  Worth an eye now that it sits inside a group.

### Theme: Auto, Light, Dark

New, cross-platform, and the part with the most machinery behind it.

- The control is under **Meeting options → App**. **Dark by default.**
- **Auto follows the system setting and keeps following it** — the renderer
  watches `prefers-color-scheme`, so a machine that switches at sunset takes
  Yapper with it, without reopening. On Windows that is Settings → Personalisation → Colours, and it is worth flipping it with the app open.
- What is stored is the **word chosen**, not the colour it resolved to. `main`
  resolves it again — through `nativeTheme.shouldUseDarkColors` — for the
  window background and for the splash card, both painted before the page
  exists. **If those two disagree, the app opens on a flash of the wrong
  theme**, which is exactly the bug this shape invites. On Windows, check the
  first frame after a cold start under each of the three settings.
- The button beside the title is still the shortcut and commits to a side
  rather than flipping Auto.
- `build/test-theme.js` covers all of it and runs on Windows.

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
- `app.dock.show()` and the LaunchServices staleness behind it
- The permission priming at launch (`primePermissions`): the microphone through
  `systemPreferences.askForMediaAccess`, system audio by briefly running the
  helper, since creating a tap is the only thing that triggers that prompt
- The system-audio ring buffer in the renderer and its `SYS_WAVE_*` constants —
  the whole path exists because macOS mixes those samples in main; on Windows
  an analyser draws that meter directly

**Two open questions rather than tasks:**

- The **menu bar item** is macOS-only. Windows has a system tray that could
  hold the same thing — start, stop, and whether a recording is running — and
  the same argument applies, since the app is behind the call either way. Not
  built, because it was not asked for.
- The **application menu** (`buildAppMenu`) is built on both platforms but
  earns its keep on macOS, where the menu bar belongs to the frontmost app.
  On Windows it is hidden (`autoHideMenuBar`), so what actually matters there
  is that **Reload and Toggle Developer Tools stay out of packaged builds** —
  a stray Ctrl+R during a meeting reloads the renderer with a recording in it.
  `build/test-app-menu.js` asserts that, but it skips off macOS. Either drop
  the skip or check by hand.

---

## 5. Releasing from Windows

`npm run release` still works and is the normal path. Worth knowing:

`mac/build-app.sh` now creates the release if it does not exist, and when it
does, it carries the previous release's Windows assets forward — otherwise a
mac-only version would leave `latest.yml` off the newest release and Windows
copies would stop seeing updates, silently. Cutting from Windows afterwards
replaces those with real ones.

The public feed now has a macOS-first `v0.1.13`. It deliberately carries the
last verified Windows `0.1.7` installer and manifest so existing Windows copies
do not lose their updater feed; those carried files do not make Windows 0.1.13
available or verified.

The next Windows pass should build **the same 0.1.13 version** from
`macos-login-item` at or after `39f20ef`, complete the runtime checklist in
`.github/WINDOWS-RELEASE-CHECKLIST.md`, and upload the EXE, blockmap and
`latest.yml` into the existing `v0.1.13` release. Do not create another release
or run `npm run release`: replacing the Windows platform files in the existing
cross-platform release is the intended handoff.

This pass matters because Windows is still the untested surface: a
Windows-built installer that someone has actually installed, recorded with,
updated and removed is worth more than another cross-build from the Mac.

---

## 6. Known, not scheduled

- **Windows remains unsigned.** SmartScreen warnings remain until the Windows
  installer gets a trusted signing identity. macOS release builds now use a
  stable Developer ID identity, so permissions survive signed updates.
- **`llm.js` was never in git until today.** It was not ignored — it had simply
  never been added, so any clone was missing the note providers and would fail
  at require time. Worth a glance at whether anything else escaped the same
  way; a check of the other modules came back clean.
- **`writeSettings` used to replace the file** with whatever the caller had
  read, so two overlapping writers each restored the other's old fields. The
  first-run calibration reads at launch and writes seconds later, which meant a
  setting chosen in between was silently dropped — found while writing the
  theme, fixed by merging onto what is on disk. Two callers remove keys on
  purpose and now say so explicitly (`writeSettings(s, ['keepAudio'])`).
  **This one is worth knowing on Windows**, because the calibration window
  there is longer: a CPU-only machine takes noticeably more time to measure its
  tier, so the race was wider on Windows than on the Mac where it was found.
- **The theme has one home now**, `settings.json`, read through the only
  synchronous IPC channel in the bridge. The page used to keep its own copy in
  `localStorage`, and on a real profile the two drifted: settings said `auto`,
  the page said `light`, so with the system in dark mode the window opened dark
  and the page rendered light. Any profile that has been through the older
  builds carries that stale key; it is cleared on load.
