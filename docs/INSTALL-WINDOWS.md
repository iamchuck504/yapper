# Installing Yapper on Windows

Everything you need from download to first recording. Nothing here needs
administrator rights.

## What you need

| | |
|---|---|
| Windows | 10 or 11, 64-bit |
| Disk | ~1 GB, or ~1.8 GB if you have an NVIDIA GPU |
| Internet | Only for the one-time engine download and, later, for the notes |
| Account | None. Yapper has no sign-up |

An NVIDIA GPU makes transcription several times faster, but nothing requires
one — the app measures your machine and adapts (see
[Tiers](FEATURES.md#how-fast-it-runs-on-your-machine)).

## 1. Download

**[github.com/iamchuck504/yapper-releases/releases/latest](https://github.com/iamchuck504/yapper-releases/releases/latest)**

Take `Yapper-Setup-<version>.exe` (~83 MB).

## 2. Run the installer, past the warning

Windows will show **"Windows protected your PC"**. This is SmartScreen reacting
to an installer that is not code-signed — a certificate costs money and identity
paperwork, and this build does not have one.

Click **More info**, then **Run anyway**.

The installer needs no admin rights, installs for your user only, and creates
the Start menu and desktop shortcuts. It finishes in a few seconds because the
heavy part comes next.

## 3. First launch downloads the engine

The installer ships the app, not the transcription engine. On first launch
Yapper downloads whisper.cpp and its models, with progress on screen:

- **~650 MB** on a CPU-only machine
- **~1.3 GB** if an NVIDIA GPU is detected — the extra is the CUDA build

Recording stays disabled until this finishes. It happens once. There is no
Python, no ffmpeg, no build tools, and nothing to configure.

Right after, the app plays an 11-second speech sample through the engine and
**measures your machine** to decide whether it can offer a live transcript. That
takes a few seconds and is stored, so it does not happen again.

## 4. Choose who writes the notes

Recording and transcription are entirely local and work with no account and no
key. **The notes are the part that needs a model**, and you pick which one in
the app.

If you have the [Claude Code](https://claude.com/code) CLI installed and signed
in, Yapper uses it by default with no key and no per-meeting cost.

Otherwise, open **New meeting → Notes by** and pick one:

| Provider | What it needs | Cost |
|---|---|---|
| **Claude Code** | the CLI installed and signed in | included in the subscription |
| **Google Gemini** | a free key from [aistudio.google.com](https://aistudio.google.com/apikey) — no card, about a minute | free |
| **OpenRouter** | your own key; its `:free` models do not charge | free or paid |
| **Ollama** | Ollama running on the same machine | free, fully local |
| **Anthropic API** | your own key | paid |
| **Other** | any OpenAI-compatible endpoint | depends |

Paste the key and press **Test connection** — it makes one minimal call and
answers either "working" or the real error, rather than failing later when you
are waiting for notes.

Keys are sealed with the Windows keystore (DPAPI). They are never written in
plain text and never reach the interface again once saved.

**Careful with free tiers:** most of them train on what you send. The app says
so on screen when you select one. For confidential meetings use Claude Code,
a paid API, or Ollama.

## 5. Record something

Press **New meeting**, then record. Yapper captures **both** the system audio —
what you hear: Meet, Zoom, Teams — and your microphone, mixed into one track.
Nothing else to set up.

See [FEATURES.md](FEATURES.md) for what everything does.

## Updating

Installed copies update themselves from the release feed: checked at launch and
every four hours, downloaded in the background, applied when you quit. If you
would rather not wait, the sidebar shows an **Update ready — restart** pill that
applies it immediately.

## Uninstalling

Settings → Apps → Yapper → Uninstall, as usual. Your meetings are **not**
deleted: they live in `Documents\Meetings` as ordinary folders, and removing
them is up to you.

## If something goes wrong

**SmartScreen gives no "Run anyway".** Some managed machines block unsigned
executables outright by policy. There is no workaround from this side; that is
what code signing buys.

**The engine download fails.** It comes from GitHub. If your network blocks it,
the app says so and you can retry from the same screen — a partial download is
discarded rather than left broken.

**Recording is greyed out.** The engine is still downloading, or the download
failed. The splash screen and the sidebar both report the state.

**Transcription is very slow.** Expected on an older CPU without a GPU: the app
falls back to a tier with no live transcript, and the full text still arrives
after the meeting. `npm test` is not needed to check this — the tier is shown in
the app's own settings.

**Notes never arrive.** That is the provider, not the transcription. Use **Test
connection**; the transcript is already saved either way and you can retry from
the meeting with **↻ Regenerate**.
