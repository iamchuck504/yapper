// Where does the capsule actually land at birth, measured over time.
const { app, screen, BrowserWindow } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');
const ROOT = sandbox('corner-probe');
const say = logger(ROOT);

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1200 });
  const $ = js => win.webContents.executeJavaScript(js, true);
  const area = screen.getPrimaryDisplay().workArea;
  say(`workArea: ${JSON.stringify(area)}  bounds: ${JSON.stringify(screen.getPrimaryDisplay().bounds)}  scale: ${screen.getPrimaryDisplay().scaleFactor}`);
  say(`corner setting: ${await $('window.yapper.getBubbleCorner()')}`);

  await $('window.yapper.bubbleShow()');
  for (let t = 0; t <= 1500; t += 300) {
    const b = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('bubble.html'));
    if (b) {
      const r = b.getBounds();
      const dr = (area.x + area.width - 24) - (r.x + r.width);
      const dl = r.x - (area.x + 24);
      const dt = r.y - area.y;
      say(`t=${t}ms  bounds=${JSON.stringify(r)}  dRight=${dr}  dLeft=${dl}  dTop=${dt}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  app.exit(0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
