// Shared plumbing for the tests that drive the real app.
//
// Every one of them needs the same three things, and each got them slightly
// wrong on its own. In particular: waiting for 'did-finish-load' only works if
// you attach the listener before the load finishes. Attach it a moment late —
// which is a race, so it happens sometimes and not others — and the event never
// comes again and the test hangs forever with nothing printed.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

/**
 * A throwaway Documents + userData for a test, so nothing it does can touch a
 * real meeting. Survives a previous run that was killed and still holds a lock
 * on its Chromium cache: failing to clean up is not a reason to fail to run.
 */
function sandbox(name) {
  // Main uses this to suppress integration with the real Windows shell. A
  // throwaway userData directory is not enough: Desktop, Start menu and pinned
  // shortcuts still belong to the signed-in user unless explicitly gated.
  process.env.YAPPER_TEST = '1';
  const base = path.join(app.getPath('temp'), `yapper-${name}`);
  let root = base;
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    root = `${base}-${process.pid}`;
  }
  fs.mkdirSync(path.join(root, 'Meetings'), { recursive: true });
  app.setPath('documents', root);
  app.setPath('userData', path.join(root, 'user'));
  return root;
}

/** Print to stdout and to a file, because Electron holds stdout until it exits. */
function logger(root) {
  const file = path.join(root, 'progress.log');
  console.log(`live progress: ${file}`);
  return line => {
    console.log(line);
    try { fs.appendFileSync(file, line + '\n'); } catch { /* nothing to do */ }
  };
}

/** The app's main window, loaded and settled. Never waits forever. */
async function mainWindow({ timeoutMs = 60000, settleMs = 1000 } = {}) {
  const started = Date.now();
  const win = await new Promise((resolve, reject) => {
    const tick = setInterval(() => {
      const w = BrowserWindow.getAllWindows()
        .find(x => !x.isDestroyed() && x.webContents.getURL().includes('index.html'));
      if (w) { clearInterval(tick); resolve(w); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error('the main window never appeared'));
      }
    }, 150);
  });

  // The race: if the page already finished loading, the event will not fire
  // again, so only wait when there is actually something to wait for.
  if (win.webContents.isLoading()) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the window never finished loading')), timeoutMs);
      win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
    });
  }
  await new Promise(r => setTimeout(r, settleMs));
  return win;
}

/** Fail loudly instead of hanging silently. */
function watchdog(say, ms = 180000) {
  return setTimeout(() => {
    say(`FAIL  the test hung: nothing finished in ${ms / 1000} s`);
    app.exit(1);
  }, ms);
}

/** Bound the wait on one step, and name it when it stalls. */
function within(promise, label, ms = 30000) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`"${label}" did not respond in ${ms / 1000} s`)), ms))
  ]);
}

module.exports = { sandbox, logger, mainWindow, watchdog, within };
