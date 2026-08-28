'use strict';

// The real renderer and IPC bridge, against an immutable machine-labelled
// transcript. This catches the failure mode that pure alignment tests cannot:
// the name looks saved in the field but the transcript on disk never changes.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { sandbox, logger, mainWindow } = require('./harness');

const ROOT = sandbox('speakers-ui');
const say = logger(ROOT);
const folder = path.join(ROOT, 'Meetings', '2026-08-22_0930');
fs.mkdirSync(folder, { recursive: true });
const raw = [
  '[00:00:01] Speaker 1: We can ship Friday.',
  '[00:00:03] Me: I will verify the build.',
  '[00:00:06] Speaker 2: I will tell the client.'
].join('\n');
fs.writeFileSync(path.join(folder, 'transcript.raw.txt'), raw, 'utf8');
fs.writeFileSync(path.join(folder, 'transcript.txt'), raw, 'utf8');
fs.writeFileSync(path.join(folder, 'participants.txt'), 'Chuck, Maya, Robert', 'utf8');
fs.writeFileSync(path.join(folder, 'title.txt'), 'Release Plan', 'utf8');
fs.writeFileSync(path.join(folder, 'notes.md'), '## Summary [00:01]\nThe group planned the release.', 'utf8');
const legacyFolder = path.join(ROOT, 'Meetings', '2026-08-21_0930');
fs.mkdirSync(legacyFolder, { recursive: true });
fs.writeFileSync(path.join(legacyFolder, 'transcript.txt'),
  '[00:00:01] Me: Hello.\n[00:00:03] Them: Hi.', 'utf8');
fs.writeFileSync(path.join(legacyFolder, 'title.txt'), 'Older Meeting', 'utf8');
const fastFolder = path.join(ROOT, 'Meetings', '2026-08-20_0930');
fs.mkdirSync(fastFolder, { recursive: true });
const fastRaw = '[00:00:01] Me: Hello.\n[00:00:03] Them: Hi.';
fs.writeFileSync(path.join(fastFolder, 'transcript.raw.txt'), fastRaw, 'utf8');
fs.writeFileSync(path.join(fastFolder, 'transcript.txt'), fastRaw, 'utf8');
fs.writeFileSync(path.join(fastFolder, 'title.txt'), 'Fast Transcript', 'utf8');

let fails = 0;
function check(name, ok, detail) {
  if (ok) say(`ok    ${name}`);
  else { fails++; say(`FAIL  ${name}\n      ${detail}`); }
}

require('../main.js');

app.whenReady().then(async () => {
  const win = await mainWindow({ settleMs: 1200 });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  const $ = js => win.webContents.executeJavaScript(js, true);

  await $(`openMeetingByFolder(${JSON.stringify(folder)})`);
  await new Promise(r => setTimeout(r, 400));
  check('participants is visibly optional and explains its separate purpose',
    /Participants\s+Optional/i.test(await $(`document.querySelector('.participants-field label').textContent`))
      && /does not assign voices/i.test(await $(`document.getElementById('participants-help').textContent`)),
    await $(`document.querySelector('.participants-bar').textContent`));
  check('participants accepts a simple list of names',
    /separated by commas/i.test(await $(`document.getElementById('participants-meet').placeholder`)),
    await $(`document.getElementById('participants-meet').placeholder`));
  check('optional speaker matching control appears',
    !(await $(`document.getElementById('speaker-map').classList.contains('hidden')`)), 'control is hidden');
  check('speaker matching is collapsed by default',
    !(await $(`document.getElementById('speaker-map').open`)), 'control is open');
  check('the control identifies itself as optional',
    /Match voices to names\s+Optional/i.test(await $(`document.querySelector('#speaker-map summary').textContent`)),
    await $(`document.querySelector('#speaker-map summary').textContent`));
  check('speaker matching explains that it attributes speech and action items',
    /Who said what/i.test(await $(`document.querySelector('.speaker-map-copy').textContent`))
      && /action items to the right person/i.test(await $(`document.querySelector('.speaker-map-copy').textContent`)),
    await $(`document.querySelector('.speaker-map-copy').textContent`));
  await $(`document.getElementById('speaker-map').open = true`);
  const speakerInputs = await $(`document.querySelectorAll('#speaker-map-fields input').length`);
  check('recorder and two remote voices are offered', speakerInputs === 3, speakerInputs);
  const participantOptions = await $(`document.querySelectorAll('#speaker-name-options option').length`);
  check('participant names are offered as suggestions', participantOptions === 3, participantOptions);

  await $(`(() => {
    const names = { Me: 'Chuck', 'Speaker 1': 'Maya', 'Speaker 2': 'Robert' };
    document.querySelectorAll('#speaker-map-fields input').forEach(input => {
      input.value = names[input.dataset.speaker];
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  })()`);
  await new Promise(r => setTimeout(r, 900));

  const transcript = fs.readFileSync(path.join(folder, 'transcript.txt'), 'utf8');
  check('names are persisted into the working transcript',
    /Maya: We can ship/.test(transcript) && /Chuck: I will verify/.test(transcript)
      && /Robert: I will tell/.test(transcript), transcript);
  check('the immutable labelled transcript is untouched',
    fs.readFileSync(path.join(folder, 'transcript.raw.txt'), 'utf8'), raw);
  check('the rendered transcript updates immediately',
    await $(`/Maya: We can ship/.test(document.getElementById('transcript').textContent)`),
    await $(`document.getElementById('transcript').textContent`));
  check('the UI explains that notes need regeneration',
    /Regenerate/.test(await $(`document.getElementById('regen-status').textContent`)),
    await $(`document.getElementById('regen-status').textContent`));

  const reopened = await $(`window.yapper.loadMeeting(${JSON.stringify(folder)})`);
  const expectedSpeakers = [
    { label: 'Me', name: 'Chuck' },
    { label: 'Speaker 1', name: 'Maya' },
    { label: 'Speaker 2', name: 'Robert' }
  ];
  check('speaker names survive reopening',
    JSON.stringify(reopened.speakers) === JSON.stringify(expectedSpeakers), JSON.stringify(reopened.speakers));
  await $(`openMeetingByFolder(${JSON.stringify(fastFolder)})`);
  await new Promise(r => setTimeout(r, 250));
  check('Me/Them fast-path labels do not show Match voices to names',
    await $(`document.getElementById('speaker-map').classList.contains('hidden')`), 'panel is visible');
  const rejectedMap = await $(`window.yapper.setSpeakerMap(${JSON.stringify(fastFolder)}, { Them: 'Maya' })
    .then(() => '', error => error.message)`);
  check('the IPC also refuses name matching without identified voices',
    /does not have identified speakers/i.test(rejectedMap), rejectedMap);
  await $(`openMeetingByFolder(${JSON.stringify(legacyFolder)})`);
  await new Promise(r => setTimeout(r, 250));
  check('an older transcript without immutable labels offers no unsafe mapping',
    await $(`document.getElementById('speaker-map').classList.contains('hidden')`), 'panel is visible');
  check('no renderer errors', errors.length === 0, errors.join(' | '));

  say(fails ? `\n${fails} failures` : '\nPASS');
  app.exit(fails ? 1 : 0);
}).catch(err => {
  say(`FAIL  ${err.stack || err.message}`);
  app.exit(1);
});
