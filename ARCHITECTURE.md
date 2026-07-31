# Yapper — architecture and build structure

A desktop meeting-notes app: it records a call, transcribes it **on the machine**
and turns the transcript into notes with a language model. Audio never leaves the
device; only text is sent, and only to the provider the user picked.

This document is for reviewing how it is put together. `README.md` is the
user-facing guide; `mac/README.md` is the macOS build runbook.

## Where to start

```
git clone <repo> && cd yapper

powershell -ExecutionPolicy Bypass -File setup.ps1     # Windows: engine + models, ~600 MB
bash mac/build-app.sh                                  # macOS: helpers, engine, dmg

npm start
npm test                                               # no model or GPU needed
```

Reading order for a review, shortest useful path first:

1. **`preload.js`** (112 lines) — the entire boundary between the privileged and
   unprivileged halves. If something is not in here, the UI cannot do it.
2. **`engine.js` §"tiers"** — the performance contract, with the measurements it
   is based on in the comments.
3. **`live.js`** — the only genuinely subtle algorithm in the app.
4. **`main.js`** — grouped by concern with section headers; skim the headers.
5. **§8 below** — the decisions that look wrong until you see the numbers.

```
yapper/
├── main.js  engine.js  live.js  llm.js  keystore.js  bounds.js  preload.js
├── sysaudio.js          macOS system audio: helper lifecycle, buffer, mixing
├── meetings.js          which running app counts as a meeting, per platform
├── renderer/            all three windows, plus fonts and the audio worklet
├── build/               tests, icon pipeline, and the calibration sample
├── mac/                 the two Swift helpers and the macOS build scripts
├── setup.ps1            Windows provisioning: engine, models, Electron, shortcut
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
  model each time would cost more than the inference. Being a child, it
  outlives a parent that is *killed* rather than closed, holding its model
  resident — so `engine.js` sweeps for abandoned servers once per run, before
  starting its first one. Measured at 802 MB across four of them after an
  afternoon of crash testing.

---

## 3. Module map

Application code, 6,900 lines total. No framework, no build step — the files
that ship are the files that run.

### Main process

| File | Lines | Responsibility |
|---|---:|---|
| `main.js` | 2470 | Windows, the whole IPC surface, meeting files, settings, meeting auto-detection, note prompts, shortcut upkeep, auto-update |
| `engine.js` | 787 | whisper.cpp lifecycle, the tier table, calibration, WAV read/write, full-file transcription |
| `digest.js` | 346 | The day, assembled from the notes; the week, written from them and checked |
| `search.js` | 363 | Retrieval: passages, query parsing, BM25 ranking, the grounded-answer prompt |
| `llm.js` | 345 | Note providers (§6) behind one `generate()` call |
| `live.js` | 310 | Live transcription: rolling window, LocalAgreement-2 confirmation |
| `actions.js` | 253 | Reading action items out of the notes, and folding duplicates together |
| `provision.js` | 380 | First-run engine download for installed copies (Windows and macOS): resumable and retried, recording-first in its ordering, plus the version comparison behind update notices |
| `library.js` | 167 | The index over every meeting: build, refresh, select by day or week |
| `sysaudio.js` | 186 | macOS system audio: the native helper's lifecycle, its buffer, and mixing it into the microphone |
| `meetings.js` | 72 | Which running app counts as a meeting, in both platforms' vocabularies |
| `keystore.js` | 39 | Sealing the API key with the OS keystore |
| `bounds.js` | 34 | Pure geometry: keeping the floating bubble on screen |
| `preload.js` | 112 | The only bridge between renderer and main |

`keystore.js` and `bounds.js` are separate files for one reason: they are pure
functions, so they can be tested without booting Electron, and `keystore.js`
takes `safeStorage` as an argument so the "no keystore available" path is
reachable in a test.

### Renderer

| File | Lines | Responsibility |
|---|---:|---|
| `renderer/app.js` | 2787 | Main window: capture graph, views, notes rendering, exports, reminders, search, digests, settings |
| `renderer/style.css` | 1552 | Everything visual, light and dark |
| `renderer/index.html` | 454 | Main window markup |
| `renderer/bubble.html` | 184 | The always-on-top overlay: a capsule at rest, the live transcript on hover |
| `renderer/bubble.js` | 174 | Its behaviour, including sizing itself to its own contents |
| `renderer/splash.html` | 104 | Boot screen, including the first-run calibration status |
| `renderer/pcm-worklet.js` | 33 | The audio-thread tap that produces PCM |

`app.js` is the largest file and the obvious candidate for splitting. It is
organised in labelled sections (capture, live preview, recording, meeting view,
exports, reminders, settings) but it is one module.

### The two native helpers (macOS)

Two facts Windows reads straight out of the OS have no JavaScript equivalent on
macOS, so each is a small Swift binary compiled by `mac/build-app.sh` and
unpacked from the asar — nothing can be executed from inside one.

| Helper | Lines | Answers |
|---|---:|---|
| `mac/system-audio.swift` | 339 | What the machine is playing, as 16 kHz mono PCM on stdout (a Core Audio process tap, falling back to ScreenCaptureKit) |
| `mac/mic-probe.swift` | 58 | Which processes hold the microphone right now, as bundle ids (CoreAudio) |

They are deliberately dumb: they answer one question on stdout and exit codes
carry the only nuance (`2` from the audio helper means a permission is missing,
which is recoverable — and since there are two routes there are two
permissions, so it names which one on stderr first: sending someone to Screen
Recording when the switch they need is under System Audio Recording Only is
worse than saying nothing). Everything that can be decided in
JavaScript — buffering, mixing, which bundle id counts as a meeting — stays in
`sysaudio.js` and `meetings.js`, where it can be tested without a Mac in the
loop.

Neither is required. Without the audio helper the app records the microphone
alone and says so; without the mic probe, auto-detection stays off. That is the
same shape as the CUDA build on Windows: better when present, never fatal when
absent.

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

### Across meetings

Everything that looks at more than one meeting reads the same index, and none of
it stores a second copy of anything:

```
Meetings/*/  ─► library.refresh() ─► library.json      (one entry per meeting)
                     │                    │
                     ├─► actions.parseActionItems() ─► reminders.json
                     │        (owner, due date, priority — only if written down)
                     │
                     ├─► search.buildIndex() ─► passages, in memory only
                     │            │
                     │            ├─► search()  BM25 + phrase/kind/people/date
                     │            └─► ask()  ─► the passages, then llm.generate()
                     │
                     ├─► digest.dailyDigest()   ─► today, assembled. No model.
                     │
                     └─► digest.weeklyFacts()   ─► the week's numbers. No model.
                           + digest.weeklyInput() ─► llm.generate()
                                  └─► digest.parseWeekly() ─► digests/weekly-*.json
```

`library.json` and the search index are both derived, so both are disposable:
delete either and the next refresh rebuilds it from the folders. A meeting is
re-read only when its stamp (each file's name, size and mtime) changed, which is
what keeps a refresh over hundreds of meetings from re-parsing all of them.

`reminders.json` is the exception — it is *not* purely derived, because it also
holds what the user did to an item (completed, dismissed). Extraction therefore
merges rather than replaces: an incoming item that matches an existing one folds
into it and keeps its state.

The daily and weekly roll-ups are split by *kind*, not just by period, and that
is what keeps them from being two views of the same list:

| | Daily | Weekly |
|---|---|---|
| How it is produced | assembled from the notes | written by a model from the notes |
| What it contains | the meetings, the decisions recorded, the tasks that appeared, what is overdue | the threads across meetings, where the week changed direction, what was left unresolved |
| Cost | none — no model, no network | one call, cached per week |
| Cached | no, recomputing is cheaper than validating | `digests/weekly-YYYY-Www.json`, keyed by the fingerprint of the meetings behind it |
| If the provider is unreachable | unaffected | the numbers still render; only the written part is missing |

The weekly prompt is not given the action-item sections at all, so the review
cannot become a task list even if the model tried — the input does not contain
one. Its bullets must cite meetings by title, and `parseWeekly()` drops any
bullet whose citation does not resolve to a meeting in that week.

---

## 5. IPC surface

76 channels, all declared in `preload.js` — that file is the complete list of
what the renderer can do. `build/test-ipc-wiring.js` asserts every channel has a
counterpart in `main.js` and that nothing is registered but unreachable, because
a typo here fails at runtime inside a click.

**Request/response (51)** — recording lifecycle (`recording-start`,
`recording-finish`), import (`import-audio`, `import-read`, `import-open`,
`import-close`, `legacy-audio`), processing (`transcribe`, `summarize`,
`regenerate`, `generate-title`, `save-notes`), meetings (`list-meetings`,
`load-meeting`, `delete-meeting`, `open-folder`), reminders (4), settings
(`get/set-open-at-login`, `get/set-bubble-corner`, `get/set-llm-settings`, `test-llm`, `style-sections`,
`check-environment`), first-run and updates (`engine-setup`, `update-restart`,
`open-releases-page`), the two halves of the macOS Screen Recording grant the
app can perform on the user's behalf (`open-screen-settings`, `relaunch-app`),
the library (`refresh-library`, `list-actions`), retrieval
(`search`, `ask`), the roll-ups (`daily-digest`, `weekly-summary`), exports
(`save-text-file`, `export-pdf`), live
(`live-start`, `live-stop`), bubble (`bubble-show`, `bubble-hide`),
`open-external`.

**Fire-and-forget (11)** — `recording-chunk` (the audio itself), `set-theme`,
`recording-state`, `autodetect-set`, `mark-shortcut`, `sys-gain` (macOS: the
system meter's slider, since the mixing it controls happens in main), and five
bubble messages.

**Main → renderer (14)** — `transcribe-progress`, `live-transcript`,
`meeting-detected`, `meeting-ended`, `start-recording`, `mark-moment`,
`remote-stop`, `remote-pause`, `bubble-state`, `keep-audio-changed`,
`engine-setup-progress`, `update-ready`, `system-audio-status`,
`system-wave` (macOS: the samples the System meter draws, which never reach
the renderer any other way).

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

**The live loop steps aside for a full transcription rather than sharing.** It
does not go through that queue — it runs on a cadence — so it checks
`engine.busy()` and skips a pass while a full-file job holds the server, then
takes its own model back when the job is done. Hitting "Transcribe now" on an
older meeting mid-recording used to kill the live transcript outright: twelve
consecutive "whisper-server is not running", and it never recovered. Now the
transcription completes and the live text carries on with no errors at all.

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

**Nothing about a meeting is inferred — an owner, a date or a decision exists
only if it was said.** This is a rule about the code, not only about prompts.
`splitOwner()` returns a name only when the line is written `Name: task`, and
rejects the shapes that look like one but are not — `URGENT:`, `TODO:`, anything
in all caps. `splitDue()` reads a date only from words present in the line; there
is no path that turns "soon" into a date or defaults to next Friday. An item
with no owner is shown as unassigned, which is a true statement about the
meeting.

**Search retrieves before it answers, and can return nothing.** `ask()` runs
retrieval first and, when no passage matches, stops there and replies
`nothing-found` — the model is never asked a question with an empty context,
because that is exactly the situation in which it would invent one. When there
are passages, they are the entire context and the prompt requires a bracketed
citation per claim. `test-search-ui.js` asks about a topic that appears in no
meeting and asserts no answer comes back.

**A dead capture device is announced, not drawn.** The app already warned when a
source was *missing* (no system track, no microphone). What that missed is a
device that exists and delivers exact digital zeros — a wireless headset asleep,
a hardware mute — where the graph runs, the waveform draws a flat line, and two
hours later the meeting is silence. A live microphone always carries at least
its own noise floor, so a peak of exactly zero held for six seconds means a dead
device: the recording keeps going, a warning names the likely cause, and it
clears itself the moment signal arrives. System audio gets no such watchdog on
purpose — a silent desktop loopback *is* legitimately all zeros.

**The bubble rests as a capsule, and its hover is watched from the main
process.** While recording, the overlay is a capsule the size of its own clock —
the audio level and the time, no buttons. Hovering it opens the live transcript
and the controls; leaving closes it, unless pinned. Two mechanics make this
work. Hover cannot be a DOM event: the capsule is one big drag region so it can
be moved, and Electron delivers no mouse events over a drag region on Windows —
so the main process polls the cursor against the window's bounds and pushes
enter/leave through the existing `bubble-state` channel. And opening cannot
flap: the resize anchors the bottom-right corner and the open card is strictly
larger, so the expanded window always still contains the cursor that opened it.
The capsule's bars show the real capture signal (the same buffers the main
window's waveform draws, throttled to ~9 Hz), not a looping animation — motion
means audio is actually arriving, and pausing visibly stills it.

**A detected meeting is offered twice, in the two places the person might be.**
It arrives as an in-window card *and* as a real OS notification, because the
moment a meeting starts you are looking at Zoom, not at Yapper. On macOS the
toast carries a real button; on Windows Electron's `Notification` has no actions,
so the whole toast is the button and the body says "Click to start recording".
Verified with `build/probe-notify.js`: the toast reports `show` on Windows 11 with
or without a Start Menu shortcut, so the old rule that an AppUserModelID needs
one to be allowed to notify does not apply here. Two things are deliberately
*not* notified: notes being ready, and the meeting app releasing the microphone
while a recording is still running. Both are in-window only today.

**The app opens on the day, and nothing else may take the screen.** On launch the
first question is usually "what happened, what do I owe", not "record
something" — so `Today` is the landing view. Two consequences were handled with
it rather than discovered later. The detected-meeting card was inside the record
view, where the landing change would have made it invisible; it is now a fixed
card that floats over whichever view is open, because it can arrive at any moment
and must neither hide behind a view nor replace the one being read — an earlier
version switched views on detection and made an open meeting vanish 400 ms after
it was clicked. And `startRecording()` switches to the record view itself rather
than relying on its callers, so the timer and the stop button are on screen no
matter which of the three entry points started the recording.

**A claim without a resolvable source is dropped, not shown with a caveat.** The
weekly review has to cite meetings by title, and each citation is looked up
against the meetings of that week. A bullet citing something that is not there —
the failure mode where a plausible-sounding week gets invented — is discarded,
and the count of what was discarded is shown rather than hidden. A caveat would
leave the sentence on screen, and a sentence on screen is what gets believed.

**Ranking is lexical, not embeddings.** BM25 over passages needs no model, no
index file and no network, so search works before any provider is configured and
costs nothing per query. Two ordering rules were added because measurement showed
plain relevance was wrong for how the question was asked: a query about a
decision puts the Decisions section above a transcript line that merely says the
word, and a query that is only a period ("what happened in June") lists that
period's meetings instead of returning nothing. The cost is no synonym matching —
searching "cost" will not find "pricing".

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
  index.json         the meeting index — a cache, safe to delete
  digests\
    weekly-YYYY-Www.json   one written review per week, with the fingerprint of
                           the meetings it came from; stale copies are ignored
```

The meeting folder is the unit of everything: exports read from it, deletion
moves it to the recycle bin, and a folder that only has audio is picked up as
"not transcribed" with a retry button.

Everything under `%APPDATA%` except `settings.json` and `reminders.json` is
derived and disposable. Deleting `index.json` or the whole `digests` folder costs
one rebuild and one model call respectively; nothing is lost.

## 9b. The audio's job ends with the transcript

**The transcript is the record.** The notes are written from it, it is what gets
read, searched and exported, and it is what is kept. The audio exists to produce
it and to survive a crash on the way there. Once a transcript is on disk, the
recording is deleted.

The reasoning: 16 kHz mono WAV is 110 MB an hour — 4.8 GB a month for one
two-hour meeting a day — and a recording of colleagues is more sensitive than
its transcript. What keeping it buys is re-transcription with a better model and
verifying a disputed quote, and both matter for days rather than years. This is
also the posture another meeting-notes app takes: it never stores audio at all.

Order matters and is deliberate: the transcript is written first, then the audio
is released, so a crash between the two costs nothing. Release happens only when
the transcript really exists and has content — a failed transcription keeps the
audio so it can be retried, which is the whole reason to have it.

- `Keep this meeting's audio` covers **one meeting**, not a policy. It lives in
  the main process's memory rather than in settings, so it is off on every
  launch, and it switches itself off — and unticks itself on screen — as soon as
  it has been honoured. Nobody who ticks it before a negotiation means "keep
  every recording from now on", and a persisted version of this toggle would
  quietly do exactly that.
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

**npm: two devDependencies, one runtime dependency.** To develop: `electron@^33`
and `electron-builder@^25` (the installer). Shipping inside the app: exactly one
package, `electron-updater` — updates from the release feed cannot be done from
plain Node without reimplementing signature checks and differential downloads,
and that is the one job worth buying a dependency for. Everything else is still
plain Electron and Node: no bundler, no transpiler, no test framework. This
footprint is asserted by `test-docs.js` — a new dependency has to change this
paragraph to get in.

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

## 11. Build and distribution

Two ways to run it, and they deliberately share every path in the code:

**Development** is provisioned, not built: `setup.ps1` downloads the engine and
models next to the code, `npm start` runs it. The engine home is the repo.

**Users get an installer.** `npm run dist` produces
`dist\Yapper-Setup-<version>.exe` (~83 MB, NSIS, per-user, no admin) plus the
`latest.yml` + blockmap feed files; `npm run release` builds and publishes them
to the GitHub release feed in one step. What shipping changed in the code, and
why:

- **The engine moved out of the app.** An installed copy runs from a read-only
  asar; `engine.setHome()` points bin/ and models/ at
  `%LOCALAPPDATA%\Yapper\engine`, and `provision.js` fills it on first run —
  the CPU build always (8 MB), the two models (608 MB), then the CUDA build
  when `nvidia-smi` answers (646 MB) — with progress in the status area.
  Bundling the engine instead would make the installer 1.4 GB for everyone.
- **The order is the first impression.** Everything needed to *record* comes
  first: the server binary and `base`, about 160 MB, after which progress
  reports `usable: true` and `main.js` opens the app. `small` and the CUDA
  build arrive behind it while the app already works. The asymmetry is the
  argument — a meeting not recorded is gone, a transcript can always be made
  later from audio already on disk. Transcription waits for `small` at the
  point it actually needs it (`ensureModel`), and the live transcript falls
  back to `base` in the meantime rather than disappearing.
- **Downloads resume.** Every file goes to a `.part` first, so a killed
  download never looks installed — and that `.part` now *survives* the
  failure, because losing a 490 MB model at 95% and starting over is the most
  likely way an install fails on home wifi. The next attempt sends
  `Range: bytes=<what we have>-`, guarded by `If-Range` so a file that changed
  on the server restarts cleanly instead of splicing two versions together.
  Three retries with a growing pause sit on top.
- **`calibration.wav` is asar-unpacked.** This process can read inside the
  asar; the whisper server is a separate process and cannot.
- **The PDF export writes to temp** with a `<base>` back into `renderer/` —
  it used to write next to its own code, which an installed app cannot.
- **Single-instance lock.** Two instances would fight over the whisper server's
  port; the second launch focuses the first and exits.
- **Auto-update is electron-updater** (§10), wired only when packaged: checked
  at launch and every four hours, downloaded in the background, installed on
  quit — or immediately from the sidebar pill. The full loop is proven by
  `build/e2e-update.ps1`: install 0.1.0 against a local feed, serve 0.1.1,
  quit, and the exe on disk is 0.1.1. `build/e2e-install.ps1` checks the
  install itself (shortcuts, unpacked wav, feed config, engine found,
  calibration ran); `build/e2e-uninstall.ps1` removes every trace.
- **Not code-signed.** No certificate, so SmartScreen warns on first install.
  Known cost, documented in the manual; signing is the remaining distribution
  gap. electron-builder needs its `winCodeSign` cache even unsigned — on a
  machine without symlink privileges that extraction fails on electron-builder
  25 and works on 26, which is why the pin is `^26`.

**macOS** ships a dmg built by `mac/build-app.sh` on Apple Silicon. The platform
branches live in the same files: `provision.js` downloads a self-hosted Metal
engine from the feed (ggml-org publishes no mac binary — `mac/build-engine.sh`
compiles and publishes it once per engine version), and the two native helpers
are compiled alongside the app.

**And a zip, plus `mac/install.sh`.** Without a Developer ID certificate the dmg
route ends in a Gatekeeper block, and since macOS 15 the right-click → Open
escape is gone — the user has to find *Open Anyway* in System Settings. The
block is not macOS judging the app, though: it is `com.apple.quarantine`, which
the *browser* attaches to a download. `curl` attaches none, so a one-line
installer that fetches the zip and unpacks it into `/Applications` lands a copy
that opens normally. It is not a stand-in for signing — Apple vouches for
nothing either way — so what the script puts in place of a signature is a
sha512 check against `latest-mac.yml`: enough to catch a corrupt or tampered
download, not enough to survive a compromised feed, and it says so. `ditto`
rather than `unzip`, because the Electron framework's `Versions/Current`
symlink does not survive the latter. `mac/e2e-install.sh` proves all of it
against a local feed. When the certificate arrives this becomes a footnote and
notarization takes over.

Three constraints are worth knowing before touching that build, all learned the
hard way and all documented in `mac/README.md`:

- **The signature identity is not cosmetic.** electron-builder leaves Electron's
  own ad-hoc signature unless told otherwise, so the bundle claimed
  `com.yapper.meetingnotes` while its signature said `Electron`. macOS keys
  notification authorisation on the signature, so the app was never registered
  and never got to ask — notifications simply did not exist, silently.
  `identity: "-"` fixes it; `hardenedRuntime` is off beside it, since without a
  certificate it buys nothing and would demand a microphone entitlement the
  defaults omit.
- **Deployment targets must be pinned.** `swiftc` defaults to the SDK's version,
  so building on a beta produces helpers that run on that beta and nowhere else,
  while the Electron app opens fine — an install that looks healthy and quietly
  has neither system audio nor meeting detection.
- **Updates only notify.** Squirrel.Mac refuses unsigned updates, so the pill
  opens the download page instead of promising a restart it cannot deliver. The
  check reads `latest-mac.yml` and falls back to `latest.yml`: electron-builder
  writes one manifest per platform, so a release cut on a Mac leaves the Windows
  manifest at its old version, and reading only that one announces nothing.
  `mac/build-app.sh` uploads the mac manifest with the dmg — it used to stay in
  `dist/`, which is why the feed had never carried one.

Gatekeeper still rejects the ad-hoc signature on someone else's machine, and
since macOS 15 right-click → Open no longer clears it. That, and self-installing
updates, and notarisation, are all the same missing item: an Apple Developer
certificate.

---

## 12. Security posture

| Surface | Position |
|---|---|
| Renderer privileges | `contextIsolation: true`, `nodeIntegration: false` on all three windows. No Node in any page. |
| Renderer → main | Only the channels in `preload.js` (§5). No `ipcRenderer` exposure. |
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
| `test-library.js` | The meeting index: what counts as content, day and week selection, and the stamp that decides when a cached entry can be reused |
| `test-actions.js` | Extraction and deduplication: only what the notes actually say becomes an item, `URGENT:` is not an owner, an undated item never gains a date, and restating a task merges instead of duplicating |
| `test-search.js` | Retrieval end to end without a model: passages, query parsing in English and Spanish, ranking, and the two orderings that matter — a decision outranks a transcript line that merely mentions the word, and a period with no keyword still lists its meetings |
| `test-digest.js` | The roll-ups: which due dates are allowed to resolve to a day and which stay as written, what belongs to a day, what reaches the weekly model, and what is thrown away when it comes back citing a meeting that does not exist |
| `test-bounds.js` | The bubble stays on screen, including multi-monitor negative origins |
| `test-meetings.js` | The delete path guard |
| `test-section-coverage.js` | Every note style has a button, every section has a colour rule |
| `test-ipc-wiring.js` | Every bridge channel has a counterpart |
| `test-meeting-detect.js` | Which running app counts as a meeting, in both vocabularies — including the helper-process bundle ids Electron apps actually report, which is what the first macOS build got wrong |
| `test-sysaudio.js` | Mixing system audio into the microphone: saturating instead of wrapping, the bounded buffer, and a helper that is absent leaving the microphone untouched rather than writing silence over it |
| `test-platform-parity.js` | The Windows assumptions that mean something else on macOS — asking for screen capture to record, registering a login item by executable path, and telling a Mac user to run a PowerShell script |

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
| `test-live-vs-final.js` | A full transcription requested mid-recording: it completes, and the live transcript survives it without errors |
| `test-search-ui.js` | The search view against a real model: results carry their meeting, date, timestamp and participants, a result opens its meeting, nothing-found says so, and a question about something never discussed returns no answer rather than an invented one |
| `test-home-ui.js` | The day and the week against a real model: only today's meetings and decisions appear, every line opens its source, an empty day offers the last one that had something, the weekly review cites real meetings and does not repeat the task list, and a week with one set of notes is explained rather than written |
| `test-actions-ui.js` | The action list: filters, the meeting each item came from, and completing one |
| `test-silence-warning.js` | A microphone delivering exact zeros — the asleep wireless headset — is announced on screen within seconds, the recording keeps going, and the warning clears itself when the device wakes |
| `test-bubble-corner.js` | Which corner the capsule appears in: measured geometrically against the display's work area rather than by reading the setting back, including that a resize keeps it in the corner instead of walking it out |
| `test-wedged-server.js` | A server that accepts a request and never answers — played by a socket, since a real wedge cannot be summoned. Asserts the request ends, names the timeout, is recognised by the retry that restarts the engine, and that a real transcript still completes afterwards |
| `test-recording-signpost.js` | Walking away from a recording and finding the way back: the sidebar button becomes the indicator and stays the route, checked by leaving for Action items mid-recording and returning — which is exactly how the gap was found |
| `test-tray.js` | macOS: the menu bar icon loads, is the height the bar asks for, and is black-on-alpha with no colour left in it — createTray() skips itself silently when the icon will not load, so a malformed template would remove the feature with no error anywhere |
| `test-sys-meter.js` | macOS: the System meter moves with real audio playing, read from the pixels it drew rather than from the data that reached the renderer, and goes flat again on stop |
| `test-screen-prompt.js` | macOS: a refused Screen Recording permission raises a prompt with the two steps the user cannot take from inside the app, says the grant applies only after reopening rather than "record again", and a helper dying mid-meeting — a different problem — does not raise it |
| `test-smoke.js` | Every view, control and export, while listening for renderer errors |
| `test-import.js` | A real `.m4a` and `.webm`, checking the resulting WAV is genuinely playable and not silent |
| `test-delete-ui.js`, `test-options-ui.js`, `test-llm-ui.js`, `test-export.js` | Deletion confirmation, per-meeting attendees, provider settings, transcript formatting |
| `test-bubble-fit.js`, `test-splash-mark.js`, `icon-verify.js` | The overlay in all three states — capsule, hover-open, pinned — fits its contents, opens and closes on the hover messages, keeps the pin across a reload, migrates the old expanded preference, and its bars track the level they are sent; the splash mark loads under CSP; the icon's corners, halo and every `.ico` size |
| `probe-system-audio.js` | macOS: mutes the output, plays a clip, records, and checks the file still has signal. Energy alone would prove nothing — the microphone hears the speakers too — so muting is what makes the capture path the only possible source |
| `probe-empty.js` | Not an assertion — it boots against an empty profile and prints what every view says, so a first run can be read instead of guessed at. It is how the weekly panel's wall of zeros and its dead "write it again" button were found |
| `probe-notify.js` | Shows one real meeting-detected toast and reports what the OS did with it. `WITH_SHORTCUT=1` adds a Start Menu shortcut first, to test whether the AppUserModelID needs one — on Windows 11 it does not; the toast displays either way |
| `probe-wave.js`, `probe-wave-real.js`, `probe-wave-user.js` | Three rungs for diagnosing dead waveforms: the real `startRecording()` with synthetic streams, with the real loopback and default microphone, and with the user's actual saved profile. Each reports context state, track counts, which analysers exist, and whether the drawn pixels move |

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

- Neither build is code-signed by an authority — SmartScreen warns on first
  install on Windows (§11), Gatekeeper asks on first open on macOS. The macOS
  build is ad-hoc signed under its own bundle id, which is not a trust
  statement but is what makes the OS deliver its notifications at all.
- macOS updates notify instead of installing themselves: Squirrel.Mac refuses
  unsigned updates. Same certificate, same gap.
- macOS system audio depends on the user granting Screen Recording. Refused,
  the recording is the microphone alone — degraded, and said out loud, but not
  what was asked for.
- Apple Silicon only. An Intel or universal build needs a second engine compile
  and doubles the artifact size.
- No speaker diarisation. Attendees are typed by hand; they bias name spelling
  and help attribution, but the app does not know who said what.
- No playback from the timestamps in the notes.
- `renderer/app.js` is 2,647 lines in one module.
