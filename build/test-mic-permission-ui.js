'use strict';

// A microphone permission refusal is different from a silent or unplugged
// device: the user can fix it in one exact macOS settings panel. This drives
// the real renderer while replacing getUserMedia with NotAllowedError, and
// replaces native system capture too so the test never reads real audio.
const { app } = require('electron');
const { sandbox, logger, mainWindow, within } = require('./harness');

const ROOT = sandbox('mic-permission-ui');
const say = logger(ROOT);
let fails = 0;
function check(name, ok, detail = '') {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
}

const sysaudio = require('../sysaudio');
sysaudio.create = () => ({
  state: 'unavailable', buffered: 0, droppedBytes: 0,
  start: async () => false, take: () => null, stop: () => {}
});
require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1200 });
  const $ = js => win.webContents.executeJavaScript(js, true);

  await $(`(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('denied for the test', 'NotAllowedError');
    };
  })()`);

  const startedAt = Date.now();
  await $('startRecording()');
  const message = await within((async () => {
    for (let i = 0; i < 20; i++) {
      const text = await $(`(() => { const el = document.getElementById('status');
        return el.classList.contains('hidden') ? '' : el.textContent; })()`);
      if (/not letting Yapper use the microphone/i.test(text)) return text;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return '';
  })(), 'wait for the permission explanation', 5000);

  check('an explicit microphone refusal is explained immediately',
    !!message && Date.now() - startedAt < 3000, message || 'no permission explanation appeared');
  check('the explanation points to the macOS Microphone setting',
    /Privacy & Security.*Microphone/i.test(message), message);
  check('the specific explanation is not replaced by the generic warning',
    !/no audio source could be captured/i.test(message), message);
  check('recording continues so the remote side can still be saved',
    await $('recording'), 'recording stopped');

  await $(`abortRecording(new Error('permission test complete'))`);
  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(error => {
  say(`FAIL  ${error.stack || error.message}`);
  app.exit(1);
});
