// An API key must not end up readable in settings.json. Run under plain node
// this exercises the logic with a stand-in; run under Electron it uses the real
// OS keystore:
//     node build\test-keystore.js
//     node_modules\electron\dist\electron.exe build\test-keystore.js
const keystore = require('../keystore');

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok    ${name}`);
  else { fails++; console.log(`FAIL  ${name}\n      ${detail}`); }
}

// A stand-in that "encrypts" reversibly but visibly, so a leak is obvious. It
// throws on anything it did not produce, because that is what the real
// safeStorage does with a blob from another user or another machine.
const fake = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('ENC:' + s, 'utf8'),
  decryptString: b => {
    const s = b.toString('utf8');
    if (!s.startsWith('ENC:')) throw new Error('not mine');
    return s.slice(4);
  }
};
const none = { isEncryptionAvailable: () => false };

function suite(label, ss, expectEncrypted) {
  console.log(`\n--- ${label} ---`);
  const KEY = 'sk-ant-super-secret-0123456789';

  const sealed = keystore.seal(ss, KEY);
  check(`${label}: stores something`, !!sealed, 'returned null');
  check(`${label}: records whether it is encrypted`, sealed.enc === expectEncrypted, `enc=${sealed.enc}`);
  if (expectEncrypted) {
    check(`${label}: the key does NOT appear in what was stored`,
      !JSON.stringify(sealed).includes(KEY), JSON.stringify(sealed).slice(0, 80));
  }
  check(`${label}: round-trips unchanged`, keystore.open(ss, sealed) === KEY,
    `recovered "${keystore.open(ss, sealed)}"`);

  check(`${label}: an empty key clears it`, keystore.seal(ss, '') === null, 'did not return null');
  check(`${label}: whitespace only clears it too`, keystore.seal(ss, '   ') === null, 'did not return null');
  check(`${label}: trims surrounding whitespace`,
    keystore.open(ss, keystore.seal(ss, `  ${KEY}  `)) === KEY, 'did not trim');
  check(`${label}: opening nothing returns an empty string`, keystore.open(ss, null) === '', 'returned something');
  check(`${label}: a corrupt blob does not blow up`,
    keystore.open(ss, { enc: true, v: 'not-valid-base64!!' }) === '', 'did not return an empty string');
}

function run() {
  suite('with keystore', fake, true);
  suite('no keystore', none, false);

  let real = null;
  try { real = require('electron').safeStorage; } catch { /* plain node */ }
  if (real) {
    suite(real.isEncryptionAvailable() ? 'real system keystore' : 'system with no keystore',
      real, real.isEncryptionAvailable());
  } else {
    console.log('\n(no Electron: the real system keystore was not tested)');
  }

  console.log(fails ? `\n${fails} failures` : '\nPASS');
  return fails ? 1 : 0;
}

let electronApp = null;
try { electronApp = require('electron').app; } catch { /* plain node */ }

if (electronApp && electronApp.whenReady) {
  electronApp.whenReady().then(() => electronApp.exit(run()));
} else {
  process.exit(run());
}
