# Windows release checklist

Use this checklist for the next Yapper Windows release. Run it on a real
Windows 10 or 11 x64 host; the macOS build and static parity tests are not
Windows runtime sign-off.

This is an evergreen checklist. Set `$version` from `package.json`; never copy a
version or commit from an older handoff. A Mac may already have created
`v$version` and carried the last Windows installer forward to keep `latest.yml`
available. Those carried files preserve the feed but are not Windows sign-off.
`npm run release` now handles both cases: it creates a Windows-first release or
replaces the carried Windows assets inside an existing Mac-first release.

Windows packaging remains unsigned, so SmartScreen is expected.

## 1. Choose the release commit and version

- [ ] Finish and review the macOS runtime checks.
- [ ] Merge the intended feature branch into the release branch.
- [ ] Confirm the worktree is clean and record the exact commit SHA.
- [ ] Set `$version = (Get-Content package.json -Raw | ConvertFrom-Json).version`.
- [ ] Confirm `package.json`, `package-lock.json`, and the release checkout all
  say `$version`; do not bump again merely because the macOS release exists.
- [ ] Confirm CI is green on both `windows-2025` and `macos-15`.

## 2. Prepare the Windows host

- [ ] Use a Windows 10 or 11 x64 host, preferably a disposable VM/snapshot.
- [ ] Run a fresh `npm ci` with the repository's supported Node/npm versions.
- [ ] Authenticate GitHub CLI for `iamchuck504/yapper-releases`.
- [ ] Leave enough space for the app, test packages, CPU engine, and optional
  CUDA engine.
- [ ] Back up real `Documents\Meetings` and Yapper settings before installer or
  updater tests.
- [ ] Close production Yapper recordings before running any test.

## 3. Build-only gates — do not publish

- [ ] `npm ci`
- [ ] `npm run test:windows:package` (runs the automated pure, Electron,
  dependency, icon, unpacked-build, package-verification, installer, and
  update-manifest gates)
- [ ] `npm test`
- [ ] `npm audit --audit-level=high`
- [ ] `npx electron-builder --win --dir --publish never`
- [ ] `node build/verify-package.js dist/win-unpacked`
- [ ] `npm run dist -- --publish never`
- [ ] Confirm the selected version appears in:
  - `dist/Yapper-Setup-<version>.exe`
  - `dist/Yapper-Setup-<version>.exe.blockmap`
  - `dist/latest.yml`
- [ ] Inspect `latest.yml`: version, URL, size, and SHA-512 must match the
  installer.
- [ ] Run `git diff --check` and confirm packaging did not modify tracked files.

## 4. Runtime sanity checks

Use an isolated `YAPPER_HOME` wherever the test supports it.

- [ ] Launch the unpacked/package build and keep it alive for at least ten
  seconds.
- [ ] Run the Electron UI tests listed in README, at minimum:
  - `build/test-smoke.js`
  - `build/test-record-cycle.js`
  - `build/test-two-track-app.js`
  - `build/test-mic-permission-ui.js`
  - `build/test-import.js`
  - `build/test-tray.js`
  - `build/test-app-menu.js`
- [ ] Run `npx electron build/icon-verify.js`; inspect desktop, Start menu, taskbar,
  Alt-Tab, and pinned icons.
- [ ] Install the NSIS EXE as a normal user and confirm it needs no admin
  rights.
- [ ] Confirm the documented unsigned SmartScreen flow still matches reality.
- [ ] Confirm Start menu and desktop shortcuts launch the installed executable.
- [ ] Confirm **Start with Windows** is on by default, targets the installed
  executable, toggles off/on correctly, and does not inherit macOS behavior.
- [ ] Confirm the meeting-detected notification reaches Action Center with
  `build/probe-notify.js`.
- [ ] Record a short real call and prove microphone and system/loopback audio
  are both present.
- [ ] Confirm the transcript is persisted before audio is released.
- [ ] Generate notes from a transcript containing `Speaker 1`/`Speaker 2` and
  confirm the notes use real assigned names or neutral prose, never numbered
  speaker labels. A task assigned by direct address must still retain its real
  named owner.
- [ ] Test CPU engine provisioning; test NVIDIA/CUDA provisioning if hardware
  is available.
- [ ] Confirm settings and API keys survive an in-place update and remain
  sealed with DPAPI.
- [ ] Uninstall through **Settings → Apps → Yapper → Uninstall**; meetings must
  remain.

## 5. Auto-update gate

This installs disposable local versions. Do not run it during a real recording.

- [ ] Run:
  `powershell -ExecutionPolicy Bypass -File build\e2e-update.ps1`
- [ ] Confirm the old version installs, discovers the local feed, downloads the
  new installer, updates on quit, and reports `PASS`.
- [ ] Confirm this test did not contact or modify a production GitHub release.
- [ ] If a draft/staged route is available, test one installed copy against the
  intended GitHub feed before broad distribution.

## 6. Publish Windows only after every gate passes

- [ ] Reconfirm `gh auth status`.
- [ ] Run the release driver from the exact verified checkout. It repeats the
  automated Windows suite and exact installer lifecycle before upload:

  ```powershell
  npm run release
  ```

- [ ] Verify `v$version` contains `Yapper-Setup-$version.exe`, its blockmap and
  `latest.yml`, with no carried older Windows installer left beside them.
- [ ] Download the three published Windows files and verify `latest.yml` URL,
  size, and SHA-512 against the downloaded installer.
- [ ] Confirm an installed copy of the previous public Windows version
  discovers and applies `$version`.
- [ ] Verify the release still contains the already-published macOS assets:
  - `latest-mac.yml`;
  - DMG and ZIP plus blockmaps;
  - `install.sh`.
- [ ] Confirm an existing Mac still sees its feed; a Windows-only release must
  not strand `latest-mac.yml`.
- [ ] Edit the release notes with the real version and source commit for each
  platform, the runtime checks completed, and the unsigned/SmartScreen limit.

## Not signed off without a Windows host

The current macOS and static checks do not prove:

- real WASAPI/Electron loopback capture;
- Windows notification delivery;
- registry/login-item behavior;
- NSIS installation, removal, and shortcut repair;
- DPAPI behavior;
- CUDA provisioning;
- the complete updater replacement cycle;
- SmartScreen behavior on managed and unmanaged Windows machines.
