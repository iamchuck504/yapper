// Renders the UI headlessly and saves PNGs so the theme can be eyeballed.
// Run: electron build/screenshot.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');

async function shoot(win, theme, name) {
  await win.webContents.executeJavaScript(
    `localStorage.setItem('yapper-theme', '${theme}'); location.reload();`
  );
  await new Promise(r => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('wrote', name);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1180, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, offscreen: true
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 2500));

  await shoot(win, 'dark', 'record-dark.png');
  await shoot(win, 'light', 'record-light.png');

  // render sample notes so every section colour is visible
  const sample = [
    '## Summary', 'Weekly sync on the launch. Scope was trimmed to hit Friday.', '',
    '## Key points', '- Payments module passed QA', '- Docs still lag behind the API', '',
    '## Decisions', '- Ship the payments module on Friday', '',
    '## Action items', '- **Maya:** review the budget before Thursday', '- **Sebastian:** prep the client demo', '',
    '## Risks', '- The migration window overlaps with the holiday', '',
    '## Open questions', '- Do we keep the legacy endpoint for one more sprint?', '',
    '## Next steps', '- Reconvene Monday with the rollout plan'
  ].join('\n');

  await win.webContents.executeJavaScript(
    `document.body.classList.remove('light');
     openMeetingView('Weekly sync', ${JSON.stringify(sample)}, 'transcript text');`
  );
  await new Promise(r => setTimeout(r, 800));
  fs.writeFileSync(path.join(OUT, 'notes-dark.png'), (await win.webContents.capturePage()).toPNG());
  console.log('wrote notes-dark.png');

  await win.webContents.executeJavaScript(`document.body.classList.add('light')`);
  await new Promise(r => setTimeout(r, 800));
  fs.writeFileSync(path.join(OUT, 'notes-light.png'), (await win.webContents.capturePage()).toPNG());
  console.log('wrote notes-light.png');

  app.quit();
});
