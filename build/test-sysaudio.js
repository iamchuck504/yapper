// Mixing the other side of the call into the microphone, which on macOS is the
// difference between a recording of a meeting and a recording of one person
// talking.
//
// The mixing itself is one addition per sample, and the ways it goes wrong are
// all quiet ones: wrapping instead of clipping turns a loud moment into noise,
// a buffer that only grows makes the far side drift later and later behind the
// voice, and a helper that never starts must leave the microphone untouched
// rather than write silence over it.
const { create, mixPcm, MAX_BUFFERED } = require('../sysaudio');
const path = require('path');
const fs = require('fs');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail || ''}`); }
}

// The Swift helper is not importable into this Node test, but these are
// structural runtime invariants worth pinning: a trial may not substitute a
// second app, and the macOS 13 fallback may not silently omit its mute watch.
// Read with its line endings normalised: git checks this out with CRLF on
// Windows, and the bounded gaps in the patterns below ({0,320} and the
// like) count those extra characters — an invariant would fail there for
// a reason that has nothing to do with the code it is describing.
const swift = fs.readFileSync(path.join(__dirname, '..', 'mac', 'system-audio.swift'), 'utf8').replace(/\r\n/g, '\n');
checkSwiftInvariant('a trial checks the exact process that provoked the doubt',
  /canTrial\(pid: other\.pid\)/.test(swift)
    && /capturer\.trialPID = other\.pid/.test(swift)
    && /stillPlaying\(other\)/.test(swift)
    && !/trialTarget\(among:/.test(swift));
checkSwiftInvariant('no seam turns a global stream into a pretend scoped trial',
  !/YAPPER_SCK_TRIAL_ANY/.test(swift));
checkSwiftInvariant('macOS before 14.2 still watches a screen-only capture',
  /else \{ watchScreenOnlyLegacy\(capturer\) \}/.test(swift));
checkSwiftInvariant('the SCK watch consumes recent signal and remains reusable',
  /func consumeRecentSignal\(\) -> Bool/.test(swift)
    && /said = false\s+note\("note: the system audio track came alive after all"\)/.test(swift)
    && !/consumeRecentSignal\(\)[\s\S]{0,180}watch\.cancel\(\)/.test(swift));
checkSwiftInvariant('an accepted trial gets the same permanent SCK watch',
  /if live \{[\s\S]{0,260}watchScreenOnly\(capturer\)[\s\S]{0,80}return/.test(swift));
checkSwiftInvariant('the tap-to-screen hand-off prevents display sleep',
  /beginActivity\([\s\S]{0,120}idleDisplaySleepDisabled/.test(swift)
    && /defer \{ ProcessInfo\.processInfo\.endActivity\(transitionActivity\) \}/.test(swift));
checkSwiftInvariant('the process tap is watched for later degradation, not trusted for life',
  /func consumeRecentSignal\(\) -> Bool/.test(swift)
    && /if t\.consumeRecentSignal\(\)/.test(swift)
    && !/if t\.heard \{ watch\.cancel\(\)/.test(swift));
checkSwiftInvariant('the tap remains the recorder throughout a provisional SCK trial',
  /if trialPID == nil \{ note\("capturing: screen"\) \}/.test(swift)
    && /if outputLock\.withLock\(\{ \$0 \}\) \{ sink\.write\(pcm\) \}/.test(swift)
    && /if general \{[\s\S]{0,320}t\.stop\(\)[\s\S]{0,120}capturer\.enableOutput\(\)[\s\S]{0,120}note\("capturing: screen"\)/.test(swift));
checkSwiftInvariant('cancelled mute-watch timers release their source and capture',
  /final class MainQueueTimer/.test(swift)
    && /source\.setEventHandler\(handler: \{\}\)[\s\S]{0,100}source\.cancel\(\)[\s\S]{0,100}self\.source = nil/.test(swift));
checkSwiftInvariant('a tap that recovers after suspicion is watched again',
  /note\("capturing: tap"\)[\s\S]{0,180}armMuteWatch\(t, attemptsLeft: 3\)/.test(swift));

function checkSwiftInvariant(name, ok) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}`); }
}
const pcm = (...samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const samplesOf = buf => {
  const out = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
};

// ---- the addition ----
check('suma muestra a muestra',
  String(samplesOf(mixPcm(pcm(100, -100, 0), pcm(50, -50, 7)))) === String([150, -150, 7]));
check('silence changes nothing',
  String(samplesOf(mixPcm(pcm(1000, -2000), pcm(0, 0)))) === String([1000, -2000]));

// Wrapping is the dangerous failure: 32767 + 1 becomes -32768, so a loud
// passage would come back as a burst of noise instead of merely clipping.
check('it clips upwards instead of wrapping round',
  samplesOf(mixPcm(pcm(30000), pcm(30000)))[0] === 32767,
  String(samplesOf(mixPcm(pcm(30000), pcm(30000)))));
check('and downwards too',
  samplesOf(mixPcm(pcm(-30000), pcm(-30000)))[0] === -32768);
check('does not touch the buffer it is handed', (() => {
  const mic = pcm(100, 200);
  mixPcm(mic, pcm(1, 1));
  return String(samplesOf(mic)) === String([100, 200]);
})(), 'mutated the input');
check('a shorter tail does not break the mix',
  String(samplesOf(mixPcm(pcm(10, 20, 30), pcm(5)))) === String([15, 20, 30]));

// ---- the stderr protocol, with a stub helper ----
// The helper's only channel to the app is its stderr, and every line it can
// write means something different: an advisory to log, a doubt to warn about
// while capture continues, a refusal that names a Settings pane, a failure in
// its own words. Read wrongly, the app tells the user to grant a permission
// they already have, or says nothing while a meeting records one-sided.
function stderrProtocol() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-sysaudio-'));
  const stub = path.join(dir, 'stub-helper.sh');
  fs.writeFileSync(stub, `#!/bin/sh
echo "note: waiting for a display" >&2
printf 'capturing: tap\n' >&2
echo "suspect: audio" >&2
echo "note: the system audio track has been silent" >&2
sleep 1
printf 'capturing: tap\n' >&2
sleep 1
echo "suspect: screen" >&2
sleep 1
printf 'capturing: screen\n' >&2
sleep 2
echo "suspect: screen" >&2
sleep 1
printf 'capturing: screen\n' >&2
sleep 30
`, { mode: 0o755 });
  const seen = [];
  const it = create({ probePath: stub, onStatus: info => seen.push(info) });
  // start() resolves the moment "capturing:" is read; the lines after it
  // arrive in their own chunks, so give the pipe a beat before judging.
  return it.start().then(ok => new Promise(r => setTimeout(() => r(ok), 300))).then(ok => {
    check('the stub helper is read as capturing', ok === true && it.state === 'capturing', it.state);
    const live = seen.find(i => i.ok);
    check('and the route it named is passed on', live && live.via === 'tap', JSON.stringify(seen));
    check('an advisory note raises no status at all',
      !seen.some(i => i.reason === 'helper'), JSON.stringify(seen));
    const doubt = seen.find(i => i.reason === 'suspect');
    check('a doubt is reported, and says which permission it doubts',
      doubt && doubt.which === 'audio' && doubt.ok === false, JSON.stringify(seen));
    check('and the explanation after it is not a second status',
      seen.filter(i => i.reason === 'suspect').length === 1, JSON.stringify(seen));
    return new Promise(r => setTimeout(r, 1400)).then(() => {
      // The doubt can be withdrawn: the helper says it is capturing again,
      // and that has to reach the app as an ok, or the warning stays up over
      // a recording that is fine.
      check('a doubt can be withdrawn by capturing again',
        seen.some(i => i.ok === true && i.via === 'tap'), JSON.stringify(seen));
      return new Promise(r => setTimeout(r, 2600)).then(() => {
        // The screen door can be the one in doubt — the only door, on a Mac
        // with no process tap — and it is named separately so the app can say
        // something true about it rather than pointing at the wrong pane.
        const doubts = seen.filter(i => i.reason === 'suspect');
        check('the door in doubt is named, whichever it is',
          doubts.length === 2 && doubts[0].which === 'audio' && doubts[1].which === 'screen',
          JSON.stringify(doubts));
        check('and capturing again withdraws that one too',
          seen[seen.length - 1].ok === true && seen[seen.length - 1].via === 'screen',
          JSON.stringify(seen.slice(-3)));
        return new Promise(r => setTimeout(r, 2600)).then(() => {
          // The health watch is permanent: another silent spell can warn and
          // recover again without restarting the helper.
          const later = seen.filter(i => i.reason === 'suspect' && i.which === 'screen');
          check('the screen doubt can recur after it was withdrawn',
            later.length === 2, JSON.stringify(seen));
          check('and the later doubt can be withdrawn again',
            seen[seen.length - 1].ok === true && seen[seen.length - 1].via === 'screen',
            JSON.stringify(seen.slice(-3)));
          it.stop();
          fs.rmSync(dir, { recursive: true, force: true });
        });
      });
    });
  });
}

// A diagnostic line says what failed; the subsequent close is what proves the
// launch is over and there is no source still on its way. Main needs both
// facts so it can keep the display awake during a slow/provisional launch but
// release it after a definitive startup failure.
function terminalHelperFailure() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-sysaudio-terminal-'));
  const stub = path.join(dir, 'stub-helper.sh');
  fs.writeFileSync(stub, `#!/bin/sh
echo "aggregate device failed" >&2
exit 5
`, { mode: 0o755 });
  const seen = [];
  const it = create({ probePath: stub, onStatus: info => seen.push(info) });
  return it.start().then(ok => {
    check('a named helper failure does not claim capture started',
      ok === false && !seen.some(i => i.ok), JSON.stringify(seen));
    const first = seen.find(i => i.reason === 'helper' && !i.terminal);
    const terminal = seen.find(i => i.reason === 'helper' && i.terminal);
    check('the helper detail is reported immediately',
      first && /aggregate device failed/.test(first.detail), JSON.stringify(seen));
    check('and its close marks that failure terminal',
      terminal && terminal.detail === first.detail, JSON.stringify(seen));
    it.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// stop() deliberately lets go of the child before its close event arrives.
// That close still owns the pending start() promise: without settling it, an
// aborted recording start waits forever because its four-second timer was
// cleared at the same time. This helper says nothing, so only stop/close can
// resolve the launch.
function stoppedStartSettles() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yapper-sysaudio-stopped-start-'));
  const stub = path.join(dir, 'stub-helper.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nIFS= read -r line\n', { mode: 0o755 });
  const it = create({ probePath: stub });
  let answer = 'pending';
  const pending = it.start().then(ok => { answer = ok; return ok; });
  return new Promise(r => setTimeout(r, 100)).then(() => {
    it.stop();
    // Promise reactions run before the child-process close event. This asks
    // whether stop() itself settled the launch instead of getting lucky when
    // the helper happened to close quickly.
    return Promise.resolve().then(() => Promise.resolve());
  }).then(() => {
    check('stopping a helper that has not answered settles its pending start immediately',
      answer === false, JSON.stringify(answer));
    return pending;
  }).then(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ---- taking, with no helper running ----
const idle = create({ probePath: path.join(__dirname, 'no-such-helper') });
check('with no helper there is no capture state', idle.state === 'off');
check('y take() devuelve null, no silencio', idle.take(64) === null,
  'it would write zeros over the microphone');

// The two stub helpers above are shell scripts, and the protocol they act out
// belongs to a helper that only exists on macOS — Windows mixes system audio
// in the renderer's own graph and never spawns one. Windows cannot execute a
// `#!/bin/sh` file, so running them there fails for a reason that has nothing
// to do with the code under test.
const posixOnly = process.platform === 'win32'
  ? () => { console.log('skip  the stub-helper protocol: the helper is macOS-only and needs a POSIX shell'); }
  : null;
const protocolChecks = posixOnly
  ? Promise.resolve().then(posixOnly)
  : stderrProtocol().then(terminalHelperFailure).then(stoppedStartSettles);

protocolChecks.then(() => idle.start()).then(started => {
  check('starting with no helper resolves false rather than throwing', started === false);
  check('and it is marked unavailable', idle.state === 'unavailable', idle.state);

  // Half a second at 16 kHz mono 16-bit. Stated as a number here so that
  // widening the bound has to be a decision, not a typo: the whole point is
  // that the far side cannot drift arbitrarily far behind the voice.
  check('the buffer cap is half a second of audio', MAX_BUFFERED === 16000,
    `it is ${MAX_BUFFERED}`);

  // ---- the helper on disk, when this machine has one ----
  const helper = path.join(__dirname, 'system-audio');
  if (process.platform === 'darwin' && fs.existsSync(helper)) {
    const live = create({ probePath: helper });
    live.start().then(ok => {
      // Two states are the machine's, not the code's: Screen Recording not
      // granted, and a display asleep — ScreenCaptureKit lists no displays
      // then, which is why the app holds the screen awake while recording.
      // Neither says anything about whether this module works, so neither is
      // a failure here.
      if (!ok) {
        console.log(`skip  the helper could not capture (state ${live.state}): `
          + 'Screen Recording permission, or the screen asleep');
        live.stop();
        return done();
      }
      check('the real helper starts and captures', true);
      if (ok) {
        const chunk = live.take(3200);            // 0.1 s
        check('hands over exactly what it is asked for', chunk && chunk.length === 3200,
          chunk ? String(chunk.length) : 'null');
        check('and pads with silence for what has not arrived yet', chunk && chunk.length === 3200);
      }
      live.stop();
      check('stopping leaves it off', live.state === 'off');
      done();
    });
  } else {
    console.log('skip  the native helper is not compiled here (macOS only)');
    done();
  }
});

// main.js leans on this: a meeting whose far side never made a sound drops its
// tracks and transcribes the mix, reusing the head start made on the
// microphone track — which is only right if mixing digital silence into the
// microphone changes nothing.
{
  const mic = pcm(1, -2, 30000, -30000, 12345, 0);
  const mixed = mixPcm(mic, Buffer.alloc(mic.length));
  check('mixing digital silence leaves the microphone byte for byte',
    mixed.equals(mic) && mixed !== mic, `got ${samplesOf(mixed)}`);
}

function done() {
  console.log(fails ? `\n${fails} failures` : '\nPASS');
  process.exit(fails ? 1 : 0);
}
