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
  check(`${label}: guarda algo`, !!sealed, 'devolvió null');
  check(`${label}: marca si va cifrada`, sealed.enc === expectEncrypted, `enc=${sealed.enc}`);
  if (expectEncrypted) {
    check(`${label}: la clave NO aparece en lo guardado`,
      !JSON.stringify(sealed).includes(KEY), JSON.stringify(sealed).slice(0, 80));
  }
  check(`${label}: se recupera igual`, keystore.open(ss, sealed) === KEY,
    `recuperó "${keystore.open(ss, sealed)}"`);

  check(`${label}: una clave vacía borra`, keystore.seal(ss, '') === null, 'no devolvió null');
  check(`${label}: solo espacios también borra`, keystore.seal(ss, '   ') === null, 'no devolvió null');
  check(`${label}: recorta espacios alrededor`,
    keystore.open(ss, keystore.seal(ss, `  ${KEY}  `)) === KEY, 'no recortó');
  check(`${label}: abrir nada devuelve cadena vacía`, keystore.open(ss, null) === '', 'devolvió algo');
  check(`${label}: un blob corrupto no revienta`,
    keystore.open(ss, { enc: true, v: 'no-es-base64-valido!!' }) === '', 'no devolvió cadena vacía');
}

function run() {
  suite('con keystore', fake, true);
  suite('sin keystore', none, false);

  let real = null;
  try { real = require('electron').safeStorage; } catch { /* plain node */ }
  if (real) {
    suite(real.isEncryptionAvailable() ? 'keystore real del sistema' : 'sistema sin keystore',
      real, real.isEncryptionAvailable());
  } else {
    console.log('\n(sin Electron: no se probó el keystore real del sistema)');
  }

  console.log(fails ? `\n${fails} fallos` : '\nPASS');
  return fails ? 1 : 0;
}

let electronApp = null;
try { electronApp = require('electron').app; } catch { /* plain node */ }

if (electronApp && electronApp.whenReady) {
  electronApp.whenReady().then(() => electronApp.exit(run()));
} else {
  process.exit(run());
}
