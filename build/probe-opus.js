// Is compressing the audio after transcription actually cheap? MediaRecorder is
// bound to real time, so it cannot compress a two-hour file in less than two
// hours. WebCodecs' AudioEncoder is not, and Chromium ships Opus. Measure both
// the size and the time.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('../engine');

app.whenReady().then(async () => {
  const src = process.env.WAV || path.join(process.env.TEMP, 'yapper-60s.wav');
  const minute = fs.readFileSync(src).subarray(engine.WAV_HEADER);
  const MIN = Number(process.env.MINUTES || 10);

  const tmp = path.join(app.getPath('temp'), 'opus-probe.wav');
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, engine.wavFromPcm(Buffer.alloc(0)), 0, 44, 0);
  for (let m = 0; m < MIN; m++) fs.writeSync(fd, minute, 0, minute.length, 44 + m * minute.length);
  fs.closeSync(fd);
  engine.repairWav(tmp);
  const wavSize = fs.statSync(tmp).size;

  // the renderer can only fetch from its own folder
  const dst = path.join(__dirname, '..', 'renderer', '.opus-probe.wav');
  fs.copyFileSync(tmp, dst);

  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));

  const r = await win.webContents.executeJavaScript(`(async () => {
    const t0 = performance.now();
    const buf = await (await fetch('.opus-probe.wav')).arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 16000 });
    const audio = await ctx.decodeAudioData(buf);
    ctx.close();
    const pcm = audio.getChannelData(0);

    let bytes = 0, packets = 0;
    const enc = new AudioEncoder({
      output: chunk => { bytes += chunk.byteLength; packets++; },
      error: e => { throw e; }
    });
    enc.configure({ codec: 'opus', sampleRate: 16000, numberOfChannels: 1, bitrate: 24000 });

    const FRAME = 320;                        // 20 ms at 16 kHz, what Opus wants
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
      enc.encode(new AudioData({
        format: 'f32-planar', sampleRate: 16000, numberOfFrames: FRAME,
        numberOfChannels: 1, timestamp: i / 16000 * 1e6, data: pcm.slice(i, i + FRAME)
      }));
    }
    await enc.flush();
    enc.close();
    return { seconds: audio.duration, bytes, packets, ms: Math.round(performance.now() - t0) };
  })()`);

  fs.rmSync(dst, { force: true });

  const perHour = r.bytes / (r.seconds / 3600) / 1024 / 1024;
  console.log(`WAV          ${(wavSize / 1024 / 1024).toFixed(1)} MB   (110 MB/h)`);
  console.log(`Opus 24 kbps ${(r.bytes / 1024 / 1024).toFixed(2)} MB   (${perHour.toFixed(1)} MB/h)`
    + `   ${(wavSize / r.bytes).toFixed(0)}x mas pequeno`);
  console.log(`encode       ${r.ms} ms for ${r.seconds.toFixed(0)} s of audio`
    + `  =  ${(r.seconds / (r.ms / 1000)).toFixed(0)}x tiempo real`);
  console.log(`one 2 h meeting: ${(perHour * 2).toFixed(0)} MB instead of 220 MB`);
  console.log(`one a day for a month: ${(perHour * 2 * 22 / 1024).toFixed(2)} GB instead of 4.8 GB`);
  app.exit(0);
}).catch(e => { console.log('FAIL', e.message); app.exit(1); });
