// End-to-end check of the off-screen rescue against real Electron APIs:
// creates a frameless window like the bubble, shoves it off the screen, and
// verifies the clamp brings it back inside the work area.
const { app, BrowserWindow, screen } = require('electron');
const { clampToArea } = require('../bounds');

const MARGIN = 8;

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  console.log('work area:', JSON.stringify(area));

  const win = new BrowserWindow({
    width: 420, height: 280, x: area.x + 200, y: area.y + 200,
    frame: false, transparent: true, show: false, skipTaskbar: true
  });

  const rescue = () => {
    const b = win.getBounds();
    const c = clampToArea(b, screen.getDisplayMatching(b).workArea, MARGIN);
    if (c.x !== b.x || c.y !== b.y) win.setBounds(c);
  };

  const cases = [
    ['arrastrada arriba', { x: area.x + 600, y: area.y - 240 }],
    ['arrastrada a la izquierda', { x: area.x - 380, y: area.y + 300 }],
    ['arrastrada a la derecha', { x: area.x + area.width - 30, y: area.y + 300 }],
    ['arrastrada abajo', { x: area.x + 500, y: area.y + area.height - 20 }]
  ];

  let failed = 0;
  for (const [name, pos] of cases) {
    win.setBounds({ ...pos, width: 420, height: 280 });
    rescue();
    const b = win.getBounds();
    const inside = b.x >= area.x && b.y >= area.y
      && b.x + b.width <= area.x + area.width
      && b.y + b.height <= area.y + area.height;
    if (!inside) failed++;
    console.log(`${inside ? 'PASS' : 'FAIL'}  ${name} -> x=${b.x} y=${b.y}`);
  }

  // the header (top 44px) must be reachable, which is the whole point
  const b = win.getBounds();
  const headerVisible = b.y >= area.y && b.y + 44 <= area.y + area.height;
  console.log(`${headerVisible ? 'PASS' : 'FAIL'}  the header stays reachable`);
  if (!headerVisible) failed++;

  console.log(failed ? `\n${failed} fallo(s)` : '\ntodo bien');
  win.destroy();
  app.exit(failed ? 1 : 0);
});
