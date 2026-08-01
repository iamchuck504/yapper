// Where the floating capsule appears when a recording starts.
//
// It never remembered being dragged, so whatever corner it starts in is the
// corner it lives in — and the bottom right, which was the only choice, is the
// one a video call fills with its own controls. Hence a setting.
//
// The assertion is geometric, not "the setting was saved": the window has to
// actually land in the corner named, on the display the app is on, with the
// same inset each way.
const { app, screen, BrowserWindow } = require('electron');
const { sandbox, logger, mainWindow, watchdog } = require('./harness');

const ROOT = sandbox('bubble-corner');
const say = logger(ROOT);

let fails = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      esperaba ${JSON.stringify(want)}\n      obtuve   ${JSON.stringify(got)}`); }
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const INSET = 24;

const bubbleWindow = () => BrowserWindow.getAllWindows()
  .find(w => !w.isDestroyed() && w.webContents.getURL().includes('bubble.html'));

/** Which corner a window is actually sitting in, measured. */
function cornerOf(b, area) {
  const nearLeft = Math.abs(b.x - (area.x + INSET)) <= 2;
  const nearRight = Math.abs((b.x + b.width) - (area.x + area.width - INSET)) <= 2;
  // The top is no longer exactly area.y + INSET: on a Mac it stays below the
  // notch band even when the menu bar is hidden.
  const nearTop = b.y >= area.y && b.y <= area.y + INSET + 40;
  const nearBottom = Math.abs((b.y + b.height) - (area.y + area.height - INSET)) <= 2;
  const v = nearTop ? 'top' : nearBottom ? 'bottom' : '?';
  const h = nearLeft ? 'left' : nearRight ? 'right' : '?';
  return `${v}-${h}`;
}

app.whenReady().then(async () => {
  const timer = watchdog(say);
  try {
    require('../main.js');
    const win = await mainWindow();
    const $ = js => win.webContents.executeJavaScript(js, true);
    // The work area, origin included: on macOS it starts below the menu bar,
    // which is exactly what the first version of this got wrong.
    const work = screen.getPrimaryDisplay().workArea;

    check('the default is top right, clear of the call controls',
      await $('window.yapper.getBubbleCorner()'), 'top-right');

    await $('window.yapper.bubbleShow()');
    await pause(1200);
    const b0 = bubbleWindow();
    check('the bubble exists', !!b0);
    check('and it is born there', cornerOf(b0.getBounds(), work), 'top-right');

    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await $(`window.yapper.setBubbleCorner(${JSON.stringify(corner)})`);
      await pause(500);
      const b = bubbleWindow();
      check(`picking ${corner} moves it there there and then`,
        cornerOf(b.getBounds(), work), corner);
    }

    // Closing and reopening it is the real case: the next meeting.
    await $(`window.yapper.setBubbleCorner('top-left')`);
    await $('window.yapper.bubbleHide()');
    await pause(600);
    await $('window.yapper.bubbleShow()');
    await pause(1200);
    check('and the next recording opens it where it was left',
      cornerOf(bubbleWindow().getBounds(), work), 'top-left');

    // The notch. The work area normally starts below the menu bar, which on a
    // MacBook with a notch is tall enough to contain it — but with the bar set
    // to hide automatically it starts at the physical edge, and a capsule at
    // the top is cut in half. There is no API to ask about the notch, so what
    // is checked is that the top never sits flush against the edge.
    if (process.platform === 'darwin') {
      const d = screen.getPrimaryDisplay();
      await $(`window.yapper.setBubbleCorner('top-left')`);
      await pause(500);
      const top = bubbleWindow().getBounds();
      check('the top leaves room for the notch even when the bar hides',
        top.y - d.bounds.y >= 40);
      say(`  · menu bar: ${d.workArea.y - d.bounds.y} px | capsule at y=${top.y}`);
    }

    check('a made-up value is rejected',
      await $(`window.yapper.setBubbleCorner('middle')`), false);
    check('y no cambia lo guardado',
      await $('window.yapper.getBubbleCorner()'), 'top-left');
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
