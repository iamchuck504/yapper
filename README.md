# Yapper

A desktop app for meetings: it records the call, transcribes it **on your own
machine** with Whisper, and turns the transcript into a structured markdown
write-up — summary, key points, decisions, action items. The audio never leaves
the device. Only text is sent for the notes, and only to the provider you pick,
which can be a model running locally if you want nothing to leave at all.

> Architecture and build structure: **[ARCHITECTURE.md](ARCHITECTURE.md)**.
>
> **Manual with screenshots and an honest assessment** (what it does well, what
> it is missing, and how it stacks up against the commercial options):
> **[docs/MANUAL.md](docs/MANUAL.md)**.
>
> **To install without cloning anything:** the installer lives in
> [yapper-releases](https://github.com/iamchuck504/yapper-releases/releases/latest)
> (a public installers-only repo; the code stays here, private). It installs per
> user, downloads the engine on first launch only, and auto-updates from that
> feed. To publish a new version: bump `version` in `package.json` and run
> `npm run release`.

## Live transcription

- **Streaming transcript.** The renderer sends continuous PCM; `live.js` keeps a
  rolling 12 s buffer and re-transcribes it every ~0.7 s. A word is only
  "confirmed" once two consecutive passes agree (LocalAgreement-2); the tentative
  tail is shown dimmed and corrects itself. Long pauses start a new paragraph.
- **How far behind it runs.** Measured by replaying a minute of a real meeting at
  wall-clock speed on an RTX 4080 SUPER: **2.6 s median** between something being
  said and it being confirmed (4.8 s worst case). The tentative tail shows up
  earlier, around 1 s. A safety valve confirms anything that has gone 1.5 s
  without agreement, so a difficult passage cannot freeze the transcript.
- **Floating bubble.** At rest it is a **capsule** the size of its own clock: real
  audio level (the bars move with the captured signal — it is not an animation)
  plus a timer. Hovering expands it to the live transcript with the controls;
  leaving collapses it back, and a pin keeps it open. Draggable, follows the
  light/dark theme. Toggle: "Floating bubble".
- **Meeting auto-detection.** It detects which app is using the microphone (Zoom,
  Teams, Slack, Discord, Webex, and browser calls: Meet/Hangouts) and **fires a
  system notification**: one click starts recording, with no hunting for the
  window. When Yapper is already in front, the prompt appears inside the app.
  Toggle: "Auto-detect meetings". Windows only for now; macOS gets it with the
  audio rework.

The live preview is *only a preview*: on stop, the final transcript is redone
with a full, higher-quality pass, and that is what the notes are built from.

## The engine and the tiers

Transcription runs on **whisper.cpp** (`whisper-server` on localhost). No Python,
no native Node modules to rebuild per platform: just standalone binaries and
`.bin` models.

On first launch, Yapper **measures this machine** instead of guessing from the
brand name: it runs a few 10 s passes and stores the result in settings.

Anchors measured on the same PC with the calibration sample: RTX 4080 SUPER
**75 ms**, i7-12700K CPU-only **736 ms**.

| Tier | When | Live | Final | Measured lag |
|---|---|---|---|---|
| `fast` | `base` pass ≤ 250 ms (GPU) | `small`, every 0.7 s | `small` | 2.6 s |
| `steady` | ≤ 1200 ms | `base`, every 2 s | `small` | 4.4 s |
| `modest` | slower than that | no live | `small` | — |

**`medium` is not used anywhere**, even though on paper it transcribes better.
Live, its passes are so slow that two consecutive windows no longer agree and
less text gets confirmed. And on the final pass it falls into repetition loops on
real meeting audio: in one minute of a noisy huddle it returned *"I'm not asking
you to do it. I actually very much"* six times in a row, with and without beam
search, where `small` transcribed the same stretch cleanly. On clean speech (the
JFK sample) both do fine; meetings are not clean speech.

If a machine turns out slower than it measured (battery, busy CPU, another app on
the GPU), the live pass **stretches its own cadence** instead of falling further
and further behind.

## Who writes the notes

Transcription is always local. The notes are not, and not everyone pays for the
same model, so the provider is chosen in the app (**Notes by**):

| Provider | What it needs | Cost |
|---|---|---|
| **Claude Code** | the CLI installed and signed in | included in your plan |
| **Google Gemini** | a free key from [aistudio.google.com](https://aistudio.google.com/apikey), **no credit card**, ~1 min | free |
| **OpenRouter** | your own key; their `:free` models do not bill | free or paid |
| **Ollama** | Ollama installed on the same machine | free and private |
| **Anthropic API** | your own key from console.anthropic.com | paid |
| **Other (OpenAI-compatible)** | any endpoint that speaks `/chat/completions` | depends on the endpoint |

That last row is deliberately the way forward: if this ever becomes a product
with an official API, it is one more entry in `llm.js` and nothing else — the
three places that generate notes (summary, regenerate, auto-title) stay
untouched.

**Why there is no zero-setup option.** There isn't one. Every hosted API needs a
credential, and that credential comes from one of three places: shipped inside
the app (abused within days, and against every provider's terms), served by a
backend somebody pays for, or the user's own. The closest honest option is
**Gemini**: free, no card, and getting the key takes about a minute. The only
genuinely credential-free alternative is running the model locally — hence
**Ollama** for anyone who already has it.

**A word on free tiers:** almost all of them train on what you send. The app says
so on screen when you pick one, because a meeting transcript is not always yours
to share. For confidential meetings: Claude Code, a paid API, or Ollama.

If the configured model stops existing (providers retire ids), **Test
connection** asks the endpoint which models it does have and lists them in the
error, instead of leaving you guessing.

The key is stored **encrypted with the system keyring** (DPAPI on Windows,
Keychain on macOS), not in plaintext inside `settings.json`, and it never leaves
the main process: the renderer only learns whether one exists. If the system has
no keyring, the app says so instead of pretending to be protected.

There is a **Test connection** button that makes a minimal call and answers
"working" or the real error (key rejected, no credit, model does not exist).

## One- to two-hour meetings

Measured end to end with a 2 h meeting on the `fast` tier
(`build/test-two-hours.js`):

| Stage | 2 hours of audio |
|---|---|
| Record | 220 MB on disk, 36,000 blocks written, nothing held in memory |
| Live | 2.2 s lag, no drift |
| Transcribe | 115 s (63× realtime), +19 MB memory |
| Transcript | 84 KB, 2,040 lines, last stamp at 1h59m |
| Notes | 73 s, every section, stamps out to minute 208 |
| Open the meeting | 512 ms |
| Export | .md 8 KB · .txt 159 KB · PDF 133 KB in 497 ms |

**Audio is deleted once transcribed.** The transcript is the record: it is what
the notes come from, what you read, search and export, and what gets kept. The
audio exists to produce it and to survive a power cut along the way; once the
transcript is on disk, the recording goes. That is 110 MB per hour which would
otherwise be 4.8 GB a month for one daily meeting — and a recording of your
colleagues is more sensitive than its transcript. another meeting-notes app takes the same posture:
it never stores audio at all.

- The transcript is written first, then the audio is released. A failure in
  between costs nothing.
- If transcription **fails**, the audio is kept so it can be retried. That is
  exactly what it is there for.
- **Keep this meeting's audio** keeps the audio for **that meeting and only that
  one**. It always starts off, and turns itself off — unchecking on screen — as
  soon as it has done its job. It is not a saved preference: switch it on before
  a sensitive meeting and you do not have to remember to switch it back.
- Meetings from before this change keep their audio. The app tells you how much
  space they take and offers to free it (to the recycle bin) when you ask — it
  does not delete your recordings on its own.

## How it works

1. **Record meeting** — captures system audio (what you hear: Meet, Zoom,
   Teams…) via Windows loopback **and** your microphone, mixed into one stream.
2. Audio is written to disk **as it arrives**, already in the format the
   transcriber consumes (WAV 16 kHz mono). If the power goes out mid-meeting,
   what was recorded up to that point still plays and still transcribes.
3. **Stop and summarize** — a full windowed whisper.cpp pass, then the configured
   provider generates the write-up.
4. Each meeting lands in `Documents\Meetings\YYYY-MM-DD_HHMM\`:
   - `recording.wav` — the audio
   - `transcript.txt` — the transcript with timestamps
   - `notes.md` — the generated notes
5. The sidebar lists previous meetings; click to open the notes again.

## Importing voice notes

Any format Chromium can decode (mp3, m4a, opus, flac, ogg, wav, mp4…) is
converted inside the app to the WAV the transcriber uses. No ffmpeg, no extra
dependency: the codecs already ship inside Electron.

An imported voice note gets **the same treatment as a recorded meeting**:
transcript, notes and auto-title. If the file is named something generic
(`recording`, `New Recording 3`, `WhatsApp Audio…`, or just a date), the model
titles it from what was actually said, instead of calling the meeting
"recording".

Measured with real files: a 2.5 min `.m4a` takes 3 s end to end; a 24 min
`.webm`, 27 s.

## Usage

```
npm start
```

or the **Yapper** shortcut on the Desktop.

## Note options

- **Note style**: General, Minutes, **Memo**, Stand-up, 1:1, Client call,
  Brainstorm — changes the sections in the write-up. *Memo* is meant for
  forwarding to someone who was not there: prose instead of bullets, neutral
  language, and it says explicitly when something was discussed but not decided.
- **Detail**: Concise (short bullets) or Detailed (exhaustive).
- **Extra instructions**: free-form context for the model (attendees, project,
  what to focus on).
- **Participants**: the names are passed to Whisper as an initial prompt, so it
  stops writing "Maya" as "Nympho". This is **per meeting**, not a preference:
  the field starts empty every time, so last week's names cannot leak into
  today's write-up.
- **Deleting meetings**: every sidebar row has a trash icon that appears on
  hover. Failed recordings (no audio) are dimmed and labelled *Empty recording*.
  It always asks first, listing what would be lost, and it goes to the system
  recycle bin — it never deletes audio irreversibly.
- **↻ Regenerate**: redoes the notes for any saved meeting with a different
  style or detail level.
- **Auto-title**: if you do not type a title, the model names the meeting from
  what was said (2–6 words); if the recording is too thin for that, it falls back
  to the date.
- **Export** (menu): notes as PDF, notes as Markdown, **full transcript as
  Markdown** (bold timestamps, new paragraph after a minute of silence),
  transcript as .txt, or notes plus transcript in a single .md.
- **Start with Windows**: launches Yapper at sign-in (on by default, switched off
  from the toggle).
- Notes come out **in English** and are shown as colour-coded cards: Summary
  (violet), Key points (cyan), Decisions (green), Action items (amber), Open
  questions (pink), Blockers/Risks (red), Next steps (teal).

## Sharing with colleagues

1. Copy the project folder (without `node_modules`, `bin` or `models` if you want
   it small: setup downloads them).
2. On the new PC: install Node (`winget install OpenJS.NodeJS.LTS`) if it is not
   there.
3. Run `powershell -ExecutionPolicy Bypass -File setup.ps1` — it downloads the
   whisper.cpp engine (and the CUDA build if there is an NVIDIA GPU), the models,
   installs Electron and creates the shortcut.
4. For notes, everyone picks their own provider in the app: their own Claude Code
   session, or their own key. Recording and transcription work without any of
   that.

The app warns at startup if a requirement is missing. If a transcription fails or
is interrupted, the recording is never lost: the meeting shows as "not
transcribed" in the sidebar and a **Transcribe now** button recovers it.

## Requirements

- Node + Electron (in `node_modules`)
- whisper.cpp in `bin/` and models in `models/` (downloaded by `setup.ps1`)
- For notes: Claude Code signed in, **or** an API key in settings

## Optional configuration (environment variables)

- `YAPPER_LANG` — forces the transcription language (`es`, `en`); auto-detected
  by default.
- `YAPPER_LIVE_DEBUG=1` — prints one line per live pass (cost, buffer size, how
  many words agreed and how many were confirmed).

## The icon

The original art ships with its corners filled in black rather than transparent.
`build/icon-cut.js` trims them and generates everything the app uses:

```
node_modules\electron\dist\electron.exe build\icon-cut.js [build\icon-source.png]
node_modules\electron\dist\electron.exe build\icon-verify.js
```

- `build/yapper-icon.ico` — what the window and the shortcut use (16, 24, 32, 48,
  64, 128 and 256 px, each resampled from the original rather than scaled down
  from the largest).
- `build/yapper-icon.png` — the trimmed art at full size.
- `renderer/app-mark.png` — the splash mark, so there is no separate drawing that
  can go stale.

It does not delete "the black pixels": the mark is the same black, so that would
hollow it out. It floods the black **inward from the four corners**, which
follows the real curve of the art and cannot reach the mark, because the mark
does not touch the edge. The antialiased edge is recomputed: how much body colour
each pixel holds becomes its alpha, so there is no one-pixel dark halo left
behind.

Inside the `.ico`, sizes up to 128 go in as **classic DIB** and only 256 as PNG.
Chromium reads PNG without complaint, but the Windows shell — what draws the
desktop and the taskbar — is older and fussier; with PNG at every size the icon
shows up inside the app and not outside it.

`icon-verify.js` checks the corners, that the mark is still intact, that there is
no halo, and that each `.ico` entry has the format it should; it also leaves a
preview over light, dark and checkerboard backgrounds in
`build/icon-preview.png`.

**Shortcuts repair themselves.** A `.lnk` stores its own copy of the icon path,
so changing the app icon moves nothing on the desktop or the taskbar until it is
rewritten — and nobody re-runs `setup.ps1` after an update. At startup the app
checks the desktop shortcut, the pinned taskbar one and the start menu one, and
rewrites them only if they are out of date. While it is there, it gives them the
same AppUserModelID the window uses, so Windows does not treat the pinned button
and the running app as two different programs.

## Tests

```
npm test                          # everything that runs without a model or GPU
```

```
node build\test-llm.js            # note providers, against a fake server
node build\test-keystore.js       # the key is never left readable (with electron, real keyring)
node build\test-live-logic.js     # live confirmation rules
node build\test-meetings.js       # deletion cannot escape the meetings folder
node build\test-section-coverage.js  # every style has a button, every section a colour
node build\test-ipc-wiring.js     # every preload channel has a counterpart
node build\test-bounds.js         # the bubble never leaves the screen
node build\test-engine.js         # starts the server and times one pass
node build\test-steady-cpu.js     # the steady tier holds up without a GPU
node build\tune-live.js           # real-audio replay comparing configurations
```

The ones that open a window run under Electron:

```
node_modules\electron\dist\electron.exe build\test-record-cycle.js
node_modules\electron\dist\electron.exe build\test-record-recovery.js
node_modules\electron\dist\electron.exe build\test-smoke.js
node_modules\electron\dist\electron.exe build\icon-verify.js
node_modules\electron\dist\electron.exe build\test-splash-mark.js
node_modules\electron\dist\electron.exe build\test-bubble-fit.js
node_modules\electron\dist\electron.exe build\test-keystore.js
node_modules\electron\dist\electron.exe build\test-llm-ui.js
node_modules\electron\dist\electron.exe build\test-delete-ui.js
node_modules\electron\dist\electron.exe build\test-options-ui.js
node_modules\electron\dist\electron.exe build\test-import.js
node_modules\electron\dist\electron.exe build\test-memo.js
node_modules\electron\dist\electron.exe build\test-styles.js
node_modules\electron\dist\electron.exe build\test-stamps.js
```

`test-record-cycle.js` is the full recording cycle: it pushes real audio through
the same IPC the microphone uses, pauses halfway to check that **nothing is
written** while paused, and on stop verifies the closed WAV, the transcript, the
notes, the marker and how the row ends up in the sidebar. The only thing it does
not cover is the Web Audio graph, which needs a microphone and a person.

`test-record-recovery.js` forces the two failures that will happen on a
colleague's machine (capture denied, and the device disappearing mid-startup) and
checks that the app recovers. `test-smoke.js` walks the whole interface listening
for renderer errors, which are otherwise invisible: a button simply stops
working.

The ones that launch the app do so against temporary folders, never against your
real meetings. They share `build/harness.js`, which resolves a race they all had:
waiting for `did-finish-load` **after** finding the window hangs the test forever
if the page had already loaded. `test-llm-ui.js` saves a key and checks it
appears neither in `settings.json` nor back in the renderer; `test-delete-ui.js`
verifies that cancelling does not delete, that only the chosen row is deleted,
and that the warning lists what would be lost; `test-import.js` imports a real
`.m4a` and a real `.webm` and checks the resulting WAV is genuinely playable
(header, 16 kHz mono, and not silent).

`test-memo.js`, `test-styles.js` and `test-stamps.js` do spend model calls.
`test-styles.js` is the consistency check: it runs **every** style against the
same transcript and compares the sections it returns with the ones that style
asked for — that it invents none, that it starts with the right one, and that the
interface knows how to colour them all. It is the one that caught *Minutes*
returning its sections without a timestamp; `test-stamps.js` repeats the most
prone styles several times to confirm it no longer happens.

Note: they write progress to a `progress.log` as well as stdout, because Electron
on Windows does not flush its output until the process exits, and a run of seven
model calls takes about ten minutes.

## Notes

- The first transcription after booting the PC takes a little longer (model
  load).
- For a long meeting, CPU transcription can take several minutes; the app shows
  live progress.
- System audio requires Windows (Electron `audio: 'loopback'`).
