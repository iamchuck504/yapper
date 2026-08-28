# Yapper

A desktop app for meetings: it records the call, transcribes it **on your own machine** with Whisper, and turns the transcript into a structured markdown write-up — summary, key points, decisions, action items. Yapper never uploads the audio. Only text is sent for the notes, and only to the provider you pick; Ollama keeps that processing local too. Meeting files live in `Documents/Meetings`, so the operating system may still sync them when iCloud Drive, OneDrive or another backup service manages that folder.

Runs on **Windows** and **macOS (Apple Silicon)**. Both record both sides of a call, transcribe on the machine, and detect meetings automatically — see [Platforms](#platforms) for the two places they still differ.

> **Installing:** **[Windows](docs/INSTALL-WINDOWS.md)** · **[macOS](docs/INSTALL-MACOS.md)** — step by step, including the warnings each OS shows and why.
>
> **What every feature does:** **[docs/FEATURES.md](docs/FEATURES.md)**.
>
> For architecture and build structure: **[ARCHITECTURE.md](ARCHITECTURE.md)**.
>
> **Manual with screenshots + honest assessment** (what it does well and what is still missing): **[docs/MANUAL.md](docs/MANUAL.md)**.
>
> **macOS build runbook:** **[mac/README.md](mac/README.md)** — how the engine and native helpers are compiled, and which permissions the app needs.
>
> **To install without cloning anything:** the installers live in
> [yapper-releases](https://github.com/iamchuck504/yapper-releases/releases/latest)
> (an installers-only repo, so a download does not mean cloning this one). Windows installs
> per-user and updates itself from that feed; macOS ships a `.dmg`. Both download
> the engine on first run. Publishing a new version: bump `version` in
> `package.json` and `npm run release`.

## Live transcription

- **Streaming transcription.** The renderer sends continuous PCM; `live.js` keeps a rolling 12 s buffer and re-transcribes it every ~0.7 s. A word is only "confirmed" when two consecutive passes agree (LocalAgreement-2); the tentative tail is shown dimmed and corrects itself. Long pauses start a new paragraph.
- **How far behind it runs.** Measured by replaying a minute of a real meeting at wall-clock speed on an RTX 4080 SUPER: **2.6 s median** between what is said and what is confirmed (worst case 4.8 s). The tentative tail shows up sooner, around 1 s. A safety valve confirms anything that has gone 1.5 s without agreement, so a difficult passage cannot freeze the transcript.
- **Menu bar item (macOS).** Yapper spends a meeting behind the call it is recording, so starting and stopping it live next to the clock: one click to begin, one to stop, and a dot beside the mark while a recording is in the air. The icon is a template image, so it follows a light or dark menu bar instead of putting a coloured square up there.
- **Floating bubble.** At rest it is a **capsule** the size of its own clock: real audio level (the bars follow the captured signal, it is not an animation) plus a timer. Hovering opens it into the live transcript with controls; leaving turns it back into a capsule, with a pin to keep it open. Draggable, follows the light/dark theme. "Floating bubble" toggle, and **Bubble starts** picks which of the four corners it appears in — it does not remember being dragged, so that corner is where it lives for the meeting. Bottom left by default: the bottom right is the strip a video call fills with its own controls, and on a MacBook with a notch the top corners stay clear of it.
- **Knowing it is recording, and getting back.** The sidebar's *New meeting* button becomes *Recording — 12:34* with a pip while one is running, and it is also the route back to the stop control from Action items or Search. Nothing else on screen used to say a recording was in progress.
- **Meeting auto-detection.** Detects which app is holding the microphone (Zoom, Teams, Slack, Discord, Webex, and browser calls: Meet/Hangouts) and **sends a system notification**: one click starts recording, with no window to go hunting for. When Yapper is already in front of you, the prompt appears inside the app instead. "Auto-detect meetings" toggle. Works on both platforms — Windows reads the registry's consent store, macOS asks CoreAudio.
- **Optional local speaker detection on Windows and macOS 14+.** **Identify speakers** is off by default so the transcript finishes without waiting for the extra voice-analysis pass. Turn it on when stable local voice labels matter. Windows uses a pinned multithreaded sherpa-onnx executable; macOS uses Core ML, and both stay entirely on the machine. Two clearly optional fields stay separate: Participants records who attended without assigning voices; Match voices to names appears only after distinct voices were detected and records who said what. Generated notes preserve real names and every explicitly named action owner; only unknown voices become neutral prose, so they never read like “Speaker 1 said…” or “Speaker 2 decided…”. Disabled or unavailable detection falls back to the reliable `Me`/`Them` two-track transcript without showing an irrelevant matching panel.

The live preview is *only a preview*: on stop, the final transcript is redone with a full higher-quality pass, and the notes come from that.

## The engine and the tiers

Transcription runs on **whisper.cpp** (`whisper-server` on localhost). No Python, and no native Node modules to rebuild per platform: just loose binaries and `.bin` models.

On first launch Yapper **measures this machine** instead of guessing from the brand: it runs a few 10 s passes and stores the result in settings.

Anchors measured on the same PC with the calibration sample: RTX 4080 SUPER **75 ms**, i7-12700K CPU-only **736 ms**. On an M4 Pro with the Metal build, **102 ms** — comfortably in `fast`, which is exactly why Apple Silicon runs `balanced` instead: a pass costs so little that `fast` would keep the GPU busy 40% of the meeting, and the laptop hot.

| Tier | When | Live | Final | Measured lag |
|---|---|---|---|---|
| `fast` | a `base` pass ≤ 250 ms (GPU) | `small`, every 0.7 s | `small` | 2.6 s |
| `balanced` | the same, on Apple Silicon | `small`, every 1.5 s | `small` | ~3.5 s |
| `steady` | ≤ 1200 ms | `base`, every 2 s | `small` | 4.4 s |
| `modest` | slower than that | no live | `small` | — |

**`medium` is used nowhere**, despite transcribing better on paper. Live, its passes are so slow that two consecutive windows stop agreeing and less text gets confirmed. And in the final pass it falls into repetition loops on real meeting audio: on a minute of a noisy huddle it returned *"I'm not asking you to do it. I actually very much"* six times in a row, with and without beam search, where `small` transcribed the same thing cleanly. On clean speech (the JFK sample) both are fine; meetings are not clean speech.

If a machine turns out slower than it measured (busy CPU, another app on the GPU), live **stretches its own cadence** rather than falling further and further behind. On battery it starts at half the pace to begin with.

## Who writes the notes

Transcription is always local. The notes are not, and not everyone pays for the same model, so the provider is chosen in the app (**Notes by**):

| Provider | What it needs | Cost |
|---|---|---|
| **Claude Code** | the CLI installed and signed in (the Max subscription) | included |
| **Google Gemini** | free key from [aistudio.google.com](https://aistudio.google.com/apikey), **no card**, ~1 min | free |
| **OpenRouter** | your own key; its `:free` models do not charge | free or paid |
| **Ollama** | Ollama installed on the same machine | free and private |
| **Anthropic API** | your own key from console.anthropic.com | paid |
| **Other (OpenAI-compatible)** | any endpoint that speaks `/chat/completions` | depends on the endpoint |

That last row is deliberately the way forward: if this ends up a product with an official API, you add one entry in `llm.js` and that is it — the three places that generate notes (summary, regenerate, automatic title) stay untouched.

**Why there is no zero-configuration option.** There isn't one. Every hosted API needs a credential, and that credential comes from one of three places: baked into the app (abused within days, and against every provider's terms), served by a backend somebody pays for, or the user's own. The closest you can honestly get is **Gemini**: free, no card, and getting the key takes about a minute. The only genuinely credential-free alternative is running the model locally — hence the **Ollama** option for those who already have it.

**Careful with free tiers:** almost all of them train on what you send. The app says so on screen when you pick one, because a meeting transcript is not always yours to share. For confidential meetings: Claude Code, the paid API, or Ollama.

If the configured model stops existing (providers retire ids), **Test connection** asks the endpoint which models it does have and lists them in the error, instead of leaving you guessing.

The key is stored **encrypted with the system keystore** (DPAPI on Windows, Keychain on macOS), not as plain text inside `settings.json`, and never leaves the main process: the renderer only learns whether one exists. If the system has no keystore, the app says so instead of pretending it is protected.

There is a **Test connection** button that makes a minimal call and answers "working" or the real error (key rejected, no credit, model does not exist).

## One to two hour meetings

Measured end to end with a 2 h meeting on the `fast` tier (`build/test-two-hours.js`):

| Stage | 2 hours of audio |
|---|---|
| Recording | 220 MB on disk, 36,000 blocks written, nothing held in memory |
| Live | 2.2 s lag, without accumulating |
| Transcribing | 115 s (63× real time), +19 MB of memory |
| Transcript | 84 KB, 2,040 lines, last stamp at 1h59m |
| Notes | 73 s, every section, stamps up to minute 208 |
| Opening the meeting | 512 ms |
| Exporting | .md 8 KB · .txt 159 KB · PDF 133 KB in 497 ms |

**The audio is deleted once transcribed.** The transcript is the record: the notes come from it, it is what you read, search and export, and it is what gets kept. The audio exists to produce it and to survive a power cut along the way; once a transcript is on disk, the recording goes. That is 110 MB per hour which would otherwise be 4.8 GB a month for one daily meeting — and a recording of your colleagues is more sensitive than its transcript.

- The transcript is written first, the audio released after. A failure in between costs nothing.
- If transcription **fails**, the audio is kept so you can retry. That is exactly what it is for.
- **Keep this meeting's audio** keeps the audio of **that meeting and only that one**. It always starts off, and turns itself off — unticking on screen — the moment it has done its job. It is not a saved preference: switch it on before a sensitive meeting and you do not have to remember to switch it back.
- Meetings from before this change keep their audio. The app tells you how much they take and offers to release it (to the trash) when you ask — it does not delete your recordings on its own.

## How it works

1. **Record meeting** — captures the system audio (what you hear: Meet, Zoom, Teams…) **and** your microphone. A mixed track drives recovery and the live transcript, while aligned microphone/system tracks preserve which side spoke. Windows takes the system side from Electron's loopback; macOS uses a Core Audio process tap on 14.4+ and a ScreenCaptureKit fallback on macOS 13.
2. The audio is written to disk **as it arrives**, already in the format the transcriber consumes (16 kHz mono WAV). If the power goes out mid-meeting, what was recorded up to that point still plays and still transcribes.
3. **Stop and summarize** — a full windowed pass of whisper.cpp, then `claude -p` to generate the minutes.
4. Each meeting is a folder in `Documents/Meetings/YYYY-MM-DD_HHMM/`:
   - `recording.wav` — the audio
   - `transcript.txt` — the transcript with timestamps
   - `notes.md` — the generated minutes
   These are ordinary unencrypted files. Protect the account with FileVault or
   BitLocker, and check whether the operating system synchronizes `Documents`
   before recording sensitive material.
5. The sidebar lists past meetings; click to read the minutes again.

## Platforms

Everything above works on both. These are the differences that remain:

| | Windows | macOS |
|---|---|---|
| System audio | Electron loopback | Core Audio process tap; ScreenCaptureKit fallback on macOS 13 |
| Meeting detection | registry consent store | CoreAudio process list |
| Speaker labels | `Me` + optional locally separated remote voices; `Me`/`Them` by default | `Me` + optional locally separated remote voices on macOS 14+; `Me`/`Them` by default |
| Updates | downloads and installs itself | downloads and installs itself |
| Install | signed-by-nobody NSIS installer | Developer ID signed + Apple-notarized `.dmg` |
| Hardware | x64 | Apple Silicon only |

**macOS permissions.** The first recording asks for the microphone, and for **System Audio Recording Only** — the permission that lets Yapper hear the other side of the call, granted in System Settings › Privacy & Security, after which the app must be reopened. It does exactly what its name says: system audio through a Core Audio process tap, no screen and no other app's data. On macOS 13, where that permission does not exist, Yapper falls back to ScreenCaptureKit and has to ask for **Screen Recording** instead; no screen content is ever read there either, the video side being reduced to 2×2 pixels once a second and thrown away. Without either, Yapper records the microphone alone and says so on screen.

**On macOS 13, the screen stays awake while recording.** That fallback uses
ScreenCaptureKit, which offers no capture source while the screen sleeps. On
14.4+ the Core Audio process tap needs no display and the Mac may dim normally.

macOS release builds require the Developer ID identity and a validated
`notarytool` profile; `mac/build-app.sh` refuses to continue without both. The
resulting dmg is signed, hardened and notarized, and updates install through
`electron-updater`. The command-line installer remains available as an
alternative:

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
```

`mac/install.sh` verifies the zip against the sha512 in the release manifest,
then checks the Developer ID Team ID, notarization ticket and Gatekeeper before
installing. It never clears quarantine. The engine is not re-downloaded — it lives in
`~/Library/Application Support/yapper`, outside the bundle — so an update is
~95 MB, not another 650 MB, and meetings and granted permissions survive it.

Note for whoever cuts a release: electron-builder writes one manifest per platform, `latest.yml` from the Windows build and `latest-mac.yml` from the mac one. Both belong on the release, and `mac/build-app.sh` uploads the mac one with the dmg — a release published from only one platform would otherwise tell the other's users that nothing is new.

## Importing voice notes

Any format Chromium can decode (mp3, m4a, opus, flac, ogg, wav, mp4…) is converted inside the app into the WAV the transcriber uses. No ffmpeg, no extra dependency: the codecs already ship inside Electron.

An imported voice note gets **the same treatment as a recorded meeting**: transcript, notes and automatic title. If the file has a generic name (`recording`, `New Recording 3`, `WhatsApp Audio…`, or just a date), the model titles it from what was said, instead of calling the meeting "recording".

Measured with real files: a 2.5 min `.m4a` takes 3 s end to end; a 24 min `.webm`, 27 s.

## Usage

```
npm start
```

or the **Yapper** shortcut on the desktop (Windows) / in Applications (macOS).

## Note options

- **Note style**: General, Minutes, **Memo**, Stand-up, 1:1, Client call, Brainstorm — changes the sections of the minutes. *Memo* is meant for forwarding to someone who was not there: prose instead of bullets, neutral language, and it says explicitly when something was discussed but not decided.
- **Settings categories**: Notes, Recording, During meetings and App split the full option set into four tabs without duplicating or removing controls. The same groups remain available under **Meeting options** on New meeting.
- **Spoken language**: the frequent selector sits beside the microphone on New meeting and is synchronized with its canonical control under Settings → Recording.
- **Detail**: Concise (short bullets) or Detailed (exhaustive).
- **Extra instructions**: free-form context for Claude (attendees, project, what to focus on).
- **Participants**: the names are passed to Whisper as an initial prompt, so it can preserve names such as "Maya" accurately. It belongs to **that meeting**, not to your preferences: the field starts empty every time, so last week's names cannot leak into today's minutes.
- **Deleting meetings**: every sidebar row has a bin that appears on hover. Failed recordings (no audio) are dimmed and labelled *Empty recording*. It always asks first, listing what the folder holds, and it goes to the system trash — it never deletes audio irreversibly.
- **↻ Regenerate**: redoes the notes of any saved meeting with a different style/detail.
- **Automatic title**: if you do not type a title, the same model response that writes the notes also names the meeting from what was discussed (2-6 words); if the recording is too thin for that, it falls back to the date. This avoids waiting for a second model request.
- **Progressive notes**: after transcription, the meeting opens immediately and the cards fill in as the provider writes them. A small local timing line separates transcription, first note, and completion time.
- **Cancelable generation**: while notes are being written, Regenerate becomes **Cancel**. It stops the model request itself; the transcript remains safe and a canceled rewrite restores the previous complete notes.
- **Personal action list**: action items remain visible in every meeting, but none are copied into your list automatically. Use **+ my list** on only the items that belong to you; repeated selections of the same task fold into one row.
- **Export** (menu): notes as a flowing PDF with the meeting name and date, notes as Markdown, **the full transcript as Markdown** (bold timestamps, new paragraph after a minute of silence), transcript as .txt, or notes + transcript in a single .md.
- **Start with Windows** / **Start at login**: launches Yapper when you sign in. On Windows it is on by default; on macOS it is off until you switch it on, works only from an Applications folder on the startup disk (checked by which mounted volume it is really on, not by the folder's name — a home on an external or network disk does not count), and the switch shows what macOS did rather than what was asked — it can need allowing in System Settings, and a copy running from the dmg or from Downloads cannot register at all.
- **Language**: English by default; Español or *As spoken* switch the body of the notes (the section headings stay in English, the app reads them). The notes are shown as colour-coded cards: Summary (violet), Key points (cyan), Decisions (green), Action items (amber), Open questions (pink), Blockers/Risks (red), Next steps (teal).

## Sharing with colleagues

**Windows**

1. Copy the project folder (without `node_modules`, `bin` or `models` if you want it small: setup downloads those).
2. On the new PC: install Node (`winget install OpenJS.NodeJS.LTS`) if it is not there.
3. Run `powershell -ExecutionPolicy Bypass -File setup.ps1` — downloads the whisper.cpp engine (and the CUDA build if there is an NVIDIA GPU), the models, installs Electron and creates the shortcut.

**macOS** — for a signed/notarized release:

1. Hand over the `.dmg` from [yapper-releases](https://github.com/iamchuck504/yapper-releases/releases/latest), or build one with `bash mac/build-app.sh`.
2. Drag Yapper to Applications and open it normally. Gatekeeper can verify the
   Developer ID signature and Apple's notarization ticket.
3. First launch downloads the engine and models (~600 MB) with progress on
   screen. Nothing else to install.
4. The first recording asks for the **microphone** and for **Screen Recording**.
   The second one has to be granted in System Settings and the app reopened;
   without it only the microphone is captured, and the app says so.

**Requirements for that Mac:** Apple Silicon, macOS 13 or newer. Meeting
auto-detection needs macOS 14.4 (the CoreAudio process list it reads did not
exist before), and without it the app simply never offers to record on its own.
Both helpers are pinned to those versions at build time — building on a beta
otherwise produces binaries that only run on that beta.

Either way, each person picks their own note provider in the app: their own Claude Code session, or their own key. Recording and transcription work without any of that.

The app warns on launch if a requirement is missing. If a transcription fails or is interrupted, the recording is never lost: the meeting stays "not transcribed" in the sidebar and a **Transcribe now** button recovers it.

## Requirements

- Node + Electron (in `node_modules`)
- whisper.cpp in `bin/` and models in `models/` (downloaded by `setup.ps1`, by `mac/build-app.sh`, or by the app itself on first run)
- For the notes: Claude Code signed in, **or** an API key in settings
- Windows packaging downloads two pinned, SHA-256-verified sherpa-onnx archives (~65 MB compressed) and keeps only the native runner, its runtime libraries and the two speaker models. The installed app performs speaker detection offline.
- macOS only: Xcode Command Line Tools, for `swiftc`/SwiftPM to build the native helpers. Full Xcode is not needed.

## Optional configuration (environment variables)

- `YAPPER_LANG` — forces the transcription language (`es`, `en`); autodetected by default.
- `YAPPER_HOME` — puts everything the app writes (settings, meetings, the engine) under one directory, so a second copy can run without touching the real one. `build/packaged-launch-check.sh` uses it to start the packaged app against scratch storage.
- `YAPPER_LIVE_DEBUG=1` — prints one line per live pass (cost, buffer size, how many words agreed and how many were confirmed).
- `WAV` — points the heavier tests at a specific audio file instead of the generated fixture.

## The icon

The original artwork comes with its corners filled black instead of transparent. `build/icon-cut.js` cuts them out and generates everything the app uses:

```
node_modules/electron/dist/electron.exe build/icon-cut.js [build/icon-source.png]     # Windows
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/icon-cut.js     # macOS
```

- `build/yapper-icon.ico` — what the window and the shortcut use on Windows (16, 24, 32, 48, 64, 128 and 256 px, each resampled from the original rather than scaled down from the big one).
- `build/yapper-icon.png` — the cut-out artwork at full size.
- `build/yapper-icon-dark.png` — the same mark inverted, amber on ink, written by `build/icon-dark.js`. **This is the macOS icon.** macOS 26 runs legacy `.icns` files through an appearance pass that darkens the tile and keeps the artwork, so a near-black mark on amber arrives in the dock as a black slab; an amber mark survives it in either appearance.
- `renderer/app-mark.png` — the splash mark, so there is no separate drawing to go stale.

It does not delete "the black pixels": the mark is the same black, so that would hollow it out. It floods the black **inwards from the four corners**, which follows the real curve of the artwork and cannot reach the mark, because the mark does not touch the edge. The anti-aliased seam is recomputed: how much body colour each pixel holds becomes its alpha, so no one-pixel dark halo is left behind.

Inside the `.ico`, sizes up to 128 go as **classic DIB** and only 256 as PNG. Chromium reads PNG fine, but the Windows shell — what draws the desktop and the taskbar — is older and fussier; with PNG at every size the icon shows inside the app and not outside it.

`icon-verify.js` checks the corners, that the mark is intact, that there is no halo, and that each `.ico` entry has the format it should; it also leaves a preview over light, dark and checkerboard backgrounds in `build/icon-preview.png`.

**Shortcuts repair themselves.** A `.lnk` stores its own copy of the icon path, so changing the app's icon moves nothing on the desktop or the taskbar until it is rewritten — and nobody re-runs `setup.ps1` after an update. On launch the app checks the desktop shortcut, the pinned taskbar one and the Start menu one, and rewrites only those that are stale. While it is there it gives them the same AppUserModelID the window uses, so Windows does not treat the pinned button and the running app as two different programs. macOS has no equivalent: the icon lives in the bundle.

## Tests

```
npm test                          # everything that runs without a model or a GPU
npm run test:windows              # Windows: pure suite plus isolated Electron sanity checks
npm run test:windows:package      # the same checks, then build and verify the Windows installer
```

Individual suites, with plain node:

```
node build/test-llm.js               # note providers, against a fake server
node build/test-keystore.js          # the key is not left readable (with electron it uses the real keystore)
node build/test-live-logic.js        # live confirmation rules
node build/test-meetings.js          # deletion cannot escape the meetings folder
node build/test-meeting-detect.js    # which app counts as a meeting, on both platforms
node build/test-platform-parity.js   # the Windows assumptions that break on macOS
node build/test-sysaudio.js          # mixing system audio into the microphone
node build/test-section-coverage.js  # every style has a button and every section a colour
node build/test-ipc-wiring.js        # every preload channel has a counterpart
node build/test-bounds.js            # the bubble never leaves the screen
node build/test-engine.js            # starts the server and measures a pass
node build/test-steady-cpu.js        # the steady tier holds up without a GPU
node build/tune-live.js              # replays real audio comparing configurations
```

The ones that open a window run under Electron. The binary differs by platform:

```
node_modules/electron/dist/electron.exe build/test-smoke.js                     # Windows
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron build/test-smoke.js   # macOS
```

Worth running: `test-bubble-corner.js`, `test-recording-signpost.js`, `test-sys-meter.js`, `test-tray.js`, `test-screen-prompt.js`, `test-record-cycle.js`, `test-record-recovery.js`, `test-notes-cancel.js`, `test-smoke.js`, `icon-verify.js`, `test-splash-mark.js`, `test-bubble-fit.js`, `test-keystore.js`, `test-llm-ui.js`, `test-delete-ui.js`, `test-options-ui.js`, `test-import.js`, `test-memo.js`, `test-styles.js`, `test-stamps.js`, and on macOS `probe-system-audio.js`.

The heavier ones want an audio fixture. `node build/make-fixtures.js` builds it from the calibration sample that ships with the repo, so they no longer depend on clips cut from someone's real meetings — point `WAV=` at real audio when the words themselves matter.

`test-record-cycle.js` is the full recording cycle: it feeds real audio through the same IPC the microphone uses, pauses halfway to check that **nothing is written** while paused, and on stop verifies the closed WAV, the transcript, the notes, the marker and how it looks in the sidebar. The only thing it does not cover is the Web Audio graph, which needs a microphone and a person.

`test-record-recovery.js` forces the two failures that will happen on a colleague's machine (capture denied, and the device disappearing mid-start) and checks the app recovers — asserting each platform's own promise, since a denied screen capture stops a recording on Windows and must not on macOS. `test-smoke.js` walks the whole interface listening for renderer errors, which otherwise go unseen: a button simply stops working.

`probe-system-audio.js` is the macOS one worth knowing about: it mutes the output, plays a clip and records. A muted Mac gives the microphone nothing to hear, so signal left in the file proves the capture path — energy alone would prove nothing, since the microphone hears the speakers too.

The ones that boot the app run against temporary folders, never your real meetings. They share `build/harness.js`, which resolves a race they all had: waiting for `did-finish-load` **after** finding the window hangs the test forever if the page had already loaded. `test-llm-ui.js` saves a key and checks it appears neither in `settings.json` nor back in the renderer; `test-delete-ui.js` verifies that cancelling does not delete, that only the chosen row is deleted and that the warning lists what would be lost; `test-import.js` imports a real `.m4a` and `.webm` and checks the resulting WAV is genuinely playable (header, 16 kHz mono, and not silent).

`test-memo.js`, `test-styles.js` and `test-stamps.js` do spend model calls. `test-styles.js` is the consistency check: it runs **every** style against the same transcript and compares the sections returned with the ones that style asked for — that it invents none, that it starts with the right one, and that the interface knows how to colour them all. It is the one that found *Minutes* returning its sections without timestamps; `test-stamps.js` repeats the most prone styles several times to confirm it no longer happens.

Note: they write progress to a `progress.log` as well as stdout, because Electron on Windows does not flush its output until the process exits, and a run of seven model calls takes about ten minutes.

## Notes

- The first transcription after booting takes a little longer (loading the model).
- On a long meeting, CPU transcription can take several minutes; the app shows live progress.
- On macOS, system audio needs the Screen Recording permission; without it only the microphone is recorded, and the app says so.
