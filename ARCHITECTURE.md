# Yapper — architecture and build structure

A desktop meeting-notes app: it records a call, transcribes it **on the machine**
and turns the transcript into notes with a language model. Audio never leaves the
device; only text is sent, and only to the provider the user picked.

This document is for reviewing how it is put together. `README.md` is the
user-facing guide (in Spanish).

## Where to start

```
git clone <repo> && cd yapper
powershell -ExecutionPolicy Bypass -File setup.ps1     # engine + models, ~600 MB
npm start
npm test                                               # no model or GPU needed
```

Reading order for a review, shortest useful path first:

1. **`preload.js`** (80 lines) — the entire boundary between the privileged and
   unprivileged halves. If something is not in here, the UI cannot do it.
2. **`engine.js` §"tiers"** — the performance contract, with the measurements it
   is based on in the comments.
3. **`live.js`** — the only genuinely subtle algorithm in the app.
4. **`main.js`** — grouped by concern with section headers; skim the headers.
5. **§8 below** — the decisions that look wrong until you see the numbers.

```
yapper/
├── main.js  engine.js  live.js  llm.js  keystore.js  bounds.js  preload.js
├── renderer/            all three windows, plus fonts and the audio worklet
├── build/               tests, icon pipeline, and the calibration sample
├── setup.ps1            provisioning: engine, models, Electron, shortcut
├── bin/    models/      downloaded, gitignored
├── README.md            user guide
└── ARCHITECTURE.md      this file
```

---

## 1. Constraints it was built around

These shaped most of the decisions below, so they are worth stating first.

| Constraint | Consequence |
|---|---|
| **Audio never leaves the machine** | Transcription is local (whisper.cpp). The only thing that goes out is the transcript, to generate notes. |
| **Never lose a transcript** | Audio is written to disk as it arrives, already in the format the transcriber reads, so a power cut costs the tail of a meeting rather than the meeting. Once a transcript exists the audio has done its job and is released (§9b). Deleting a meeting goes to the recycle bin. |
| **Nothing to compile on the user's machine** | No native Node modules, no Python, no bundler, no transpiler. One npm devDependency. |
| **It has to work on a laptop, not just a workstation** | The app measures the machine on first launch and picks what it can promise from the result (§7). |

---

## 2. Runtime topology

```
                        ┌──────────────────────────────────────┐
                        │  main process  (main.js)             │
                        │  windows · IPC · files · settings    │
                        └───┬───────────┬──────────┬───────────┘
       preload.js (bridge)  │           │          │
    ┌───────────────────────┴──┐        │          │
    │ renderer  (renderer/)    │        │          │
    │  ├─ index.html  main UI  │        │          │
    │  ├─ bubble.html  overlay │        │          │
    │  └─ splash.html  boot    │        │          │
    │  Web Audio graph + PCM   │        │          │
    └──────────────────────────┘        │          │
                                        │          │
                     whisper-server ◄───┘          └──► notes provider
                     (child process,                    claude CLI (child)
                      HTTP on localhost)                or HTTPS to an API
```

- **Only the renderer touches audio hardware.** Capture, mixing, gain, filtering
  and the level meters live in the Web Audio graph. It hands the main process
  16 kHz mono PCM and nothing else.
- **Only the main process touches the disk, the network and child processes.**
  The renderer has no Node access (`contextIsolation: true`,
  `nodeIntegration: false` on every window) and reaches everything through the
  preload bridge.
- **whisper-server is a long-lived child**, not a per-request spawn: the live
  transcript re-decodes a rolling window about once a second, and loading the
  model each time would cost more than the inference.

---

## 3. Module map

Application code, 6,500 lines total. No framework, no build step — the files
that ship are the files that run.

### Main process

| File | Lines | Responsibility |
|---|---:|---|
| `main.js` | 1525 | Windows, the whole IPC surface, meeting files, settings, meeting auto-detection, note prompts, shortcut upkeep |
| `engine.js` | 620 | whisper.cpp lifecycle, the tier table, calibration, WAV read/write, full-file transcription |
| `llm.js` | 322 | Note providers (§6) behind one `generate()` call |
| `live.js` | 287 | Live transcription: rolling window, LocalAgreement-2 confirmation |
| `keystore.js` | 39 | Sealing the API key with the OS keystore |
| `bounds.js` | 34 | Pure geometry: keeping the floating bubble on screen |
| `preload.js` | 80 | The only bridge between renderer and main |

`keystore.js` and `bounds.js` are separate files for one reason: they are pure
functions, so they can be tested without booting Electron, and `keystore.js`
takes `safeStorage` as an argument so the "no keystore available" path is
reachable in a test.

### Renderer

| File | Lines | Responsibility |
|---|---:|---|
| `renderer/app.js` | 1868 | Main window: capture graph, views, notes rendering, exports, reminders, settings |
| `renderer/style.css` | 1218 | Everything visual, light and dark |
| `renderer/index.html` | 318 | Main window markup |
| `renderer/bubble.html` | 188 | The always-on-top live transcript overlay |
| `renderer/bubble.js` | 125 | Its behaviour, including sizing itself to its own controls |
| `renderer/splash.html` | 104 | Boot screen, including the first-run calibration status |
| `renderer/pcm-worklet.js` | 33 | The audio-thread tap that produces PCM |

`app.js` is the largest file and the obvious candidate for splitting. It is
organised in labelled sections (capture, live preview, recording, meeting view,
exports, reminders, settings) but it is one module.

---

## 4. Data flow

### Recording

```
system audio (loopback) ─┐
                         ├─► gain ─► high-pass ─► low-pass ─┬─► level meters
microphone(s) ───────────┘                                  └─► PCM tap
                                                                  │ 16 kHz mono
                                                                  │ 200 ms blocks
                                                    'recording-chunk' (IPC)
                                                                  │
                                              ┌───────────────────┴────────────┐
                                              ▼                                ▼
                                  appended to recording.wav          live.js rolling window
```

One tap feeds both, so the file and the on-screen text can never disagree.
Pausing simply stops handing samples over — nothing is written, so the recording
has no silent gap.

The WAV header is written with placeholder sizes when the file opens and patched
on close. A recording interrupted by a crash keeps the placeholder, and
`engine.repairWav()` rewrites it from the real file size, so the audio is still
usable. Verified against a real 58-minute recording truncated to 60% of its
bytes: it still decodes to 34.6 minutes.

### Live transcript

`live.js` keeps a 12-second window and re-transcribes it on a cadence. A word is
only shown as final once two consecutive passes agree on it at the same position
(LocalAgreement-2); the unstable tail is shown greyed and corrects itself. See
§8 for why 12 seconds and not more.

### Final pass and notes

```
recording.wav ─► engine.transcribeFile()  (windowed, 120 s + 2 s overlap)
                     │
                     ▼
              transcript.txt ─► llm.generate() ─► notes.md
                                     │
                                     └─► generate-title ─► title.txt
```

Windowing keeps memory flat on a two-hour meeting and lets the UI show progress.
Segments that begin inside the overlap are dropped, which avoids both a repeated
phrase and a word lost on the seam.

---

## 5. IPC surface

57 channels, all declared in `preload.js` — that file is the complete list of
what the renderer can do. `build/test-ipc-wiring.js` asserts every channel has a
counterpart in `main.js` and that nothing is registered but unreachable, because
a typo here fails at runtime inside a click.

**Request/response (38)** — recording lifecycle (`recording-start`,
`recording-finish`), import (`import-audio`, `import-read`, `import-open`,
`import-close`, `legacy-audio`), processing (`transcribe`, `summarize`,
`regenerate`, `generate-title`, `save-notes`), meetings (`list-meetings`,
`load-meeting`, `delete-meeting`, `open-folder`), reminders (4), settings
(`get/set-open-at-login`, `get/set-llm-settings`, `test-llm`, `style-sections`,
`check-environment`), exports (`save-text-file`, `export-pdf`), live
(`live-start`, `live-stop`), bubble (`bubble-show`, `bubble-hide`),
`open-external`.

**Fire-and-forget (10)** — `recording-chunk` (the audio itself), `set-theme`,
`recording-state`, `autodetect-set`, `mark-shortcut`, and five bubble messages.

**Main → renderer (9)** — `transcribe-progress`, `live-transcript`,
`meeting-detected`, `meeting-ended`, `start-recording`, `mark-moment`,
`remote-stop`, `remote-pause`, `bubble-state`.

---

## 6. Note providers

Notes need a model, and different people pay for one differently. Everything
goes through `llm.generate(config, {system, input})`; the three places that
produce text (summarize, regenerate, auto-title) do not know who answers.

| Provider | Transport | Credential |
|---|---|---|
| `claude-cli` | child process, `claude -p` | the user's existing Claude Code session |
| `gemini` | HTTPS, OpenAI-compatible | free-tier key, no card |
| `openrouter` | HTTPS, OpenAI-compatible | user's key |
| `ollama` | HTTP to localhost | none — the model is local |
| `anthropic` | HTTPS, Messages API | user's key |
| `compatible` | HTTPS/HTTP, OpenAI-compatible | user's key + endpoint |

The last row is the deliberate seam: pointing the app at one official endpoint
later is an entry in `llm.js`, not a change to any caller. Anything that speaks
`POST {base}/chat/completions` works with no new code.

**There is no zero-setup option and there cannot be one.** Every hosted API
needs a credential, and it comes from one of three places: shipped inside the
app (abused within days, and against every provider's terms), brokered by a
server someone pays for, or the user's own. The closest honest answer is a free
tier that takes about a minute to sign up for.

---

## 7. Tiers: measuring the machine instead of guessing

On first launch the app times a few passes over an 11-second public-domain
speech sample and stores the result. Two anchors, both measured on the same PC:

| Configuration | Cost per pass |
|---|---:|
| RTX 4080 SUPER, cuBLAS build | 75 ms |
| i7-12700K, CPU build only | 736 ms |

| Tier | Threshold | Live | Final | Measured lag |
|---|---|---|---|---|
| `fast` | ≤ 250 ms | `small`, every 0.7 s | `small` | 2.6 s median, 4.8 s worst |
| `steady` | ≤ 1200 ms | `base`, every 2 s | `small` | 4.4 s median, 5.6 s worst |
| `modest` | slower | none | `small` | — |

The lag figures come from replaying a minute of a real, noisy meeting at
wall-clock speed and measuring the gap between what was said and what was
confirmed (`build/tune-live.js`). If a machine turns out slower than it measured
— battery, a busy CPU, another app on the GPU — the live loop stretches its own
cadence rather than falling further behind every minute.

**The calibration sample has to be real speech.** A synthetic tone measures
25 ms where actual talking measures 185, because most of a pass is the decoder
emitting tokens. A machine calibrated on a tone would be promised a tier it
cannot hold.

---

## 7b. What a two-hour meeting actually costs

The expected length for this app's first user is one to two hours, so the whole
pipeline was run at that length rather than extrapolated to it
(`build/test-two-hours.js`, on the `fast` tier):

| Stage | Two hours of audio |
|---|---|
| Recording | 220 MB on disk, 36,000 IPC blocks written in 12 s, nothing retained in memory |
| Live transcript | 2.2 s median lag, no drift over the session |
| Final transcription | 115 s — 63x real time — for +19 MB of memory |
| Transcript | 84 KB, 2,040 timestamped lines, last stamp at 1h59m |
| Notes | 73 s from a real 159 KB transcript, all sections, timestamps out to 208 min |
| Automatic title | produced from the full transcript |
| Opening the meeting | 512 ms |
| Exports | .md 8 KB, .txt 159 KB, transcript .md 161 KB, PDF 133 KB in 497 ms |
| Process memory | 107 MB → 125 MB across the entire run |

Storage was the one number that needed a decision rather than a test, and it was
made: see §9b.

---

## 8. Decisions worth not re-litigating

Each of these was measured, and each is the opposite of the obvious choice.

**`small` is used everywhere, because `medium` buys nothing measurable.** Across
seven of the user's own recordings, two runs each (`build/tune-transcript.js`):
`small` 114 words per minute at 0.95% repetition, `medium` 109 at 0.79%, and
`medium` 1.4x slower. Equivalent, so the cheaper one wins. `medium` is a clearly
worse choice for the **live** loop, where its slower passes make consecutive
windows drift apart and less text gets confirmed.

*Correction: an earlier version of this document said `medium` falls into
repetition loops on real meeting audio. That came from one observation on one
clip. Across seven clips and two runs each it did not reproduce, and on that same
clip it now transcribes cleanly. The claim was not supported.*

**Stutters are removed from the transcript, not avoided by choosing a model.**
Every model sometimes emits a phrase and then emits it again, most often at a
window seam — it is not a property of one of them, so it is cleaned afterwards:
a phrase repeating itself inside a line, a line repeating the one before it, and
a line opening with the words the previous one closed with. Only within a few
seconds, because the same phrase half a minute later is a person restating it and
that belongs in the record. Measured on the same seven recordings, repetition
went from 0.95% of words to **0.00%** on both models.

**A short window beats a fast model.** Re-decoding 26 seconds every pass makes
the model resegment the whole thing, and two passes that disagree confirm
nothing. 12 seconds agrees.

**Punctuation is ignored when comparing passes.** Whisper emits punctuation as
its own token and moves it around, which was making identical text look like
disagreement — this was why almost nothing was being confirmed.

**Repeats are stripped by text, not just by timestamp.** When the model
resegments, words it already gave back reappear shifted slightly later.

**The prompt's rules are a numbered list, not a paragraph.** With the
"timestamp every heading" instruction buried mid-paragraph, the Minutes style —
whose every section description opens with "Bullet points of…" — came back with
no timestamps at all.

**Icons store DIB, not PNG, below 256 px.** Chromium reads PNG icon entries
happily; the Windows shell, which draws the desktop and taskbar, does not
reliably. The symptom was an icon that appeared inside the app and nowhere else.

**Shortcuts are repaired by the app, not by the installer.** A `.lnk` stores its
own copy of the icon path, and nobody re-runs a setup script after an update.

**Transcription is serialised, not parallel.** There is one server; two jobs used
to fight over it, because the second one's `start()` killed the first one's
server mid-request and the user was shown "read ECONNRESET". Queueing costs a
wait, colliding costs a transcript.

**The live window is capped before decoding, not trimmed after.** The buffer used
to be trimmed only once a pass had finished, which is fine while audio arrives in
real time. Given a backlog — a slow pass, a machine coming back from sleep — one
pass would try to decode everything that had piled up, take proportionally longer
to do it, and fall further behind while more arrived. Fed 20 minutes at once it
confirmed nothing and grew by 89 MB; capped, it skips to the present, confirms
the current window and grows by 4. The live view is a preview, and the file on
disk still has all of it.

**Errors are translated at the boundary.** Node and Electron produce messages
like `ENOENT: no such file or directory, open 'C:\Users\…'` and `Error invoking
remote method 'transcribe': …`, and this app shows its errors to the user. The
preload bridge strips Electron's wrapper for every channel at once, and the
transcribe handler maps the underlying causes to sentences.

---

## 9. Storage layout

Nothing is in a database; everything is a file the user can open.

```
Documents\Meetings\YYYY-MM-DD_HHMM\
  recording.wav      16 kHz mono PCM, written as it arrives
  transcript.txt     "[hh:mm:ss] text" per line
  notes.md           the generated notes
  title.txt          absent when naming was not possible
  participants.txt   attendees, for name biasing and attribution
  markers.txt        moments flagged during the meeting

%APPDATA%\yapper\
  settings.json      theme, startup, measured tier, chosen provider, and
                     llmByProvider: a sealed key, model and endpoint per provider
  reminders.json     action items across all meetings
```

The meeting folder is the unit of everything: exports read from it, deletion
moves it to the recycle bin, and a folder that only has audio is picked up as
"not transcribed" with a retry button.

## 9b. The audio's job ends with the transcript

**The transcript is the record.** The notes are written from it, it is what gets
read, searched and exported, and it is what is kept. The audio exists to produce
it and to survive a crash on the way there. Once a transcript is on disk, the
recording is deleted.

The reasoning: 16 kHz mono WAV is 110 MB an hour — 4.8 GB a month for one
two-hour meeting a day — and a recording of colleagues is more sensitive than
its transcript. What keeping it buys is re-transcription with a better model and
verifying a disputed quote, and both matter for days rather than years. This is
also the posture Granola takes: it never stores audio at all.

Order matters and is deliberate: the transcript is written first, then the audio
is released, so a crash between the two costs nothing. Release happens only when
the transcript really exists and has content — a failed transcription keeps the
audio so it can be retried, which is the whole reason to have it.

- `Keep audio after transcribing` in settings turns this off for anyone who wants
  the recording.
- Meetings recorded before this changed still hold their audio. The app reports
  how much and offers to release it, to the recycle bin, on request — it does not
  delete a user's existing recordings on their behalf at launch.
- Compression was measured as an alternative and rejected for now: Opus at
  24 kbps is 10.2 MB an hour, 11x smaller, and WebCodecs encodes at 135x real
  time, but it needs an Ogg muxer written by hand and only makes sense if the
  audio is being kept at all. (`MediaRecorder` cannot do it — it is bound to real
  time, so a two-hour recording would take two hours to compress.)

---

## 10. Dependencies and supply chain

**npm: one devDependency.** `electron@^33`, whose own dependencies are
`@electron/get`, `@types/node` and `extract-zip`; 64 packages in `node_modules`
altogether, every one of them from that tree. **No runtime dependencies at all**
— nothing npm-installed ships with the app. No bundler, no transpiler, no test
framework.

**Downloaded by `setup.ps1`, never committed:**

| Artefact | Source | Size |
|---|---|---|
| whisper.cpp CPU build | `ggml-org/whisper.cpp` release v1.9.1 | 8 MB |
| whisper.cpp CUDA build (only with an NVIDIA GPU) | same release | 646 MB |
| `ggml-base.bin`, `ggml-small.bin` | HuggingFace `ggerganov/whisper.cpp` | 142 + 466 MB |

**Committed binary assets**, 3 MB in total:

| File | Size | Why it is in the repo |
|---|---:|---|
| `build/icon-source.png` | 1.3 MB | The original artwork, so the icon can be recut |
| `build/yapper-icon.png` / `.ico` | 1.2 MB | What the app and the shell actually load |
| `renderer/app-mark.png` | 46 KB | The splash mark, generated from the same source |
| `renderer/fonts/Geist-*.woff2` | 45 KB | Two subsets, so the UI has no webfont request |
| `build/calibration.wav` | 344 KB | 11 s of public-domain speech; the app cannot measure the machine without it |

`bin/` and `models/` are gitignored — over a gigabyte between them. A fresh clone
is source plus those 3 MB.

---

## 11. Build and distribution status

There is no packaging step yet. Today the app is provisioned rather than built:

```
powershell -ExecutionPolicy Bypass -File setup.ps1
```

which downloads the engine and models, installs Electron, and creates a desktop
shortcut. `npm start` runs it.

Because nothing is compiled or bundled, packaging is a matter of choosing a
packager rather than untangling a build. The open questions for that step:

- **Windows** — an installer can ship the app plus the 8 MB CPU engine and fetch
  the CUDA build and models on first run, which is what `setup.ps1` already
  does. Nothing blocks this.
- **macOS** — no prebuilt whisper.cpp binary exists for arm64; it has to be
  compiled once on an Apple Silicon machine and bundled. Notarisation needs a
  paid Apple Developer account. System-audio capture and meeting auto-detection
  are Windows-only today and need rewriting against ScreenCaptureKit.

---

## 12. Security posture

| Surface | Position |
|---|---|
| Renderer privileges | `contextIsolation: true`, `nodeIntegration: false` on all three windows. No Node in any page. |
| Renderer → main | Only the 53 channels in `preload.js`. No `ipcRenderer` exposure. |
| CSP | `default-src 'self'` on every page; `index.html` additionally `style-src 'self'` (no inline styles) and `media-src blob:` |
| API key at rest | Sealed with `safeStorage` (DPAPI on Windows, Keychain on macOS), never in plaintext `settings.json`. Where a platform has no keystore, the UI says the key is stored unencrypted rather than implying protection it does not have. |
| One key per provider | Keys are stored under the provider they were issued for. A single shared slot meant switching from Gemini to OpenRouter would have sent Google's key to OpenRouter's servers, and the UI would have called that provider configured. |
| Key resolution | The provider named in a request decides which key is used. `test-llm` used to merge a caller-supplied provider with the stored key, which turned "test this endpoint" into a way to send one service's key to another. |
| Keys in error text | Provider rejection messages are shown to the user, and some providers quote the Authorization header back. The key is redacted out of any message before it is displayed. |
| API key in the renderer | Never sent. The renderer learns only whether one is set. |
| Opening URLs | `shell.openExternal` accepts only the provider sign-up pages the app itself offers — an allowlist, not an arbitrary URL from the renderer. |
| Deleting files | The delete handler refuses any path that is not a child of the meetings folder; tested against eight ways of trying to escape it. |
| Audio | Never transmitted. The transcript is sent only to the configured provider. |
| Free-tier data use | Surfaced in the UI: free tiers generally train on what is sent, and a meeting transcript is not always the user's to share. |

---

## 13. Testing

No test framework — each test is a script that exits non-zero. They fall in
three groups.

**Pure logic, no Electron** (`npm test`, seconds):

| Test | Covers |
|---|---|
| `test-llm.js` | Provider routing, payload shape, every error path, against a fake HTTP server |
| `test-keystore.js` | The key never appears in what is stored; runs under both a stand-in and the real OS keystore |
| `test-key-leaks.js` | Adversarial: treats the renderer as hostile and tries to make a stored key reach a server it was not issued for, come back through the bridge, or appear in an error message |
| `test-provider-keys.js` | Each provider keeps its own key, model and endpoint; switching neither inherits nor loses one; a legacy single-slot profile migrates |
| `test-live-logic.js` | The confirmation rules — prefix agreement, repeat stripping, degenerate-output detection |
| `test-dedup.js` | Transcript cleanup: which repeats are removed, which survive, and the time window that separates a seam artefact from a person restating something |
| `test-bounds.js` | The bubble stays on screen, including multi-monitor negative origins |
| `test-meetings.js` | The delete path guard |
| `test-section-coverage.js` | Every note style has a button, every section has a colour rule |
| `test-ipc-wiring.js` | Every bridge channel has a counterpart |

**Driving the real app** (Electron, a throwaway `Documents` and `userData` so a
run can never touch a real meeting):

| Test | Covers |
|---|---|
| `test-record-cycle.js` | The whole recording cycle: audio in through the real IPC, paused halfway, stopped, every artefact checked |
| `test-record-recovery.js` | Capture refused, and the audio device vanishing mid-start |
| `test-faults.js` | Fault injection: the transcription server killed mid-pass, two transcriptions at once, a meeting deleted under a running job, a missing model, and file handles or child processes left behind across repeated cycles |
| `test-extremes.js` | Boundary values and scale: the clock past an hour, a 75-minute recording transcribed for real, accents and emoji and HTML-looking text, an empty WAV, notes with no headings, 300 meetings in the sidebar, and the live loop given 20 minutes of audio at once |
| `test-two-hours.js` | The expected real length, every stage, measured — see §7b. `MINUTES=60` for the shorter end of the range |
| `test-audio-release.js` | The audio is released only after a real transcript, never on a failure, never when the user asked to keep it, and reclaiming older meetings' audio touches only the transcribed ones |
| `test-smoke.js` | Every view, control and export, while listening for renderer errors |
| `test-import.js` | A real `.m4a` and `.webm`, checking the resulting WAV is genuinely playable and not silent |
| `test-delete-ui.js`, `test-options-ui.js`, `test-llm-ui.js`, `test-export.js` | Deletion confirmation, per-meeting attendees, provider settings, transcript formatting |
| `test-bubble-fit.js`, `test-splash-mark.js`, `icon-verify.js` | The overlay fits its own controls; the splash mark loads under CSP; the icon's corners, halo and every `.ico` size |

**Spending model calls** (minutes, run deliberately): `test-styles.js` runs every
note style against one transcript and compares the sections returned with the
sections requested; `test-stamps.js` repeats the styles most likely to drown the
timestamp rule; `test-memo.js` checks the Memo style returns prose, not bullets.

They share `build/harness.js`. Note for anyone writing another one: Electron on
Windows holds stdout until the process exits, so the long tests also append
progress to a `progress.log` in their sandbox — a run that stalls has to be
diagnosable while it is still stalling.

**Not covered:** the Web Audio graph itself. Capture needs a microphone and a
person; everything downstream of the PCM tap is covered.

**This document is tested too.** `build/test-docs.js` makes 73 assertions
against the code: every line count in §3, every channel count in §5, that §6
lists exactly the providers `llm.js` defines, that §7's cadence matches the tier
table, that `medium` really is unused, that the security claims in §12 hold, and
that every file and test named anywhere here exists. It runs in `npm test`, so
the doc cannot quietly drift away from the code.

---

## 14. Known gaps

- No packaging or installers (§11).
- macOS: no engine binary, and system audio plus auto-detection are
  Windows-only.
- No speaker diarisation. Attendees are typed by hand; they bias name spelling
  and help attribution, but the app does not know who said what.
- No playback from the timestamps in the notes.
- `renderer/app.js` is 1,597 lines in one module.
