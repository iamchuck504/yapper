// A recording whose microphone delivers pure digital zeros — the asleep
// wireless headset, the hardware mute. The graph runs, the waveform draws a
// flat line, and without this warning the user finds out two hours later that
// the meeting is silence. The warning must appear while it is still fixable,
// and must leave when the device wakes up.
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('silence-warning');
fs.mkdirSync(path.join(ROOT, 'Meetings'), { recursive: true });
const say = logger(ROOT);

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1500 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  // System audio alive (a tone), microphone stone dead: a destination node
  // with nothing connected produces exact zeros, byte-identical to a sleeping
  // headset. __wake lets the test turn the mic on later.
  await $(`(() => {
    const gen = new AudioContext();
    const live = freq => {
      const dest = gen.createMediaStreamDestination();
      const o = gen.createOscillator(); o.frequency.value = freq;
      const g = gen.createGain(); g.gain.value = 0.5;
      o.connect(g); g.connect(dest); o.start();
      return dest.stream;
    };
    // The microphone: a tone that is already connected and running, turned
    // all the way down. Gain 0 multiplies every sample to exactly zero — the
    // same bytes a sleeping headset delivers — and turning the gain up is a
    // parameter change on a graph that is already flowing, so waking up does
    // not depend on a late connection being picked up by a stream that has
    // been consumed as silence (which is what used to make this unreliable).
    const deadDest = gen.createMediaStreamDestination();
    window.__deadDest = deadDest;
    const micOsc = gen.createOscillator(); micOsc.frequency.value = 220;
    const micGain = gen.createGain(); micGain.gain.value = 0;
    micOsc.connect(micGain); micGain.connect(deadDest); micOsc.start();
    window.__wake = async () => {
      // Chromium starts an AudioContext suspended when no user gesture opened
      // it, and a suspended context produces digital silence — which is what
      // this test simulates on purpose, so the device could never appear to
      // wake up. Both ends have to be running for a wake-up to be visible.
      if (gen.state !== 'running') await gen.resume();
      if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state !== 'running') {
        await audioCtx.resume();
      }
      micGain.gain.value = 0.5;
    };
    navigator.mediaDevices.getDisplayMedia = async () => live(440);
    navigator.mediaDevices.getUserMedia = async () => deadDest.stream;
  })()`);

  await $('startRecording()');
  // Out of sight for the whole silent stretch. This is the situation the
  // warning exists for — a meeting is recorded with the call in front of
  // Yapper, not with Yapper in front — and it is where a loop driven by
  // animation frames stops running: no frames, no measurement, no warning,
  // and two hours of silence discovered afterwards.
  win.hide();
  await new Promise(r => setTimeout(r, 1200));

  const status = () => $(`(() => { const el = document.getElementById('status');
    return el.classList.contains('hidden') ? '' : el.textContent; })()`);

  // Both wordings of the same watchdog: the app names the microphone when
  // something else is in the mix, and speaks more generally when it is the only
  // source — which is every macOS recording without Screen Recording granted.
  const SILENCE = /(microphone has captured only silence|nothing but silence has been captured)/i;

  check('recording', await $('recording'), 'did not start');
  const early = await status();
  check('does not accuse the microphone too early', !/microphone has captured/i.test(early), early);

  // the watchdog speaks after ~6 s of exact zeros
  const warned = await within((async () => {
    for (let i = 0; i < 30; i++) {
      const s = await status();
      if (SILENCE.test(s)) return s;
      await new Promise(r => setTimeout(r, 500));
    }
    return '';
  })(), 'wait for the warning', 30000);
  say(`  aviso: "${warned}"`);
  check('a microphone on exact zeros is said on screen', !!warned, 'it never warned');
  // Where it was said from matters as much as that it was said. This window
  // is not on screen — the harness never shows it, which is also how a real
  // meeting runs, with the call in front of Yapper — and animation frames do
  // not happen in a window nobody is looking at. Measuring on one is how this
  // warning came to be silent in exactly the situation it exists for.
  check('and while the window was hidden the whole time', !win.isVisible(),
    'the window was visible, so this proved nothing about a window nobody is looking at');
  check('the warning belongs to the microphone, so only the microphone can take it back',
    await $(`document.getElementById('status').dataset.source`) === 'mic',
    await $(`document.getElementById('status').dataset.source`));
  // The wording depends on whether there was a second source to fall back on.
  // With system audio in the mix the microphone is the only suspect and it is
  // named; on macOS, where the mix is the microphone alone, the message covers
  // both ends of the cable. Either way it has to point at the hardware.
  check('it points at the hardware, not an abstract error', /headset|microphone/i.test(warned), warned);
  check('the recording continues — it warns, it does not abort', await $('recording'), 'it stopped');

  // the device wakes up; the warning must not outlive the problem
  await $('__wake()');
  // The far side raises a doubt of its own, the way it really arrives — over
  // the channel the helper's `suspect:` line comes in on — while the
  // microphone's warning is the one on screen. The question below is whether
  // the microphone recovering takes this down with it; writing it afterwards
  // would not ask that.
  win.webContents.send('system-audio-status', { ok: false, reason: 'suspect', which: 'audio' });
  await new Promise(r => setTimeout(r, 400));
  // How often the analyser is actually read while the window is hidden. Not
  // "is it a setTimeout" — that is an implementation — but the thing that
  // matters: a throttled loop runs about once a second, and a microphone
  // going silent then takes a minute to notice, if it is noticed at all.
  await $(`(() => {
    window.__reads = 0;
    window.__watched = analysers.mic.analyser;
    const orig = __watched.getByteTimeDomainData.bind(__watched);
    __watched.getByteTimeDomainData = buf => { window.__reads++; return orig(buf); };
  })()`);
  await new Promise(r => setTimeout(r, 1000));
  const reads = await $('window.__reads');
  check('the analyser is read many times a second with the window hidden',
    reads >= 5, `${reads} reads in a second — a throttled loop manages about one`);
  // Read, but not painted: the window is hidden, and `document.hidden` says
  // otherwise once the throttle is lifted, so the page has to be told.
  win.hide();                       // something showed it again; measure hidden
  await new Promise(r => setTimeout(r, 300));
  const painted = await $(`(() => {
    window.__paints = 0;
    const c = analysers.mic.canvas.getContext('2d');
    const orig = c.stroke.bind(c);
    c.stroke = (...a) => { window.__paints++; return orig(...a); };
    return true;
  })()`);
  const readsBefore = await $('window.__reads');
  await new Promise(r => setTimeout(r, 800));
  check('but nothing is painted into a window nobody can see',
    painted && (await $('window.__paints')) === 0 && (await $('window.__reads')) > readsBefore,
    `${await $('window.__paints')} paints while hidden`);
  // And by one loop, not two: a second chain would read the same analyser
  // twice as often, and would keep running when this recording ends.
  check('and by a single measuring loop', reads <= 45, `${reads} reads in a second`);

  check('the far side can raise its own doubt over the microphone warning',
    (await $(`document.getElementById('status').dataset.source`)) === 'sysaudio',
    await $(`document.getElementById('status').dataset.source`));

  // Verify the simulation before trusting its verdict. A
  // MediaStreamAudioDestinationNode whose stream has already been consumed as
  // silence does not always start carrying signal when something is connected
  // to it later — that happens on macOS — and then this would be reporting a
  // dead mock as an app that ignores a recovered microphone.
  await new Promise(r => setTimeout(r, 1200));
  const woke = await $('(() => levelOf(analysers.mic))()');
  // The microphone's own line is gone — but the status area is not empty: the
  // far side's warning is still true and still there.
  const cleared = await within((async () => {
    for (let i = 0; i < 20; i++) {
      if (await $(`document.getElementById('status').dataset.source`) !== 'mic') return true;
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  })(), 'wait for the microphone line to go', 15000);
  // Turning the microphone down to zero is a choice, not a fault: someone
  // recording only the far side of a call must not be told their microphone
  // is broken. (Set through the slider's own handler, so this is the path a
  // user takes.)
  await $(`(() => { const s = document.getElementById('gain-mic');
    s.value = '0'; s.dispatchEvent(new Event('input')); return micBus.gain.value; })()`);
  await new Promise(r => setTimeout(r, 900));
  const mutedSaid = await $(`(() => { const el = document.getElementById('status');
    return el.classList.contains('hidden') ? '' : el.textContent; })()`);
  check('a microphone turned down to zero is not called broken',
    !/only silence|nothing but silence/i.test(mutedSaid), mutedSaid);
  await $(`(() => { const s = document.getElementById('gain-mic');
    s.value = '1'; s.dispatchEvent(new Event('input')); })()`);

  check('the mock can wake the microphone up', woke > 0,
    'the level stayed at zero, so nothing below was really tested');
  check('when the mic wakes up, its own warning goes', cleared,
    await $(`document.getElementById('status').dataset.source`));
  // The status line is shared. A microphone that wakes up says nothing about
  // the far side of the call, so a warning about system audio has to survive
  // it — the alternative is a meeting recording one-sided in silence.
  check('and the far side\'s warning is not swept away with it',
    !(await $(`document.getElementById('status').classList.contains('hidden')`)),
    'the status area was emptied');
  check('it is still the system-audio line, word for word',
    /other side of the call/i.test(await status()), await status());
  check('and it still belongs to system audio',
    await $(`document.getElementById('status').dataset.source`) === 'sysaudio',
    await $(`document.getElementById('status').dataset.source`));

  // An OS permission/device request can resolve after Stop. Hold one open,
  // tear the capture down, then deliver its stream: it must be stopped rather
  // than attached to globals belonging to no recording (or the next one).
  await $(`(() => {
    const late = window.__deadDest.stream.clone();
    window.__lateTrack = late.getAudioTracks()[0];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      window.__resolveLateMic = () => {
        navigator.mediaDevices.getUserMedia = original;
        resolve(late);
      };
    });
    window.__lateMicRun = applyMicSelection({ reset: true });
  })()`);
  await within((async () => {
    for (let i = 0; i < 30; i++) {
      if (await $('typeof window.__resolveLateMic === "function"')) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })(), 'wait for the held microphone request', 5000);

  // Nothing may outlive the recording. The loop is stopped by the same path
  // an aborted start takes, and the analyser it was reading goes quiet.
  await $(`abortRecording(new Error('end of the silence test'))`);
  await $(`window.__resolveLateMic()`);
  await $(`window.__lateMicRun`);
  check('a microphone acquired after teardown is stopped as stale',
    await $(`window.__lateTrack.readyState`) === 'ended',
    await $(`window.__lateTrack.readyState`));
  check('and it is not installed into the dead graph',
    await $(`micNodes.size`) === 0 && await $(`audioCtx === null`),
    `nodes=${await $('micNodes.size')} audioCtxNull=${await $('audioCtx === null')}`);
  await new Promise(r => setTimeout(r, 600));
  const atStop = await $('window.__reads');
  await new Promise(r => setTimeout(r, 800));
  check('the measuring loop stops with the recording',
    (await $('window.__reads')) === atStop,
    `it kept reading after the recording ended (${atStop} → ${await $('window.__reads')})`);
  check('and the window goes back to being throttled when idle',
    win.webContents.getBackgroundThrottling() === true, 'still unthrottled with no recording');

  // A second recording gets its own single loop, at the same rate.
  await $(`(() => { window.__reads2 = 0; })()`);
  await $('startRecording()');
  await new Promise(r => setTimeout(r, 500));
  check('a new recording lifts the throttle again',
    win.webContents.getBackgroundThrottling() === false, 'the window stayed throttled while recording');
  await $(`(() => {
    window.__watched2 = analysers.mic.analyser;
    const orig = __watched2.getByteTimeDomainData.bind(__watched2);
    __watched2.getByteTimeDomainData = buf => { window.__reads2++; return orig(buf); };
  })()`);
  const before2 = await $('window.__reads');
  await new Promise(r => setTimeout(r, 1000));
  const reads2 = await $('window.__reads2');
  check('the second recording measures at the same rate',
    reads2 >= 5 && reads2 <= 45, `${reads2} reads in a second`);
  check('and the first recording\'s loop is still gone',
    (await $('window.__reads')) === before2, 'two loops were running at once');

  // A reload/crash cannot run cleanupCapture in the old page. Main must own
  // this last safety net or the WAV/helper stay open and Chromium remains in
  // its recording-power mode forever.
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.webContents.reload();
  await loaded;
  await new Promise(r => setTimeout(r, 300));
  check('a main-frame reload retires the orphaned recording',
    win.webContents.getBackgroundThrottling() === true,
    'the reloaded idle page inherited recording throttling');

  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(e => { say('FAIL ' + (e.stack || e.message)); app.exit(1); });
