// The system-audio helper, left behind by a run that died.
//
// It holds a tap on everything the machine plays for as long as it lives, and
// it outlives a parent that is *killed* rather than closed — a crash, a force
// quit, a debugger stopped mid-recording. What is left is a process still
// capturing all system audio, with no window and no way for anyone to notice.
// It takes the microphone with it too: three of them, orphaned across an
// afternoon of testing, were enough to make the next recording hang waiting
// for a device that was never going to come free. That is how this was found.
//
// Its own file because the sweep runs **once per process**, deliberately —
// orphans belong to previous executions, and a second sweep would kill the
// helper this run just started. Sharing a process with test-sysaudio.js, which
// starts a real helper, would spend that one sweep before this could see it.
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { reapOrphans } = require('../sysaudio');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}

const HELPER = path.join(__dirname, 'system-audio');

// The sweep itself needs the macOS helper on disk. What follows it does not:
// a renderer dying, and the engine letting go of its server, are the same on
// every platform, and ending the file here — as it used to — meant Windows
// never ran those at all.
if (process.platform === 'darwin' && fs.existsSync(HELPER)) {
  const alive = () => Number(execSync(`pgrep -f ${HELPER} | wc -l`).toString().trim());

  spawn(HELPER, [], { detached: true, stdio: 'ignore' }).unref();
  spawn(HELPER, [], { detached: true, stdio: 'ignore' }).unref();
  execSync('sleep 1.2');

  const before = alive();
  check('there are orphans to sweep', before >= 2, `alive: ${before}`);

  const killed = reapOrphans(HELPER);
  execSync('sleep 0.8');
  const after = alive();

  check('the sweep takes them away', after === 0, `${after} left`);
  check('and counts the ones there were', killed >= 2, `swept ${killed}`);
  check('a second call does not sweep again', reapOrphans(HELPER) === 0);
} else {
  console.log('skip  sweeping the audio helper: it is macOS-only and is not compiled here');
}

// The same failure one level up: the renderer is what drives a recording, and
// when its process dies or its page navigates away, no `recording-state:
// false` can ever arrive from it. Everything the main process started on its
// behalf has to be retired there, or it runs for the rest of the session with
// no window and nobody watching — which is exactly what the live transcript
// did: its loop reschedules itself unconditionally, so it kept asking whisper
// to decode the same window forever. Read from the source, since the handler
// cannot be reached without Electron.
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const from = main.indexOf('function abandonRendererRecording');
  const body = from < 0 ? '' : main.slice(from, main.indexOf('\n}', from));
  check('a dead renderer closes the recording it was driving — which also stops the native helper',
    /closeRecFile\(\)/.test(body), body.slice(0, 200));
  check('the head start it was feeding', /stopHeadStart\(\)/.test(body), 'the progressive passes would run on');
  check('the live transcript loop', /liveStopInternal\(\)/.test(body),
    'whisper would keep decoding the last window for the rest of the session');
  check('and the whisper server that loop was talking to', /engine\.stop\(\)/.test(body),
    'the model would sit in memory, and on the GPU, with nobody left to ask it anything');
  check('and puts the window back in its idle power mode',
    /throttleWhileIdle\(true\)/.test(body), 'the app would stay unthrottled with nothing recording');
  check('it is reached when the renderer process goes',
    /render-process-gone[\s\S]{0,200}abandonRendererRecording/.test(main), 'nothing calls it');
  check('and when the page navigates out from under it',
    /did-start-navigation[\s\S]{0,300}abandonRendererRecording/.test(main), 'a reload would leave it running');
}

// The claim that cleanup leans on, as behaviour rather than as a comment: the
// server is let go of before `stop()` waits for anything, so calling it from
// the orphan path cannot hang, cannot be undone by a second caller (quitting
// does the same thing), and leaves nothing running.
(async () => {
  const engine = require('../engine');
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const gone = () => { try { process.kill(fake.pid, 0); return false; } catch { return true; } };
    engine.__pointAtServer(fake, 65535);
    const first = engine.stop();
    check('stopping lets go of the server before it waits',
      engine.loaded() === null, 'a second caller would still see it running');
    const second = engine.stop();
    await Promise.all([first, second]);
    await new Promise(r => setTimeout(r, 200));
    check('the server process is gone', gone(), `pid ${fake.pid} is still alive`);
    check('and stopping twice is harmless', true);
  } catch (err) {
    fails++;
    console.log(`FAIL  the engine stop check threw\n      ${err.stack || err.message}`);
  } finally {
    // Whatever happened above, this test does not get to leave an orphan of
    // its own — which is the entire subject of this file.
    try { fake.kill('SIGKILL'); } catch { /* already gone */ }
    engine.__pointAtServer(null, 0);
  }

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
})();
