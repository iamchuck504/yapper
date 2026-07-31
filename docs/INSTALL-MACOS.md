# Installing Yapper on macOS

Everything from download to first recording, including the two places macOS will
stop you and why.

## What you need

| | |
|---|---|
| Mac | **Apple Silicon** (M1 or newer). Intel Macs are not supported |
| macOS | **13 or newer**. Meeting auto-detection additionally needs 14.4 |
| Disk | ~800 MB |
| Internet | Only for the one-time engine download and, later, for the notes |
| Account | None. Yapper has no sign-up |

Transcription runs on the GPU through Metal. On an M4 Pro a pass takes ~102 ms,
which is comfortably in the fastest tier — you get a live transcript during the
meeting.

## 1. Install

There are two ways in, and they differ only in how much of §2 you have to read.

**The short way — one command, nothing to click**

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
```

It downloads the app, checks it against the checksum published with the
release, puts it in `/Applications` and opens it. No Gatekeeper detour — see
§2 for exactly why, because the reason matters.

Piping a script into a shell is a real thing to be careful about. The script
is short and readable, so read it first if you like:

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | less
```

**The ordinary way — the dmg**

**[github.com/iamchuck504/yapper-releases/releases/latest](https://github.com/iamchuck504/yapper-releases/releases/latest)**

Take `Yapper-<version>-arm64.dmg` (~95 MB), open it, drag Yapper to
Applications. Then §2 applies.

## 2. Gatekeeper, and why the two ways differ

This is the awkward part, and it is worth understanding rather than just
working around.

The app is **signed ad-hoc** — with its own identity, not with an Apple
Developer certificate. Apple charges $99/year for one, and this build does not
have it. It is not a judgement about the app; it is the absence of a paid
signature.

What actually triggers the block is narrower than it looks. macOS is not
inspecting the app and objecting — it is reacting to `com.apple.quarantine`,
an attribute your **browser** attaches to anything it downloads. `curl` does
not attach it, which is the whole of the difference: the installer above lands
an app with no quarantine flag, so nothing blocks it.

**What that costs.** Apple is not vouching for those bytes either way — no
certificate means no notarization, whichever route you take. What the
installer puts in its place is a checksum: it verifies the download against
the sha512 published in the release manifest and refuses to install on a
mismatch. That catches a corrupted or tampered download. It does **not**
protect you if the release feed itself is compromised, since the manifest and
the app come from the same place. Installing this way means trusting whoever
publishes that repo.

**If you took the dmg instead**, macOS will block the first open. Since
macOS 15 the old right-click → Open trick no longer works. Two ways through:

**Option A — System Settings (no Terminal)**

1. Double-click Yapper. macOS refuses and offers only *Done*.
2. Open **System Settings → Privacy & Security**, scroll down. There is now a
   line saying Yapper was blocked, with an **Open Anyway** button. It appears
   for about an hour after the attempt.
3. Click it, confirm, and Yapper opens. You only do this once.

**Option B — Terminal (one command)**

```bash
xattr -dr com.apple.quarantine /Applications/Yapper.app
```

This removes the quarantine flag macOS attaches to downloaded files. The app
then opens normally, forever.

## 3. First launch downloads the engine

The dmg ships the app, not the transcription engine. On first launch Yapper
downloads whisper.cpp — built for Metal — and its models, about **650 MB** in
all, with progress on screen. This happens once.

**You do not wait for all of it.** The first ~160 MB is everything needed to
record; at that point the app opens and the button works, while the larger
model keeps downloading behind it. If you finish a meeting before it lands,
the recording is saved and transcribed as soon as it does — the wait moves to
a place where nothing is at stake. During that window the live transcript runs
on the smaller model, so it is a little rougher than it will be later.

Then it plays an 11-second speech sample through the engine and measures your
machine, which takes a few seconds and is remembered.

**If the download is interrupted** — wifi drops, or you quit — it picks up
from where it stopped rather than starting the 490 MB model again. Reopening
Yapper resumes it.

## 4. The two permissions

The **first time you record**, macOS asks for two things.

### Microphone — obvious, and a normal prompt

Allow it. Without it nothing is recorded at all.

### Screen Recording — not obvious, and the important one

This is what lets Yapper capture **what your Mac is playing** — the other side
of the call. Without it you record only yourself: on speakers your microphone
picks up some of the other person, and on headphones you lose them completely.

**No screen content is ever read, shown or stored.** The capture is configured
down to a 2×2 pixel frame once a second and thrown away; only the audio is kept.
The reason the permission is called Screen Recording is that macOS provides no
audio-only permission to ask for — ScreenCaptureKit is the supported way to get
system audio, and it lives under that switch.

It is **not** a simple yes/no prompt — it takes three steps, and Yapper does
two of them for you. When it notices the permission is missing it offers:

- **Open Settings** — jumps straight to Privacy & Security → Screen Recording,
  where you turn Yapper on
- **Quit and reopen** — because **macOS does not apply the grant to an app that
  was already running.** Skipping this is the reason people grant the
  permission and still record only themselves

The reopen button waits if you are mid-recording: quitting then would throw the
meeting away. Stop first and it becomes available.

If you skip the whole thing, Yapper records anyway and says on screen that only
your microphone is being captured. You can grant it later; the meetings you
already recorded keep whatever they captured at the time.

## 5. Record something

Press **New meeting**, then record. See [FEATURES.md](FEATURES.md) for what
everything does.

While recording, **Yapper keeps your screen from sleeping**. That is not a
preference: ScreenCaptureKit offers nothing to capture while the display is
asleep, so a meeting you mostly listen to would quietly lose the far side
halfway through. The block is released the moment you stop.

## Choosing who writes the notes

Recording and transcription are local and need no account. The notes need a
model, chosen in **New meeting → Notes by**:

| Provider | What it needs | Cost |
|---|---|---|
| **Claude Code** | the CLI installed and signed in | included in the subscription |
| **Google Gemini** | a free key from [aistudio.google.com](https://aistudio.google.com/apikey) — no card | free |
| **OpenRouter** | your own key; `:free` models do not charge | free or paid |
| **Ollama** | Ollama running locally | free, fully local |
| **Anthropic API** | your own key | paid |
| **Other** | any OpenAI-compatible endpoint | depends |

Yapper finds the Claude CLI even though apps launched from the Dock get a bare
PATH — `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` are all checked.

Keys are sealed with the macOS Keychain, never written in plain text, and never
returned to the interface after saving. **Careful with free tiers:** most train
on what you send, and the app says so when you pick one.

## Updating

macOS copies **do not update themselves**. Squirrel.Mac refuses to apply an
unsigned update, so the app does the honest thing instead of promising a restart
it cannot deliver: it checks the same feed at launch and every four hours, and
when there is something newer the sidebar shows

> **New version v0.1.1 — download**

which opens the releases page.

**What updating actually involves:**

Re-run the installer. It quits the running copy, replaces it and reopens it:

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
```

Or, the dmg way: download the new one, drag Yapper into Applications, and **do
the Gatekeeper step again** — the new download carries its own quarantine flag,
so either *Open Anyway* in System Settings or
`xattr -dr com.apple.quarantine /Applications/Yapper.app`.

Either way:

- **The engine and models are not downloaded again** — they live in
  `~/Library/Application Support/yapper`, outside the app — so an update is
  ~95 MB rather than another 650 MB.
- **Your meetings are untouched.** They are in `~/Documents/Meetings` and have
  nothing to do with the app bundle.
- Permissions stay granted, since the bundle id does not change.

When the project has an Apple Developer certificate, none of this is needed and
updates install themselves as they do on Windows.

## Uninstalling

Drag `/Applications/Yapper.app` to the Trash. Your meetings are **not** deleted:
they live in `~/Documents/Meetings` as ordinary folders. To remove everything
else:

```bash
rm -rf ~/Library/Application\ Support/yapper
```

That directory holds settings and the downloaded engine (~600 MB).

## If something goes wrong

**"Yapper is damaged and can't be opened."** macOS says this for a quarantined
app it cannot verify. Option B above (`xattr -dr`) clears it.

**No sound from the other side of the call.** Screen Recording is not granted,
or — far more often — was granted without reopening the app. Yapper says so on
screen while recording and offers both steps as buttons; take the **Quit and
reopen** one, because that is the half that is easy to skip.

**No notification when a meeting starts.** Meeting auto-detection needs macOS
14.4 or newer. Below that everything else works and the offer simply never
appears. On 14.4+, check that notifications are allowed for Yapper in System
Settings, and that **Auto-detect meetings** is on in the app.

**The app opens but recording is greyed out.** The engine is still downloading
or the download failed; the splash and sidebar report which.

**Notes never arrive.** That is the provider, not the transcription. Use **Test
connection**. The transcript is saved regardless, and **↻ Regenerate** retries.
