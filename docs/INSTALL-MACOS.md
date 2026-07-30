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

## 1. Download

**[github.com/iamchuck504/yapper-releases/releases/latest](https://github.com/iamchuck504/yapper-releases/releases/latest)**

Take `Yapper-<version>-arm64.dmg` (~95 MB). Open it and drag Yapper to
Applications, as usual.

## 2. Gatekeeper will block the first open

This is the awkward part, and it is worth understanding rather than just
working around.

The app is **signed ad-hoc** — with its own identity, not with an Apple
Developer certificate. Apple charges $99/year for one, and this build does not
have it, so Gatekeeper refuses to open it. It is not a judgement about the app;
it is the absence of a paid signature.

**Since macOS 15, the old right-click → Open trick no longer works** for
unsigned apps. Two ways through:

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
downloads whisper.cpp — built for Metal — and its models, about **650 MB**, with
progress on screen. Recording stays disabled until it lands. This happens once.

Then it plays an 11-second speech sample through the engine and measures your
machine, which takes a few seconds and is remembered.

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

It is **not** a simple yes/no prompt:

1. macOS shows a dialog pointing at System Settings.
2. Open **System Settings → Privacy & Security → Screen Recording**.
3. Turn Yapper on.
4. **Quit and reopen Yapper.** macOS does not apply it to a running app.

If you skip it, Yapper records anyway and says on screen that only your
microphone is being captured. You can grant it later and record again.

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
unsigned update, so instead the app checks the same feed and turns the sidebar
pill into **New version — download**, which opens the releases page. Download the
new dmg and drag it over the old app.

The quarantine step is only needed the first time, unless you delete the app.

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
or was granted without reopening the app. Check System Settings → Privacy &
Security → Screen Recording, then quit and reopen Yapper. The app also says so
on screen while recording.

**No notification when a meeting starts.** Meeting auto-detection needs macOS
14.4 or newer. Below that everything else works and the offer simply never
appears. On 14.4+, check that notifications are allowed for Yapper in System
Settings, and that **Auto-detect meetings** is on in the app.

**The app opens but recording is greyed out.** The engine is still downloading
or the download failed; the splash and sidebar report which.

**Notes never arrive.** That is the provider, not the transcription. Use **Test
connection**. The transcript is saved regardless, and **↻ Regenerate** retries.
