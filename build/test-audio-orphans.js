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

if (process.platform !== 'darwin' || !fs.existsSync(HELPER)) {
  console.log('skip  el ayudante de audio es de macOS y no está compilado aquí');
  process.exit(0);
}

const alive = () => Number(execSync(`pgrep -f ${HELPER} | wc -l`).toString().trim());

spawn(HELPER, [], { detached: true, stdio: 'ignore' }).unref();
spawn(HELPER, [], { detached: true, stdio: 'ignore' }).unref();
execSync('sleep 1.2');

const before = alive();
check('hay huérfanos que barrer', before >= 2, `vivos: ${before}`);

const killed = reapOrphans(HELPER);
execSync('sleep 0.8');
const after = alive();

check('el barrido se los lleva', after === 0, `quedan ${after}`);
check('y cuenta los que había', killed >= 2, `barrió ${killed}`);
check('una segunda llamada no vuelve a barrer', reapOrphans(HELPER) === 0);

console.log(fails ? `\n${fails} fallos` : '\nPASS');
process.exit(fails ? 1 : 0);
