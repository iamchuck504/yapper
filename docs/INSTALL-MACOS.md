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

There are two supported ways in.

**The short way — one command, nothing to click**

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | bash
```

It downloads the app, checks it against the checksum published with the
release, puts it in `/Applications` and opens it.

Piping a script into a shell is a real thing to be careful about. The script
is short and readable, so read it first if you like:

```bash
curl -fsSL https://github.com/iamchuck504/yapper-releases/releases/latest/download/install.sh | less
```

**The ordinary way — the dmg**

**[github.com/iamchuck504/yapper-releases/releases/latest](https://github.com/iamchuck504/yapper-releases/releases/latest)**

Take `Yapper-<version>-arm64.dmg` (~95 MB), open it, drag Yapper to
Applications, then open it normally.

Drag it across before you open it. Yapper runs from inside the dmg, but a copy
started there is not installed anywhere — macOS may even give it a temporary
read-only home of its own — so **Start at login** and **Uninstall Yapper…** are
both refused from it, with a line saying why. They work once Yapper is in an
Applications folder.

## 2. Gatekeeper verification

Release builds are signed with the Developer ID Application certificate for
team `54H77VDNJY`, use hardened runtime and are submitted to Apple's notary
service. Gatekeeper can therefore verify both the publisher and Apple's
notarization ticket when the dmg is downloaded in a browser. Both the app
inside the update zip and the final dmg receive their own stapled tickets.

The command-line installer remains useful for automation. It verifies sha512
against `latest-mac.yml`, the Developer ID signature and expected team, the
stapled notarization ticket, and Gatekeeper acceptance before replacing an
installed copy. If activation fails it restores the previous app. If a freshly
downloaded dmg is ever rejected, do not remove quarantine as a workaround:
verify that the asset belongs to the current signed/notarized release.

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

**Yapper asks for both when it first opens**, not when you press record.
macOS would otherwise ask in the middle of a meeting — and the system-audio
one is not a yes/no, it needs the app reopened before it applies, so answering
it mid-call still leaves that call recorded one-sided.

### Microphone — obvious, and a normal prompt

Allow it. Without it nothing is recorded at all.

### System Audio Recording Only — not obvious, and the important one

This is what lets Yapper capture **what your Mac is playing** — the other side
of the call. Without it you record only yourself: on speakers your microphone
picks up some of the other person, and on headphones you lose them completely.

The permission does exactly what its name says. Yapper reads the audio the
machine is playing, through a Core Audio process tap, and nothing else — no
screen, no windows, no other app's data.

**On macOS 13 this permission does not exist**, and the only route to system
audio there is ScreenCaptureKit, which lives under **Screen Recording**. Yapper
falls back to it automatically and asks for that instead. It is a wide
permission to be asked for audio, which is why it is the fallback and not the
default: no screen content is ever read, shown or stored — the video side is
configured down to a 2×2 pixel frame once a second and thrown away.

Either way it is **not** a simple yes/no prompt. It takes three steps, and
Yapper does two of them for you. When it notices the permission is missing it
offers:

- **Open Settings** — jumps straight to the right pane, where you turn Yapper on
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

**Your screen is left alone.** On macOS 14.4+ system audio comes from a
process tap, which does not care whether the display is on, so a meeting you
mostly listen to can dim the screen as usual. On macOS 13, where the capture
runs through ScreenCaptureKit, the display *is* held awake for the length of
the recording — that route offers nothing to capture while the screen is
asleep, and the far side would go missing halfway through.

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

## Start at login

Off until you turn it on, in **Settings → Start at login**. Nothing registers
Yapper to open at login on your behalf.

**It only works from an Applications folder on the startup disk** —
`/Applications`, or the `Applications` folder in your own home. Anywhere else
the switch says so and stays off: a copy in Downloads, on a mounted disk image,
in a temporary folder, or in the read-only copy macOS makes of an app opened
outside Applications. The reason is that macOS records *this copy*, and a
location Yapper cannot promise will still mean this copy tomorrow is not one
worth recording. Being able to write to a folder is not the same as being
installed in it, so that is not what Yapper goes by.

The folder's *name* is not what Yapper goes by either. It checks which mounted
volume the app is really on, so an `Applications` folder that is a link to an
external drive, a disk image mounted at that path, or a home directory that
lives on a network share are all refused the same way a copy in Downloads is —
they look identical from the outside and none of them survives being unplugged.
Your home folder being somewhere else does not make that somewhere else count
as the startup disk.

That volume answer is asked for the app's exact current path, not inferred from
a device number or a cached list of disks. The same path is checked again before
anything is handed to the Trash, so mounting a disk over a folder or replacing
the app after it started makes the removal stop rather than change its target.

Deliberate limit: an Applications folder kept on an **external disk** is refused
rather than registered and hoped for. If you want Yapper to open at login, keep
it on the startup disk. If Yapper cannot work out which disk it is on at all, it
changes nothing and shows an indeterminate switch; clicking it retries the read
instead of guessing on or off.

The switch reports macOS rather than its own memory of what you asked for.
macOS 13 and later keeps that registration itself, which means three things
worth knowing:

- If you turn it off in **System Settings → General → Login Items** (**Login
  Items & Extensions** on macOS 15 and up), Yapper agrees with you. It does not
  turn itself back on at the next launch.
- macOS sometimes registers Yapper but waits for you to allow it there before
  it takes effect. The switch stays **on** in that case and says what it is
  waiting for — switching it off withdraws the registration, so you are never
  stuck with an entry you cannot take back from inside Yapper.
- If macOS refuses outright, the switch goes back to off and says so, rather
  than showing on while nothing starts at login.

## Updating

Signed macOS copies check the release feed at launch and every four hours. The
update downloads in the background; when it is ready the sidebar shows

> **Update v0.1.1 ready — restart**

Click it to apply immediately, or close Yapper normally and it installs on
quit. An active recording is never interrupted for an update.

Either way:

- **The engine and models are not downloaded again** — they live in
  `~/Library/Application Support/yapper`, outside the app — so an update is
  ~95 MB rather than another 650 MB.
- **Your meetings are untouched.** They are in `~/Documents/Meetings` and have
  nothing to do with the app bundle. They are ordinary unencrypted files;
  FileVault protects them while the Mac is locked. If iCloud Drive manages your
  Documents folder, macOS may sync them even though Yapper never uploads audio.
- Permissions stay granted, since the bundle id does not change.

## Uninstalling

**Yapper → Uninstall Yapper…**, from the menu bar. Before it touches anything
it works out every location involved — the app, its settings, the downloaded
engine and your meetings — and proves how each one relates to the app it is
about to move. If it cannot *show* that the requested removal is safe, it stops
there and removes nothing, the login item included. "Cannot show" includes not
being able to read where a folder really is: an unreadable path might be inside
the app, so it is treated as though it were.

Those locations are checked whether or not the checkbox is ticked, because the
app moves to the Trash either way. If your settings or the engine turn out to
live *inside* it — which
`YAPPER_HOME` or `LOCALAPPDATA` can arrange — then leaving the box unticked is
refused, since moving the app would delete data you had just declined to
delete; ticking it goes ahead, and those files are removed by the app's own
move rather than a second time. A settings folder that *contains* the app is
refused whatever the box says: that is your folder, not Yapper's to delete.

The whole check runs again after you answer the dialog, not only before it, so
changes while the dialog is open are caught before anything is removed. Each
existing target carries the directory identity and mounted volume that passed
that last check; both are read again immediately before Yapper calls the
system's path-based Trash API. That narrows the final filesystem race but does
not claim an atomic move-by-identity that the API cannot provide. The meetings
folder is proved again at the same moment, so changing its symlink or replacing
it stops the removal. On a fresh install where that folder does not exist yet,
its canonical name must remain absent through the same check. A data location
that is already absent is not left in the executable plan. Data mounted
separately inside the app is refused rather than called covered by the app's
own move, and every covered data location must still be the same one when the
bundle reaches the Trash.

Then, in order: it stops itself opening at login, checks with macOS that it
really has, moves itself to the Trash, and — only if you tick the box — moves
its settings and the downloaded engine to the Trash too. Your meetings are
**not** deleted. They live in `~/Documents/Meetings` as ordinary folders, and no
step is allowed to name a path that is the meetings folder, contains it, or sits
inside it.

If any step cannot be completed it stops there and says so, rather than
half-removing the app. If it cannot withdraw the login item, nothing is moved.
If the Trash refuses the app — a copy installed for every user is owned by
`root` — your settings and meetings are left alone. If it could not remove the
settings or the engine, or could not prove one of them safe to remove, it tells
you which path Yapper left alone or the Trash refused; it does not claim an
unreadable path still exists when it cannot prove that.

The entry only appears in a copy that is really installed, in an Applications
folder on the startup disk. From a disk image or a temporary folder the bundle
you are running is not the one you keep, so there is nothing there worth
removing.

Prefer that to dragging the app to the Trash yourself. macOS keeps the "open at
login" registration in its own database rather than inside the app, so deleting
the app strands an entry that System Settings goes on listing with nothing
behind it. If you have already dragged it to the Trash, remove that entry by
hand in System Settings → General → **Login Items** (**Login Items &
Extensions** on macOS 15 and up), and then:

```bash
rm -rf ~/Library/Application\ Support/yapper
```

That directory holds settings and the downloaded engine (~600 MB).

## If something goes wrong

**"Yapper is damaged and can't be opened."** Do not bypass this warning. Delete
that copy, download the current dmg again, and confirm it came from the Yapper
release page. A current notarized build should verify normally.

**No sound from the other side of the call.** The system-audio permission is
not granted, or — far more often — was granted without reopening the app.
Yapper says so on screen while recording and offers both steps as buttons; take
the **Quit and reopen** one, because that is the half that is easy to skip.

**No notification when a meeting starts.** Meeting auto-detection needs macOS
14.4 or newer. Below that everything else works and the offer simply never
appears. On 14.4+, check that notifications are allowed for Yapper in System
Settings, and that **Auto-detect meetings** is on in the app.

**The app opens but recording is greyed out.** The engine is still downloading
or the download failed; the splash and sidebar report which.

**Notes never arrive.** That is the provider, not the transcription. Use **Test
connection**. The transcript is saved regardless, and **↻ Regenerate** retries.
