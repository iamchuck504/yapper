# What every feature does

A tour of Yapper, feature by feature: what it is for, how to use it, and where
it stops. Installation lives in [Windows](INSTALL-WINDOWS.md) /
[macOS](INSTALL-MACOS.md).

The short version: **Yapper records a meeting, transcribes it on your own
machine, and writes the notes.** Audio never leaves the device. Only the
transcript is sent, only to the provider you chose, and only to write notes.

---

## Recording

### New meeting

Everything that shapes a recording is on this screen *before* you start, because
some of it cannot be changed afterwards.

- **Note style** — seven of them, described below.
- **Detail** — Concise (short bullets) or Detailed (exhaustive).
- **Participants** — the names of who is in the meeting. Passed to the
  transcriber as a hint so it spells them right; a name it has never seen comes
  out as whatever it sounds like. It belongs to *this meeting*, not to your
  preferences: the field starts empty every time, so last week's attendees
  cannot leak into today's notes.
- **Extra instructions** — free-form context: the project, what to focus on,
  what to ignore.
- **Notes by** — which model writes them.
- **Mic noise reduction** — a filter chain on the microphone only.
- **Keep this meeting's audio** — see [The audio's job](#the-audios-job-ends-with-the-transcript).

### What gets captured

Both sides: **the system audio** (what you hear — Meet, Zoom, Teams) **and your
microphone**, mixed into one track.

The two platforms get there differently. Windows uses Electron's loopback.
macOS has no such thing, so a native helper captures system audio through
ScreenCaptureKit and the mixing happens in the app — which is why macOS asks for
the Screen Recording permission, and why without it you record only yourself.

Audio is written to disk **as it arrives**, already in the format the
transcriber consumes. A crash or a power cut costs you the tail of the meeting,
not the meeting: what was captured still plays and still transcribes, and the
app repairs the file's header on the next launch.

### While recording

- **Live waveforms** for system audio and microphone, with a gain slider each.
  The bars follow the real captured signal — if they move, audio is genuinely
  arriving. This is deliberately not an animation.
- **Timer.**
- **Mark** — flags the current moment. Use it when something matters and you do
  not want to interrupt. The marks are passed to the model afterwards with an
  instruction to make sure whatever was being discussed around each one is
  covered. There is also a global shortcut, **Ctrl/Cmd + Shift + M**, which
  works while you are looking at Zoom rather than at Yapper.
- **Pause** — stops writing. Nothing is captured while paused, and the file
  contains no gap.
- **Stop** — ends the meeting and starts the pipeline.

If the microphone delivers pure digital silence for several seconds — an asleep
wireless headset, a hardware mute — the app **says so on screen** rather than
letting a two-hour meeting record as nothing. The warning clears itself when the
device wakes up.

### The floating capsule

An always-on-top window, so you can see the recording without leaving the call.

At rest it is a **capsule** the size of its own clock: audio level plus timer.
**Hover** and it opens into the live transcript with controls — pause, mark,
stop, open the main window. Leave and it shrinks back. The **pin** keeps it open.

It is draggable, follows the light/dark theme, and cannot be dragged off-screen
or stranded by unplugging a monitor. Toggle: **Floating bubble**.

**Where it appears** is set with **Bubble starts** — any of the four corners,
top right by default: the bottom is the strip a video call fills with its own
controls. Changing it moves the capsule already on screen rather than waiting
for the next recording. On a MacBook with a notch, the top corners keep clear
of it even with the menu bar set to hide.

**Drag it anywhere.** The whole capsule is a handle — the controls and the
transcript are the only parts that are not — and it opens away from whichever
edges it is nearest, so one dropped in the middle of the screen does not jump
sideways to expand. It does not remember being dragged between meetings; the
corner above is where each one starts.

### While recording, the view changes

The options above are a page of settings, and once a meeting is running they
are settings nobody can change — so they fold into one line that says what was
chosen (*Meeting options — General · Concise*, click to reopen) and the
recording controls take the top: the clock, **Mark**, **Pause** and **Stop &
summarize** on the first line, the two meters full width below it. Stopping
puts everything back.

### The menu bar (macOS)

Yapper puts a mark next to the clock: **New meeting** when idle, **Stop
recording** once one is running, and a dot beside the mark while it is. The
app spends a meeting behind the call it is recording, and this is the way to
start or stop one without finding the window first.

### Knowing a recording is running

The sidebar's **New meeting** button becomes **Recording — 12:34** with a pip
while one is in progress. It is also the way back: open Action items or Search
mid-meeting and that button returns you to the stop control and the toggles.

### Meeting auto-detection

Yapper watches which app is holding the microphone — Zoom, Teams, Slack,
Discord, Webex, FaceTime, or a call in Chrome/Edge/Brave/Firefox/Safari — and
offers to take notes: a card inside the app, and a **system notification** for
when Yapper is not the window you are looking at.

On macOS that notification carries a real **Start recording** button. On Windows
the whole toast is the click target.

**It never starts recording on its own**, and the card does not switch views
under you.

Honest limits: it knows *an app is using the microphone*, not that a meeting
exists. It cannot tell a Meet call from any other browser tab using the mic, and
it knows no titles or attendees — there is no calendar integration. Toggle:
**Auto-detect meetings**. On macOS it needs 14.4 or newer.

### Importing audio instead of recording

**Import** takes any file Chromium can decode — mp3, m4a, opus, flac, ogg, wav,
mp4 — and converts it in-app to what the transcriber uses. No ffmpeg, no extra
dependency.

An imported file gets **the same treatment as a recorded meeting**: transcript,
notes, auto-title. If the name is generic (`recording`, `New Recording 3`,
`WhatsApp Audio…`, or just a date), the model titles it from what was actually
discussed.

Measured: a 2.5-minute `.m4a` takes 3 s end to end; a 24-minute `.webm`, 27 s.

---

## Transcription

### Live, during the meeting

The transcript appears as people speak. Confirmed text is shown solid, the
still-changing tail in grey.

A word is only confirmed when **two consecutive passes agree** on it, so
confirmed text does not rewrite itself under your eyes. Measured on a fast
machine: **2.6 s median** between speech and confirmation, worst case 4.8 s. The
grey tail appears sooner, around a second. If a passage is hard, a safety valve
confirms anything that has gone 1.5 s without agreement so the transcript cannot
freeze.

Long pauses start a new paragraph.

The live view is **a preview**. On stop, the whole recording is transcribed
again in one higher-quality pass, and that is what the notes are written from.

### How fast it runs on your machine

On first launch Yapper transcribes an 11-second sample and **measures** the
machine instead of guessing from the hardware name:

| Tier | Measured pass | Live transcript | Final pass |
|---|---|---|---|
| `fast` | ≤ 250 ms | yes, every 0.7 s | `small` |
| `steady` | ≤ 1200 ms | yes, every 2 s | `small` |
| `modest` | slower | none — text arrives after the meeting | `small` |

Anchors: an RTX 4080 lands at ~75 ms, an M4 Pro at ~102 ms, an i7-12700K on CPU
alone at ~736 ms. If the machine turns out slower than it measured — battery,
busy CPU — live **stretches its cadence** rather than falling further behind.

A two-hour meeting transcribes in about 115 seconds on a `fast` machine, roughly
63× real time.

---

## Notes

### Styles

Seven, each with its own sections:

| Style | For |
|---|---|
| **General** | the default: summary, key points, decisions, actions |
| **Minutes** | formal record: TL;DR, discussion, decisions, actions, next steps |
| **Memo** | for forwarding to someone who was not there — prose instead of bullets, neutral language, and it says explicitly when something was discussed but not decided |
| **Stand-up** | what each person did, is doing, and is blocked by |
| **1:1** | topics, feedback, agreements, actions |
| **Client call** | requirements, commitments, objections, follow-ups |
| **Brainstorm** | ideas, themes, what to explore |

Notes come out **in English**, as colour-coded cards: Summary (violet), Key
points (cyan), Decisions (green), Action items (amber), Open questions (pink),
Blockers/Risks (red), Next steps (teal).

Every heading carries **the timestamp where that topic starts**, so a note can
be traced back to the moment in the meeting.

### Automatic titles

Leave the title empty and the model names the meeting from what was discussed,
in two to six words. If the recording is too thin for that, it falls back to the
date.

### Editing, regenerating, reading aloud

- **Edit** — the notes are yours; change them and save.
- **↻ Regenerate** — rewrite any saved meeting's notes with a different style or
  detail level. The transcript is kept, so this costs one model call and no
  re-transcription.
- **Copy** — the whole note to the clipboard.
- **Read aloud** — speaks the notes, using the system voice.
- **Open folder** — the meeting on disk. Every meeting is a plain folder:
  `transcript.txt`, `notes.md`, `title.txt`. Nothing is locked in a database.

### Exporting

Five ways, from the Export menu:

| Export | What you get |
|---|---|
| **PDF** | the notes, formatted |
| **Markdown** | the notes as `.md` |
| **Transcript (Markdown)** | the full transcript, bold timestamps, a new paragraph after each long silence |
| **Transcript (.txt)** | plain text |
| **Both** | notes and transcript in one file |

---

## Across meetings

### Today

The view the app opens on: today's meetings, what they decided, the action items
they produced, and what needs attention — something transcribed but never
summarized, an overdue task, something flagged urgent.

Every line is a copy of something written in a note file, with a link back to
the meeting. **No model is involved**: it is instant, and it cannot say anything
that is not on disk.

### This week

A written review of the week, from the week's notes. Unlike Today, this one asks
a model — and everything it produces is **checked against the source**: a claim
citing a meeting that does not exist is thrown away rather than shown. If the
week has too little in it, the panel says so instead of inventing a summary.

### Action items

Every task from every meeting, in one list, with the meeting it came from and
its due date. Filterable, and completable from here.

They are extracted from what the notes **actually say**: `URGENT:` is not an
owner, an undated item never acquires a date, and restating the same task across
meetings merges rather than duplicating.

### Search, and asking questions

Search runs over every transcript and every note, locally, with no model: type
words, get passages, each carrying its meeting, date, timestamp and
participants. Clicking one opens that meeting.

You can also **ask a question**, which does use a model — but only over passages
retrieved from your own meetings, and the answer cites them. Ask about something
never discussed and it says it does not know, rather than inventing an answer.

### The sidebar

Every past meeting, newest first. Failed recordings (no audio) are dimmed and
labelled *Empty recording*.

**Deleting** always asks first, lists what the folder holds, and sends it to the
system trash — never an irreversible delete.

---

## Settings and behaviour

### Providers, keys and privacy

Six options for who writes the notes, from a Claude Code session to a fully
local Ollama model. Details in the install guides.

- Keys are **sealed with the OS keystore** (DPAPI on Windows, Keychain on
  macOS). The settings file never holds a readable key, and the key is never
  returned to the interface once saved.
- Each provider keeps **its own** key, model and endpoint — switching from
  Gemini to OpenRouter cannot send Google's key to OpenRouter.
- **Test connection** makes one minimal call and reports "working" or the real
  error. If a model id has been retired, it asks the endpoint what it does have
  and lists it.
- Free tiers usually **train on what you send**, and the app says so on screen
  when you pick one.

### The audio's job ends with the transcript

Once a meeting has a transcript, **its audio is deleted**. The transcript is the
record: it is what the notes come from, what you read, search and export.

That is 110 MB per hour that would otherwise be about 4.8 GB a month for one
daily meeting — and a recording of your colleagues is more sensitive than its
transcript. another meeting-notes app does the same.

The rules around it:

- The transcript is written **first**, the audio released after. A failure in
  between costs nothing.
- If transcription **fails**, the audio is kept so you can retry. That is what
  it is for.
- **Keep this meeting's audio** keeps it for *that meeting only*. It always
  starts off and turns itself off once it has done its job — switch it on before
  a sensitive meeting and you do not have to remember to switch it back.
- Meetings recorded before this behaviour existed keep their audio. The app
  tells you how much space they take and offers to reclaim it **when you ask**;
  it never deletes your recordings on its own.

### Everything else

- **Theme** — light and dark, everywhere including the capsule.
- **Start at login** — on by default, switchable.
- **Updates** — checked at launch and every four hours. **Windows** downloads in
  the background and applies on quit, or immediately from the sidebar pill.
  **macOS** shows *New version — download* and opens the releases page instead:
  Squirrel.Mac refuses unsigned updates, so it says so rather than promising a
  restart it cannot deliver. Updating there means dragging the new dmg over the
  old app and clearing Gatekeeper once more — but not re-downloading the engine,
  which lives outside the app, so it is ~95 MB rather than another 650 MB. Your
  meetings and permissions are untouched either way.
- **Reminders** — add your own, alongside the ones extracted from notes.

---

## What Yapper does not do

Stated plainly, so it is planned around rather than discovered:

- **No speaker labels.** The transcript does not say who said what. Typed
  participants help spelling and attribution in the notes, but the app does not
  know who is talking.
- **No calendar integration.** Detection knows a microphone is in use, not that
  "the 10:00 with Ana" is starting.
- **No mobile, no sync, no sharing, no accounts.** Meetings live on the machine
  that recorded them.
- **No playback** from the timestamps in the notes.
- **Notes are written in English**, whatever the language spoken.
- **macOS**: Apple Silicon only; auto-detection needs 14.4; updates only notify;
  the first open needs the Gatekeeper step.
