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
  // Arriba ya no es exactamente area.y + INSET: en Mac se mantiene por debajo
  // de la franja del notch aunque la barra de menús esté oculta.
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

    check('el default está a la izquierda, lejos de los controles de la llamada',
      await $('window.yapper.getBubbleCorner()'), 'bottom-left');

    await $('window.yapper.bubbleShow()');
    await pause(1200);
    const b0 = bubbleWindow();
    check('la burbuja existe', !!b0);
    check('y nace ahí', cornerOf(b0.getBounds(), work), 'bottom-left');

    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      await $(`window.yapper.setBubbleCorner(${JSON.stringify(corner)})`);
      await pause(500);
      const b = bubbleWindow();
      check(`elegir ${corner} la mueve ahí en el momento`,
        cornerOf(b.getBounds(), work), corner);
    }

    // Cerrarla y reabrirla es el caso de verdad: la próxima reunión.
    await $(`window.yapper.setBubbleCorner('top-left')`);
    await $('window.yapper.bubbleHide()');
    await pause(600);
    await $('window.yapper.bubbleShow()');
    await pause(1200);
    check('y la siguiente grabación la abre donde quedó',
      cornerOf(bubbleWindow().getBounds(), work), 'top-left');

    // El notch. El área útil normalmente empieza bajo la barra de menús, que en
    // una MacBook con notch es lo bastante alta para contenerlo — pero con la
    // barra en ocultarse automáticamente empieza en el borde mismo, y ahí una
    // cápsula arriba queda partida. No hay API para preguntar por el notch, así
    // que se comprueba que arriba nunca se pegue al borde físico.
    if (process.platform === 'darwin') {
      const d = screen.getPrimaryDisplay();
      await $(`window.yapper.setBubbleCorner('top-left')`);
      await pause(500);
      const top = bubbleWindow().getBounds();
      check('arriba deja sitio para el notch aunque la barra se oculte',
        top.y - d.bounds.y >= 40);
      say(`  · barra de menús: ${d.workArea.y - d.bounds.y} px | cápsula en y=${top.y}`);
    }

    check('un valor inventado se rechaza',
      await $(`window.yapper.setBubbleCorner('middle')`), false);
    check('y no cambia lo guardado',
      await $('window.yapper.getBubbleCorner()'), 'top-left');
  } catch (err) {
    fails++;
    say('FAIL  ' + (err.stack || err.message));
  }
  clearTimeout(timer);
  say(fails ? `\n${fails} fallos` : '\nPASS');
  app.exit(fails ? 1 : 0);
});
