// Turns real recordings into WAV clips to measure transcription quality on.
// Most of Chuck's recordings are the old compressed format, so this uses the
// app's own decode path — the same one imports use — rather than a new tool.
//
//   node_modules\electron\dist\electron.exe build\make-clips.js [seconds]
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const engine = require('../engine');

const REAL = path.join(process.env.USERPROFILE, 'Documents', 'Meetings');
const OUT = path.join(process.env.TEMP, 'yapper-clips');
const SECONDS = Number(process.argv[2] || process.env.SECONDS || 180);
const HOW_MANY = Number(process.env.CLIPS || 6);

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Smallest first. decodeAudioData decodes the whole file before anything can
  // be trimmed off it, so starting with a three-hour recording spends minutes to
  // produce one clip; starting small gives several samples in the same time, and
  // several samples is the point.
  const found = [];
  for (const d of fs.readdirSync(REAL)) {
    for (const f of fs.readdirSync(path.join(REAL, d))) {
      if (!/^recording\./i.test(f)) continue;
      const p = path.join(REAL, d, f);
      const size = fs.statSync(p).size;
      if (size > 300 * 1024) found.push({ name: d, file: p, size, ext: path.extname(f) });
    }
  }
  found.sort((a, b) => a.size - b.size);
  console.log(`${found.length} real recordings found\n`);

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));

  let made = 0;
  for (const rec of found) {
    if (made >= HOW_MANY) break;
    const out = path.join(OUT, `${rec.name}.wav`);
    if (fs.existsSync(out)) { console.log(`already there  ${rec.name}`); made++; continue; }

    // the renderer can only fetch from its own folder
    const staged = path.join(__dirname, '..', 'renderer', '.clip-src' + rec.ext);
    fs.copyFileSync(rec.file, staged);
    try {
      const got = await win.webContents.executeJavaScript(`(async () => {
        const buf = await (await fetch('.clip-src${rec.ext}')).arrayBuffer();
        const ctx = new AudioContext({ sampleRate: 16000 });
        let audio;
        try { audio = await ctx.decodeAudioData(buf); } finally { ctx.close(); }
        const want = Math.min(audio.length, 16000 * ${SECONDS});
        const chans = [];
        for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
        const out = new Int16Array(want);
        for (let i = 0; i < want; i++) {
          let sum = 0;
          for (const ch of chans) sum += ch[i];
          out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / chans.length * 32767)));
        }
        return { bytes: [...new Uint8Array(out.buffer)], duration: audio.duration };
      })()`);
      fs.writeFileSync(out, engine.wavFromPcm(Buffer.from(got.bytes)));
      const secs = (fs.statSync(out).size - engine.WAV_HEADER) / engine.BYTES_PER_SEC;
      console.log(`ok         ${rec.name}  ${secs.toFixed(0)} s `
        + `(from ${(got.duration / 60).toFixed(0)} min, ${rec.ext})`);
      made++;
    } catch (err) {
      console.log(`FAILED     ${rec.name}: ${String(err.message).slice(0, 80)}`);
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }

  console.log(`\n${made} clips en ${OUT}`);
  app.exit(0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
