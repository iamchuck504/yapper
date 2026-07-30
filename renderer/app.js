const $ = id => document.getElementById(id);

const viewRecord = $('view-record');
const viewMeeting = $('view-meeting');
const viewReminders = $('view-reminders');
const btnRecord = $('btn-record');
const btnStop = $('btn-stop');
const btnNew = $('btn-new');
const btnRegen = $('btn-regen');
const btnCopy = $('btn-copy');
const btnOpenFolder = $('btn-open-folder');
const recLive = $('rec-live');
const timerEl = $('timer');
const statusEl = $('status');
const regenStatusEl = $('regen-status');
const pipelineEl = $('pipeline');
const vizSys = $('viz-sys');
const vizMic = $('viz-mic');
const titleInput = $('meeting-title');
const customInput = $('custom-instructions');
const notesEl = $('notes');
const transcriptEl = $('transcript');
const resultTitle = $('result-title');
const meetingList = $('meeting-list');
const regenStyle = $('regen-style');
const regenDetail = $('regen-detail');

let recording = false;
let audioCtx = null;
let dest = null;          // sink the mixed graph feeds
let micBus = null;        // GainNode summing all active mics
let sysGainNode = null;   // GainNode for system audio
let micHP = null;         // high-pass filter (cuts low rumble/hum)
let micLP = null;         // low-pass filter (tames hiss on Strong)
let sysStream = null;     // system-audio loopback stream

let noiseReduction = localStorage.getItem('yapper-noise') || 'standard';

const numOr = (v, d) => (isNaN(parseFloat(v)) ? d : parseFloat(v));
let gainSys = numOr(localStorage.getItem('yapper-gain-sys'), 1);
let gainMic = numOr(localStorage.getItem('yapper-gain-mic'), 1);
const micStreams = new Map(); // deviceId|'default' -> MediaStream
const micNodes = new Map();   // deviceId|'default' -> MediaStreamAudioSourceNode
let analysers = { sys: null, mic: null };
let liveActive = false;
let liveParagraphs = []; // stable text, split into paragraphs on long pauses
let liveTentative = '';  // unstable tail, still being refined
let timerInterval = null;
let levelRaf = null;
let currentFolder = null;
let currentNotesMd = '';
let resultDateStr = '';
let allMeetings = [];
let searchQuery = '';

const resultDate = $('result-date');
const searchInput = $('search');
const btnSpeak = $('btn-speak');
const voiceSelect = $('voice-select');

const micSelect = $('mic-select');
let micSelection = localStorage.getItem('yapper-mic') || 'default';

const liveWrap = $('live-wrap');
const liveTranscriptEl = $('live-transcript');

// ---------- theme (persisted) ----------

const btnTheme = $('btn-theme');
let theme = localStorage.getItem('yapper-theme') || 'dark';

function applyTheme() {
  document.body.classList.toggle('light', theme === 'light');
  window.yapper.bubbleState({ theme });   // keep the floating bubble in sync
  window.yapper.setTheme(theme);          // so the next launch paints the right bg
}

btnTheme.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('yapper-theme', theme);
  applyTheme();
});

applyTheme();

// ---------- note options (persisted) ----------

const participantsRec = $('participants-rec');
const participantsMeet = $('participants-meet');

const options = Object.assign(
  { style: 'general', detail: 'concise', custom: '' },
  JSON.parse(localStorage.getItem('yapper-options') || '{}')
);
// Who attended is a fact about one meeting, not a preference: carrying it over
// would quietly put last week's names into today's notes. (Older versions did
// persist it, so drop anything left behind.)
delete options.participants;

function saveOptions() {
  options.custom = customInput.value;
  localStorage.setItem('yapper-options', JSON.stringify(options));
}

/** The attendees typed for the meeting about to be recorded. */
function recParticipants() {
  return participantsRec.value.trim();
}

function syncOptionControls() {
  document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
    p.classList.toggle('active', p.dataset.style === options.style));
  document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.detail === options.detail));
  document.querySelectorAll('#noise-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.noise === noiseReduction));
  customInput.value = options.custom || '';
  regenStyle.value = options.style;
  regenDetail.value = options.detail;
}

document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
  p.addEventListener('click', () => { options.style = p.dataset.style; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { options.detail = b.dataset.detail; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#noise-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { setNoiseReduction(b.dataset.noise); syncOptionControls(); }));
customInput.addEventListener('change', saveOptions);


// ---------- live behaviour toggles (persisted) ----------

const bubbleToggle = $('opt-bubble');
const autoDetectToggle = $('opt-autodetect');
const startupToggle = $('opt-startup');
let bubbleEnabled = localStorage.getItem('yapper-bubble') !== 'off';
let autoDetectEnabled = localStorage.getItem('yapper-autodetect') !== 'off';   // on by default

bubbleToggle.checked = bubbleEnabled;
autoDetectToggle.checked = autoDetectEnabled;
window.yapper.setAutoDetect(autoDetectEnabled);

// "start with Windows" lives in the main process (it writes the login item)
window.yapper.getOpenAtLogin().then(on => { startupToggle.checked = on; });
startupToggle.addEventListener('change', () => {
  window.yapper.setOpenAtLogin(startupToggle.checked);
});

bubbleToggle.addEventListener('change', () => {
  bubbleEnabled = bubbleToggle.checked;
  localStorage.setItem('yapper-bubble', bubbleEnabled ? 'on' : 'off');
  if (!bubbleEnabled) window.yapper.bubbleHide();
  else if (liveActive) window.yapper.bubbleShow();
});

autoDetectToggle.addEventListener('change', () => {
  autoDetectEnabled = autoDetectToggle.checked;
  localStorage.setItem('yapper-autodetect', autoDetectEnabled ? 'on' : 'off');
  window.yapper.setAutoDetect(autoDetectEnabled);
});

// ---------- what happens to the audio ----------
// The transcript is the record. The audio exists to produce it and to survive a
// crash on the way there, and at 110 MB an hour keeping it afterwards costs
// gigabytes a month for something almost never opened again.

const keepAudioToggle = $('opt-keep-audio');
const audioHeldEl = $('audio-held');
const btnFreeAudio = $('btn-free-audio');

async function refreshHeldAudio() {
  const { bytes, count } = await window.yapper.heldAudio();
  const show = bytes > 5 * 1024 * 1024;      // not worth mentioning below this
  audioHeldEl.textContent = show
    ? `${count} transcribed meeting${count === 1 ? '' : 's'} still hold ${(bytes / 1024 / 1024).toFixed(0)} MB of audio.`
    : '';
  audioHeldEl.classList.toggle('hidden', !show);
  btnFreeAudio.classList.toggle('hidden', !show);
}

// Not a saved preference: off on every launch, and off again the moment it has
// been honoured for one meeting.
window.yapper.getKeepAudio().then(keep => { keepAudioToggle.checked = keep; });
refreshHeldAudio();

keepAudioToggle.addEventListener('change', async () => {
  await window.yapper.setKeepAudio(keepAudioToggle.checked);
  await refreshHeldAudio();
});

window.yapper.onKeepAudioChanged(keep => {
  keepAudioToggle.checked = keep;
  refreshHeldAudio();
});

btnFreeAudio.addEventListener('click', async () => {
  btnFreeAudio.disabled = true;
  const res = await window.yapper.releaseHeldAudio();
  if (res.released) {
    audioHeldEl.textContent = `Freed ${(res.bytes / 1024 / 1024).toFixed(0)} MB.`;
    audioHeldEl.classList.remove('hidden');
    btnFreeAudio.classList.add('hidden');
    await refreshMeetingList();
  }
  btnFreeAudio.disabled = false;
  if (!res.released && !res.cancelled) await refreshHeldAudio();
});

// ---------- who writes the notes ----------
// Transcription is always local; the notes are not. Which model writes them is
// a per-machine choice, so a coworker with an API key and no Claude Code
// subscription can still use the app.

const llmProviderSel = $('llm-provider');
const llmKeyInput = $('llm-key');
const llmModelInput = $('llm-model');
const llmBaseInput = $('llm-baseurl');
const llmHint = $('llm-hint');
const llmStatus = $('llm-status');
const llmPrivacy = $('llm-privacy');
let llmProviders = [];
let llmHasKey = false;

function currentProvider() {
  return llmProviders.find(p => p.id === llmProviderSel.value) || null;
}

function syncLlmControls() {
  const p = currentProvider();
  if (!p) return;
  llmHint.textContent = p.hint;
  llmHint.classList.toggle('free', !!p.free);
  $('llm-key-row').classList.toggle('hidden', !p.needsKey);
  $('llm-baseurl-row').classList.toggle('hidden', !p.needsBaseUrl);
  // anything but the CLI is worth testing: a local model can be down too
  const remote = p.id !== 'claude-cli';
  $('llm-model-row').classList.toggle('hidden', !remote);
  $('llm-test-row').classList.toggle('hidden', !remote);
  llmKeyInput.placeholder = llmHasKey ? 'saved — type to replace' : (p.keyHint || 'API key');
  llmModelInput.placeholder = p.defaultModel || 'model';
  llmBaseInput.placeholder = p.defaultBaseUrl || 'https://your-gateway/v1';

  const link = $('llm-key-link');
  link.classList.toggle('hidden', !p.keyUrl);
  link.textContent = p.free ? 'Get a free key →' : 'Get a key →';
  link.dataset.url = p.keyUrl || '';

  // Say what a free tier costs instead, before a confidential meeting is sent.
  llmPrivacy.textContent = p.privacy || '';
  $('llm-privacy-row').classList.toggle('hidden', !p.privacy);

  // Picking a provider is not the same as being set up. Without this, choosing
  // one that needs a key and never pasting one fails at the end of the first
  // meeting — after the recording, which is the worst moment to find out.
  if (p.needsKey && !llmHasKey) {
    setLlmStatus('Paste a key to finish — notes will not work until you do.', 'needs-key');
  } else if (llmStatus.dataset.kind === 'needs-key') {
    setLlmStatus('');
  }
}

/** `kind` marks a message so a later one knows whether it may clear it. */
function setLlmStatus(text, kind = '') {
  llmStatus.textContent = text;
  llmStatus.dataset.kind = kind;
  llmStatus.classList.toggle('bad', kind === 'needs-key' || kind === 'error');
}

async function saveLlm() {
  const typed = llmKeyInput.value.trim();
  await window.yapper.setLlmSettings({
    provider: llmProviderSel.value,
    model: llmModelInput.value.trim(),
    baseUrl: llmBaseInput.value.trim(),
    // only send the key when one was typed, so switching providers back and
    // forth does not wipe a key the user already saved
    ...(typed ? { apiKey: typed } : {})
  });
  if (typed) { llmHasKey = true; llmKeyInput.value = ''; }
  syncLlmControls();
}

/** Fill the row from what is stored for whichever provider is selected. */
async function loadLlm() {
  const s = await window.yapper.getLlmSettings();
  llmProviders = s.providers;
  if (!llmProviderSel.options.length) {
    for (const p of s.providers) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      llmProviderSel.appendChild(o);
    }
  }
  llmProviderSel.value = s.provider;
  // each provider keeps its own key, model and endpoint, so switching shows
  // that provider's setup rather than the last one's
  llmModelInput.value = s.model;
  llmBaseInput.value = s.baseUrl;
  llmKeyInput.value = '';
  llmHasKey = s.hasKey;
  syncLlmControls();
  if (s.hasKey && !s.keyEncrypted) {
    setLlmStatus('This system has no keystore, so the key is stored unencrypted.', 'error');
  }
}

loadLlm();

llmProviderSel.addEventListener('change', async () => {
  setLlmStatus('');
  // save the choice alone — sending no key or model leaves each provider's own
  // stored values untouched
  await window.yapper.setLlmSettings({ provider: llmProviderSel.value });
  await loadLlm();
});

$('llm-key-link').addEventListener('click', e => {
  e.preventDefault();
  const url = e.currentTarget.dataset.url;
  if (url) window.yapper.openExternal(url);
});
for (const el of [llmKeyInput, llmModelInput, llmBaseInput]) {
  el.addEventListener('change', saveLlm);
}

$('btn-llm-test').addEventListener('click', async () => {
  const btn = $('btn-llm-test');
  btn.disabled = true;
  setLlmStatus('Testing…');
  await saveLlm();
  const res = await window.yapper.testLlm({
    provider: llmProviderSel.value,
    model: llmModelInput.value.trim(),
    baseUrl: llmBaseInput.value.trim()
  });
  if (res.ok) setLlmStatus(`Working — replied in ${res.ms} ms.`, 'ok');
  else setLlmStatus(res.error, 'error');
  btn.disabled = false;
});

// ---------- meeting detection prompt ----------

const meetingPrompt = $('meeting-prompt');

window.yapper.onMeetingDetected(info => {
  if (recording) return;
  $('mp-app').textContent = `${info.app} is using your microphone.`;
  // The prompt appears where it lives and waits. It used to force the record
  // view, and since detection fires from a five-second poll that meant the page
  // could change under someone mid-sentence — open a meeting's notes while Zoom
  // starts and you lose your place. The system notification is what reaches
  // them wherever they are; this is what greets them when they come back.
  meetingPrompt.classList.remove('hidden');
});

$('mp-start').addEventListener('click', () => {
  meetingPrompt.classList.add('hidden');
  startRecording();
});

// the same offer, taken from the system notification instead of the window
window.yapper.onStartRecording(() => {
  if (recording) return;
  meetingPrompt.classList.add('hidden');
  showView('record');
  startRecording();
});
$('mp-dismiss').addEventListener('click', () => meetingPrompt.classList.add('hidden'));

// stop requested from the floating bubble
window.yapper.onRemoteStop(() => stopAndProcess());
regenStyle.addEventListener('change', () => { options.style = regenStyle.value; saveOptions(); syncOptionControls(); });
regenDetail.addEventListener('change', () => { options.detail = regenDetail.value; saveOptions(); syncOptionControls(); });

// ---------- helpers ----------

function showView(name) {
  viewRecord.classList.toggle('hidden', name !== 'record');
  viewMeeting.classList.toggle('hidden', name !== 'meeting');
  viewReminders.classList.toggle('hidden', name !== 'reminders');
  $('btn-reminders').classList.toggle('active', name === 'reminders');
}

function setStatus(el, text, isError = false) {
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function setStep(step, state) {
  const el = pipelineEl.querySelector(`[data-step="${step}"]`);
  if (el) { el.classList.remove('active', 'done', 'error'); if (state) el.classList.add(state); }
}

function resetPipeline() {
  pipelineEl.querySelectorAll('.step').forEach(s => s.classList.remove('active', 'done', 'error'));
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMeetingDate(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(?:_\d+)?$/);
  if (!m) return name;
  return `${m[3]}/${m[2]}/${m[1]} · ${m[4]}:${m[5]}`;
}

// ---------- markdown → color-coded section cards ----------

const SECTION_META = [
  { match: /summary|tl;?dr|highlight|recap|overview/i, cls: 'sec-summary' },
  { match: /background|context/i, cls: 'sec-neutral' },
  { match: /what is needed|needed|ask/i, cls: 'sec-action' },
  { match: /key point|topic|discussion|discussed/i, cls: 'sec-key' },
  { match: /decision|agreement/i, cls: 'sec-decision' },
  { match: /action|commitment/i, cls: 'sec-action' },
  { match: /question|feedback/i, cls: 'sec-question' },
  { match: /blocker|risk|concern/i, cls: 'sec-risk' },
  { match: /next step|plan/i, cls: 'sec-next' },
  { match: /update|progress/i, cls: 'sec-key' },
  { match: /idea/i, cls: 'sec-summary' },
  { match: /client|need/i, cls: 'sec-key' }
];

/**
 * `matched` tells a deliberate neutral heading apart from one nothing knew what
 * to do with. They look the same on screen, but only the second is a bug — a
 * style whose sections were changed without teaching the UI about them.
 */
function sectionMeta(title) {
  for (const m of SECTION_META) if (m.match.test(title)) return { ...m, matched: true };
  return { cls: 'sec-neutral', matched: false };
}

function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function bodyToHtml(lines) {
  let html = '';
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^[-*•] /.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(t.slice(2))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^#{3,4} /.test(t)) html += `<h3>${inlineMd(t.replace(/^#+ /, ''))}</h3>`;
    else if (t) html += `<p>${inlineMd(t)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// Headings may carry the minute the topic started: "## Decisions [12:34]".
// The stamp is optional so notes written before this existed still render.
function splitStamp(title) {
  const m = title.match(/\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*$/);
  if (!m) return { title: title.trim(), at: '' };
  return { title: title.slice(0, m.index).trim(), at: m[1] };
}

function parseSections(md) {
  const sections = [];
  let cur = { title: '', body: [] };
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(.*)/);
    if (m) {
      if (cur.title || cur.body.some(l => l.trim())) sections.push(cur);
      cur = { title: m[1].trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.title || cur.body.some(l => l.trim())) sections.push(cur);
  return sections;
}

function renderNotes(md) {
  currentNotesMd = md || '';
  notesEl.innerHTML = '';
  if (!md || !md.trim()) {
    notesEl.innerHTML =
      '<div class="note-sec sec-neutral"><p>No notes yet — this meeting only has a verbatim '
      + 'transcript. Use Regenerate to create notes from it.</p></div>';
    return;
  }

  for (const sec of parseSections(md)) {
    const el = document.createElement('div');
    if (!sec.title) {
      el.className = 'note-sec sec-neutral';
      el.innerHTML = bodyToHtml(sec.body);
    } else {
      const { title, at } = splitStamp(sec.title);
      const meta = sectionMeta(title);
      el.className = `note-sec ${meta.cls}`;
      el.innerHTML =
        `<div class="note-rule">${at ? `<span class="at">${escapeHtml(at)}</span>` : ''}</div>` +
        `<div class="note-head">${escapeHtml(title)}</div>` +
        bodyToHtml(sec.body);
      if (meta.cls === 'sec-action' || meta.cls === 'sec-next') decorateAddButtons(el);
    }
    notesEl.appendChild(el);
  }
}

// add a "+ reminder" button to each list item in action-oriented sections
function decorateAddButtons(card) {
  for (const li of card.querySelectorAll('li')) {
    const text = li.textContent.trim();
    if (!text) continue;
    const btn = document.createElement('button');
    btn.className = 'li-add';
    btn.textContent = '+ reminder';
    btn.title = 'Add to action items';
    btn.addEventListener('click', async () => {
      if (await addReminderFromText(text, resultTitle.textContent)) {
        btn.textContent = '✓ added';
        btn.classList.add('added');
      }
    });
    li.appendChild(btn);
  }
}

// ---------- audio input devices ----------

async function listMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // skip the synthetic 'default'/'communications' aliases; we expose our own "Default (OS)"
    return devices.filter(d => d.kind === 'audioinput'
      && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    return [];
  }
}

// labels are empty until mic permission is granted once
async function unlockMicLabels() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch { /* user may deny; we still show generic names */ }
}

async function populateMicSelect() {
  const mics = await listMics();
  const prev = micSelection;
  micSelect.innerHTML = '';
  micSelect.add(new Option('Default (OS)', 'default'));
  mics.forEach((d, i) => micSelect.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  if (mics.length > 1) micSelect.add(new Option('All microphones', 'all'));
  const exists = [...micSelect.options].some(o => o.value === prev);
  micSelect.value = exists ? prev : 'default';
  micSelection = micSelect.value;
}

function acquireMic(key) {
  const on = noiseReduction !== 'off';
  const audio = {
    echoCancellation: on,
    noiseSuppression: on,
    autoGainControl: noiseReduction === 'strong'
  };
  if (key !== 'default') audio.deviceId = { exact: key };
  return navigator.mediaDevices.getUserMedia({ audio });
}

// Web Audio post-filter on the mic bus (live-adjustable, no re-acquire needed)
function applyNoiseFilter() {
  if (!micHP || !micLP) return;
  if (noiseReduction === 'strong') {
    micHP.frequency.value = 130;
    micLP.frequency.value = 8000;
  } else if (noiseReduction === 'off') {
    micHP.frequency.value = 10;      // effectively bypass
    micLP.frequency.value = 20000;
  } else {
    micHP.frequency.value = 85;      // standard
    micLP.frequency.value = 20000;
  }
}

async function setNoiseReduction(level) {
  noiseReduction = level;
  localStorage.setItem('yapper-noise', level);
  applyNoiseFilter();
  // the getUserMedia constraints differ per level, so re-acquire mics if recording
  if (audioCtx) {
    for (const key of [...micNodes.keys()]) dropMic(key);
    await applyMicSelection();
  }
}

function dropMic(key) {
  const node = micNodes.get(key);
  if (node) { try { node.disconnect(); } catch { /* already gone */ } }
  const stream = micStreams.get(key);
  if (stream) stream.getTracks().forEach(t => t.stop());
  micNodes.delete(key);
  micStreams.delete(key);
}

// Reconcile the live mic sources to match the current selection. Safe to call
// before recording (no-op) or mid-recording (hot-swaps on the live micBus).
async function applyMicSelection() {
  if (!audioCtx || !micBus) return;
  const mics = await listMics();
  let desired = micSelection === 'all' ? mics.map(d => d.deviceId) : [micSelection];
  if (desired.length === 0) desired = ['default'];

  for (const key of [...micNodes.keys()]) {
    if (!desired.includes(key)) dropMic(key);
  }
  for (const key of desired) {
    if (micNodes.has(key)) continue;
    try {
      const stream = await acquireMic(key);
      const node = audioCtx.createMediaStreamSource(stream);
      node.connect(micBus);
      micStreams.set(key, stream);
      micNodes.set(key, node);
    } catch { /* device busy/unavailable — skip it */ }
  }
}

micSelect.addEventListener('change', async () => {
  micSelection = micSelect.value;
  localStorage.setItem('yapper-mic', micSelection);
  await applyMicSelection();
});

// ---------- volume sliders (live) ----------

const gainSysSlider = $('gain-sys');
const gainMicSlider = $('gain-mic');
const gainSysVal = $('gain-sys-val');
const gainMicVal = $('gain-mic-val');

function initGainSliders() {
  gainSysSlider.value = gainSys;
  gainMicSlider.value = gainMic;
  gainSysVal.textContent = gainSys.toFixed(1) + '×';
  gainMicVal.textContent = gainMic.toFixed(1) + '×';
}

gainSysSlider.addEventListener('input', () => {
  gainSys = parseFloat(gainSysSlider.value);
  gainSysVal.textContent = gainSys.toFixed(1) + '×';
  localStorage.setItem('yapper-gain-sys', gainSys);
  if (sysGainNode) sysGainNode.gain.value = gainSys;
});

gainMicSlider.addEventListener('input', () => {
  gainMic = parseFloat(gainMicSlider.value);
  gainMicVal.textContent = gainMic.toFixed(1) + '×';
  localStorage.setItem('yapper-gain-mic', gainMic);
  if (micBus) micBus.gain.value = gainMic;
});

initGainSliders();

// keep the list fresh and, while recording on "Default (OS)", follow the new default
navigator.mediaDevices.addEventListener('devicechange', async () => {
  await populateMicSelect();
  if (audioCtx) {
    if (micSelection === 'default') dropMic('default'); // re-acquire to follow OS default
    await applyMicSelection();
  }
});

// ---------- the PCM tap ----------
// One tap on the mixed graph is the only audio source in the app: the same
// 16 kHz mono samples become the file on disk and the live transcript, so the
// recording and what you read on screen can never drift apart.

const LIVE_RATE = 16000;
let pcmNode = null;
let pcmSink = null;
let pcmTapGain = null;
let pcmPending = [];
let pcmPendingLen = 0;

// 48k -> 16k. Integer ratios average (crude but real anti-aliasing); otherwise
// fall back to linear interpolation.
function downsampleToInt16(input, srcRate) {
  const ratio = srcRate / LIVE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  const clamp = s => Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  if (Number.isInteger(ratio)) {
    for (let i = 0; i < outLen; i++) {
      let sum = 0;
      for (let j = 0; j < ratio; j++) sum += input[i * ratio + j];
      out[i] = clamp(sum / ratio);
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      out[i] = clamp(input[i0] * (1 - frac) + (input[i0 + 1] || 0) * frac);
    }
  }
  return out;
}

function pushPcm(float32) {
  if (!recording || paused) return;              // pausing simply stops the flow
  pcmPending.push(downsampleToInt16(float32, audioCtx.sampleRate));
  pcmPendingLen += pcmPending[pcmPending.length - 1].length;
  if (pcmPendingLen < LIVE_RATE / 5) return;   // batch ~200 ms per IPC message
  const merged = new Int16Array(pcmPendingLen);
  let o = 0;
  for (const p of pcmPending) { merged.set(p, o); o += p.length; }
  pcmPending = [];
  pcmPendingLen = 0;
  window.yapper.recordingChunk(merged.buffer);   // main writes it and feeds live
}

async function startPcmTap() {
  if (!audioCtx || pcmNode) return;

  // Tap the same mix that gets recorded (post gain + noise filter).
  pcmTapGain = audioCtx.createGain();
  micLP.connect(pcmTapGain);
  if (sysGainNode) sysGainNode.connect(pcmTapGain);

  try {
    await audioCtx.audioWorklet.addModule('pcm-worklet.js');
    pcmNode = new AudioWorkletNode(audioCtx, 'pcm-tap');
    pcmNode.port.onmessage = e => pushPcm(e.data);
  } catch {
    // Older path: works everywhere, just runs on the main thread.
    pcmNode = audioCtx.createScriptProcessor(4096, 1, 1);
    pcmNode.onaudioprocess = e => pushPcm(e.inputBuffer.getChannelData(0));
  }
  pcmTapGain.connect(pcmNode);
  // The graph is only pulled when it reaches the destination; keep it silent.
  pcmSink = audioCtx.createGain();
  pcmSink.gain.value = 0;
  pcmNode.connect(pcmSink);
  pcmSink.connect(audioCtx.destination);
}

function stopPcmTap() {
  // hand over the tail that never reached a full batch, or the last fifth of a
  // second of the meeting would be missing from the file
  if (pcmPendingLen) {
    const merged = new Int16Array(pcmPendingLen);
    let o = 0;
    for (const p of pcmPending) { merged.set(p, o); o += p.length; }
    window.yapper.recordingChunk(merged.buffer);
  }
  for (const node of [pcmNode, pcmSink, pcmTapGain]) {
    if (node) { try { node.disconnect(); } catch { /* already gone */ } }
  }
  if (pcmNode) {
    pcmNode.onaudioprocess = null;
    if (pcmNode.port) pcmNode.port.onmessage = null;
  }
  pcmNode = pcmSink = pcmTapGain = null;
  pcmPending = [];
  pcmPendingLen = 0;
}

// ---------- live streaming preview ----------
// The samples are already flowing; this only asks the main process to run them
// through the transcriber as they arrive, so the text trails speech by ~1-2 s.

async function startLivePreview() {
  if (!audioCtx) return;
  try {
    if (!(await window.yapper.liveStart(recParticipants()))) return;
  } catch {
    return; // preview is best-effort; the final transcript is unaffected
  }

  liveParagraphs = [];
  liveTentative = '';
  renderLiveTranscript();
  liveWrap.classList.remove('hidden');
  liveActive = true;
}

async function stopLivePreview() {
  liveActive = false;
  liveWrap.classList.add('hidden');
  try { await window.yapper.liveStop(); } catch { /* ignore */ }
}

function renderLiveTranscript() {
  const stick = liveTranscriptEl.scrollHeight - liveTranscriptEl.scrollTop
    - liveTranscriptEl.clientHeight < 40;
  liveTranscriptEl.innerHTML = '';
  if (!liveParagraphs.length && !liveTentative) return;   // stays :empty so the hint shows

  liveParagraphs.forEach((para, i) => {
    const p = document.createElement('p');
    p.className = 'live-para';
    p.textContent = para;
    if (i === liveParagraphs.length - 1 && liveTentative) {
      const draft = document.createElement('span');
      draft.className = 'live-tentative';
      draft.textContent = (para ? ' ' : '') + liveTentative;
      p.appendChild(draft);
    }
    liveTranscriptEl.appendChild(p);
  });

  if (!liveParagraphs.length && liveTentative) {
    const p = document.createElement('p');
    p.className = 'live-para';
    const draft = document.createElement('span');
    draft.className = 'live-tentative';
    draft.textContent = liveTentative;
    p.appendChild(draft);
    liveTranscriptEl.appendChild(p);
  }
  if (stick) liveTranscriptEl.scrollTop = liveTranscriptEl.scrollHeight;
}

window.yapper.onLiveTranscript(line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.status || msg.error) return;
  if (msg.commit) {
    if (msg.gap || !liveParagraphs.length) liveParagraphs.push(msg.commit);
    else liveParagraphs[liveParagraphs.length - 1] += ' ' + msg.commit;
  }
  liveTentative = msg.tentative || '';
  renderLiveTranscript();
});

// collapse / expand the in-app live transcript
$('live-head').addEventListener('click', () => {
  const collapsed = liveWrap.classList.toggle('collapsed');
  localStorage.setItem('yapper-live-collapsed', collapsed ? 'yes' : 'no');
});
if (localStorage.getItem('yapper-live-collapsed') === 'yes') liveWrap.classList.add('collapsed');

// ---------- waveform visualizer ----------

function drawWave(m) {
  const { analyser, buf, ctx, canvas, color } = m;
  analyser.getByteTimeDomainData(buf);
  const w = canvas.width, h = canvas.height, mid = h / 2;
  ctx.clearRect(0, 0, w, h);

  // baseline
  ctx.strokeStyle = 'rgba(127,127,127,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  // waveform line
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const step = w / buf.length;
  let x = 0;
  for (let i = 0; i < buf.length; i++) {
    const y = mid + ((buf[i] - 128) / 128) * mid * 0.92;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    x += step;
  }
  ctx.stroke();
}

// ---------- pause, markers, end-of-meeting ----------

let paused = false;
let markers = [];
let elapsedMs = 0;          // frozen time carried across pauses
let runStart = 0;           // when the current run began
let endedTimer = null;

const btnPause = $('btn-pause');
const btnMark = $('btn-mark');
const endedPrompt = $('ended-prompt');

function elapsed() {
  return elapsedMs + (paused ? 0 : Date.now() - runStart);
}

function stamp(ms) {
  const s = Math.floor(ms / 1000);
  const p = n => String(n).padStart(2, '0');
  return s >= 3600
    ? `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
    : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

function setPaused(on) {
  if (!recording) return;
  paused = on;
  // Pausing simply stops handing samples over: nothing is written to the file
  // and nothing reaches the transcriber, so the recording has no silent gap.
  if (on) elapsedMs += Date.now() - runStart;
  else runStart = Date.now();
  recLive.classList.toggle('paused', on);
  btnPause.classList.toggle('on', on);
  btnPause.querySelector('.pause-label').textContent = on ? 'Resume' : 'Pause';
  window.yapper.bubbleState({ paused: on });
}

function addMarker() {
  if (!recording) return;
  const at = stamp(elapsed());
  if (markers.includes(at)) return;
  markers.push(at);
  btnMark.classList.add('flash');
  setTimeout(() => btnMark.classList.remove('flash'), 450);
  window.yapper.bubbleState({ marked: at });
}

btnPause.addEventListener('click', () => setPaused(!paused));
btnMark.addEventListener('click', addMarker);
window.yapper.onMarkMoment(addMarker);
window.yapper.onRemotePause(() => setPaused(!paused));

// The meeting app let go of the microphone: offer to wrap up, and do it on our
// own after a minute so a forgotten recording does not run for hours.
function clearEndedPrompt() {
  if (endedTimer) clearInterval(endedTimer);
  endedTimer = null;
  endedPrompt.classList.add('hidden');
}

window.yapper.onMeetingEnded(() => {
  if (!recording || endedTimer) return;
  let left = 60;
  const tick = () => {
    $('ep-count').textContent = `Stopping on its own in ${left}s`;
    if (left-- <= 0) { clearEndedPrompt(); stopAndProcess(); }
  };
  endedPrompt.classList.remove('hidden');
  tick();
  endedTimer = setInterval(tick, 1000);
});

$('ep-keep').addEventListener('click', clearEndedPrompt);
$('ep-stop').addEventListener('click', () => { clearEndedPrompt(); stopAndProcess(); });

// ---------- recording ----------

/**
 * Put everything back after a start that failed halfway. Without this, a throw
 * anywhere past `recording = true` leaves the flag set: the record button comes
 * back, but its guard sees a recording already running and refuses to start
 * one, so the app looks fine and simply never records again.
 */
async function abortRecording(err) {
  recording = false;
  try { await stopLivePreview(); } catch { /* it may never have started */ }
  stopPcmTap();
  cleanupCapture();          // also tells main the recording is over
  // close the file, so whatever was captured before the failure still plays
  try { await window.yapper.recordingFinish('', []); } catch { /* nothing open */ }
  currentFolder = null;
  setStatus(statusEl, `Could not start recording: ${err.message}`, true);
}

async function startRecording() {
  if (recording) return;
  try {
    // main.js answers this with Windows system-audio loopback (video must be requested even if unused)
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sys.getVideoTracks().forEach(t => (t.enabled = false));
    sysStream = sys;

    audioCtx = new AudioContext();
    dest = audioCtx.createMediaStreamDestination();
    micBus = audioCtx.createGain();
    micBus.gain.value = gainMic;
    // mic noise-reduction filter chain: micBus -> highpass -> lowpass -> dest
    micHP = audioCtx.createBiquadFilter();
    micHP.type = 'highpass';
    micLP = audioCtx.createBiquadFilter();
    micLP.type = 'lowpass';
    micBus.connect(micHP);
    micHP.connect(micLP);
    micLP.connect(dest);
    applyNoiseFilter();

    const css = getComputedStyle(document.body);
    const colSys = css.getPropertyValue('--accent-2').trim() || '#54b8f2';
    const colMic = css.getPropertyValue('--accent').trim() || '#7c83ff';

    const makeViz = (sourceNode, canvas, color) => {
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      sourceNode.connect(analyser);
      return { analyser, canvas, ctx: canvas.getContext('2d'), color, buf: new Uint8Array(analyser.fftSize) };
    };

    analysers = { sys: null, mic: null };
    if (sys.getAudioTracks().length) {
      const sysSrc = audioCtx.createMediaStreamSource(sys);
      sysGainNode = audioCtx.createGain();
      sysGainNode.gain.value = gainSys;
      sysSrc.connect(sysGainNode);
      sysGainNode.connect(dest);
      analysers.sys = makeViz(sysGainNode, vizSys, colSys);
    }
    analysers.mic = makeViz(micBus, vizMic, colMic);

    await applyMicSelection();

    const updateLevels = () => {
      for (const m of [analysers.sys, analysers.mic]) {
        if (m) drawWave(m);
      }
      levelRaf = requestAnimationFrame(updateLevels);
    };
    updateLevels();

    // open the file first: every block of samples goes straight to disk from
    // here on, so an interrupted meeting still leaves a playable recording
    currentFolder = await window.yapper.recordingStart(recParticipants());
    paused = false;     // the tap reads this on its very first block
    recording = true;

    startPcmTap();      // the single audio source: file and live share it
    startLivePreview();

    btnRecord.classList.add('hidden');
    recLive.classList.remove('hidden');
    pipelineEl.classList.add('hidden');
    statusEl.classList.add('hidden');
    if (micNodes.size === 0 && !sys.getAudioTracks().length) {
      setStatus(statusEl, 'Warning: no audio source could be captured.');
    } else if (!sys.getAudioTracks().length) {
      setStatus(statusEl, 'Warning: system audio could not be captured; only the mic is being recorded.');
    } else if (micNodes.size === 0) {
      setStatus(statusEl, 'Warning: no microphone could be captured; only system audio is being recorded.');
    }

    window.yapper.setRecordingState(true);
    window.yapper.markShortcut(true);
    if (bubbleEnabled) {
      await window.yapper.bubbleShow();
      window.yapper.bubbleState({ theme });
    }

    markers = [];
    elapsedMs = 0;
    runStart = Date.now();
    recLive.classList.remove('paused');
    btnPause.classList.remove('on');
    btnPause.querySelector('.pause-label').textContent = 'Pause';

    timerInterval = setInterval(() => {
      const text = stamp(elapsed());
      timerEl.textContent = text;
      window.yapper.bubbleState({ timer: text });
    }, 500);
  } catch (err) {
    await abortRecording(err);
  }
}

function cleanupCapture() {
  if (timerInterval) clearInterval(timerInterval);
  if (levelRaf) cancelAnimationFrame(levelRaf);
  timerInterval = null;
  levelRaf = null;
  window.yapper.setRecordingState(false);
  window.yapper.markShortcut(false);
  window.yapper.bubbleHide();
  clearEndedPrompt();
  paused = false;
  recLive.classList.remove('paused');
  for (const key of [...micNodes.keys()]) dropMic(key);
  if (sysStream) { sysStream.getTracks().forEach(t => t.stop()); sysStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  dest = null;
  micBus = null;
  sysGainNode = null;
  micHP = null;
  micLP = null;
  analysers = { sys: null, mic: null };
  recLive.classList.add('hidden');
  btnRecord.classList.remove('hidden');
  timerEl.textContent = '00:00';
}

async function stopAndProcess() {
  if (!recording) return;
  recording = false;                 // no further samples reach the file
  await stopLivePreview();
  stopPcmTap();
  cleanupCapture();
  btnRecord.disabled = true;
  saveOptions();
  pipelineEl.classList.remove('hidden');
  resetPipeline();

  try {
    setStep('save', 'active');
    const saved = await window.yapper.recordingFinish(titleInput.value.trim(), markers);
    if (!saved) throw new Error('The recording could not be saved.');
    if (saved.bytes < 5000) throw new Error('The recording is empty or too short.');
    const folder = saved.folder;
    currentFolder = folder;
    setStep('save', 'done');

    setStep('transcribe', 'active');
    setStatus(statusEl, 'Transcribing locally with Whisper…\n');
    const transcript = await window.yapper.transcribe(folder);
    setStep('transcribe', 'done');

    setStep('notes', 'active');
    setStatus(statusEl, 'Generating the notes…');
    const summary = await window.yapper.summarize(folder, transcript,
      { ...options, participants: recParticipants(), markers });
    setStep('notes', 'done');

    // No title typed? Name the meeting after what was actually discussed.
    let title = titleInput.value.trim();
    if (!title) {
      setStatus(statusEl, 'Naming the meeting…');
      title = await window.yapper.generateTitle(folder);
    }

    statusEl.classList.add('hidden');
    pipelineEl.classList.add('hidden');
    openMeetingView(title || formatMeetingDate(folder.split(/[\\/]/).pop()), summary, transcript,
      true, recParticipants());
    titleInput.value = '';
    participantsRec.value = '';     // these people were in that meeting, not the next one
    await refreshMeetingList();
  } catch (err) {
    pipelineEl.querySelectorAll('.step.active').forEach(s => { s.classList.remove('active'); s.classList.add('error'); });
    setStatus(statusEl, `Error: ${err.message}\nYour recording is safe — open the meeting in the sidebar and use "Transcribe now" to retry.`, true);
    refreshMeetingList();
  } finally {
    btnRecord.disabled = false;
  }
}

// ---------- meeting view ----------

function openMeetingView(title, summary, transcript, hasRecording = true, participants = null) {
  stopSpeak();
  exitEditMode();
  showView('meeting');
  regenStatusEl.classList.add('hidden');
  resultTitle.textContent = title;
  resultDateStr = currentFolder ? formatMeetingDate(currentFolder.split(/[\\/]/).pop()) : '';
  resultDate.textContent = resultDateStr;
  participantsMeet.value = participants || '';
  transcriptEl.textContent = transcript || '(no transcript)';
  btnRegen.disabled = !transcript;
  if (!transcript && hasRecording) {
    notesEl.innerHTML =
      '<div class="note-sec sec-risk"><div class="note-rule"></div>' +
      '<div class="note-head">Not transcribed</div>' +
      '<p>This meeting has a recording but no transcript yet (the transcription may have failed '
      + 'or been interrupted). Nothing is lost.</p>' +
      '<button id="btn-transcribe" class="inline-action">Transcribe now</button></div>';
    currentNotesMd = '';
    $('btn-transcribe').addEventListener('click', retryTranscribe);
  } else {
    renderNotes(summary);
  }
  // when there are no notes yet, show the transcript expanded
  document.querySelector('#view-meeting details').open = !(summary && summary.trim());
  syncOptionControls();
}

async function retryTranscribe() {
  const btn = $('btn-transcribe');
  if (btn) btn.disabled = true;
  try {
    // recordings from before Yapper wrote WAV directly are converted first,
    // so an old meeting is never left permanently untranscribable
    const legacy = await window.yapper.legacyAudio(currentFolder);
    if (legacy) {
      setStatus(regenStatusEl, 'Converting the old recording…');
      await decodeToRecordingWav(legacy, currentFolder, p =>
        setStatus(regenStatusEl, `Converting the old recording… ${Math.round(p * 100)}%`));
    }
    setStatus(regenStatusEl, 'Transcribing with Whisper…\n');
    await window.yapper.transcribe(currentFolder);
    const data = await window.yapper.loadMeeting(currentFolder);
    regenStatusEl.classList.add('hidden');
    openMeetingView(resultTitle.textContent, data.summary, data.transcript, data.hasRecording, data.participants);
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Error: ${err.message}`, true);
    if (btn) btn.disabled = false;
  }
}

function dateGroup(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_/);
  if (!m) return 'Earlier';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 30) return 'This month';
  return 'Earlier';
}

function renderMeetingList() {
  meetingList.innerHTML = '';
  const q = searchQuery.trim().toLowerCase();
  const items = allMeetings.filter(m =>
    !q || (m.title || '').toLowerCase().includes(q) || formatMeetingDate(m.name).toLowerCase().includes(q));

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'm-empty';
    li.textContent = allMeetings.length === 0 ? 'No meetings yet.\nRecord or import to start.' : 'No matches';
    meetingList.appendChild(li);
    return;
  }

  let lastGroup = '';
  for (const m of items) {
    const g = dateGroup(m.name);
    if (g !== lastGroup) {
      lastGroup = g;
      const gh = document.createElement('li');
      gh.className = 'm-group';
      gh.textContent = g;
      meetingList.appendChild(gh);
    }
    const li = document.createElement('li');
    li.className = 'm-item' + (m.folder === currentFolder ? ' active' : '');

    // a meeting with no audio at all is a false start, and says so
    const empty = m.audioSec === 0 && !m.hasTranscript && !m.hasSummary;
    if (empty) li.classList.add('m-void');

    const dot = document.createElement('span');
    dot.className = 'm-status ' + (m.hasSummary ? 'done' : (m.hasTranscript ? 'partial' : 'pending'));
    dot.title = m.hasSummary ? 'Notes ready' : (m.hasTranscript ? 'Transcript only' : 'Not transcribed');

    const body = document.createElement('div');
    body.className = 'm-body';
    const title = document.createElement('span');
    title.className = 'm-title';
    // "Meeting" told you nothing, and a list of meetings all called Meeting told
    // you less. Naming can legitimately come back empty — a recording too
    // unintelligible to title — and that is worth saying plainly.
    title.textContent = m.title || (empty ? 'Empty recording' : 'Untitled meeting');
    if (!m.title) title.classList.add('untitled');
    const date = document.createElement('span');
    date.className = 'm-date';
    date.textContent = formatMeetingDate(m.name);
    body.append(title, date);

    const del = document.createElement('button');
    del.className = 'm-del';
    del.title = 'Delete this meeting';
    del.setAttribute('aria-label', 'Delete this meeting');
    del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      + '<path d="M3 4.5h10M6.5 4.5V3.2h3v1.3M4.4 4.5l.6 8.3h6l.6-8.3M6.6 6.8v4M9.4 6.8v4" '
      + 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', async e => {
      e.stopPropagation();          // deleting is not the same as opening
      del.disabled = true;
      const res = await window.yapper.deleteMeeting(m.folder);
      if (res.deleted) {
        if (currentFolder === m.folder) { currentFolder = null; showView('record'); }
        await refreshMeetingList();
      } else {
        del.disabled = false;
        if (res.reason) setStatus(statusEl, res.reason, true);
      }
    });

    li.append(dot, body, del);
    li.addEventListener('click', async () => {
      currentFolder = m.folder;
      const data = await window.yapper.loadMeeting(m.folder);
      openMeetingView(data.title || formatMeetingDate(m.name), data.summary, data.transcript, data.hasRecording, data.participants);
      renderMeetingList();
    });
    meetingList.appendChild(li);
  }
}

async function refreshMeetingList() {
  allMeetings = await window.yapper.listMeetings();
  renderMeetingList();
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderMeetingList();
});

// ---------- text-to-speech (read notes aloud) ----------

const synth = window.speechSynthesis;
let voices = [];
let speaking = false;

function loadVoices() {
  voices = synth.getVoices();
  if (!voices.length) return;
  const saved = localStorage.getItem('yapper-voice') || '';
  const sorted = [...voices].sort((a, b) =>
    (b.lang.startsWith('en') - a.lang.startsWith('en')) || a.name.localeCompare(b.name));
  voiceSelect.innerHTML = '';
  for (const v of sorted) {
    const lang = v.lang.replace('_', '-');
    voiceSelect.add(new Option(`${v.name.replace(/Microsoft |Desktop/g, '').trim()} · ${lang}`, v.voiceURI));
  }
  if (saved && voices.some(v => v.voiceURI === saved)) {
    voiceSelect.value = saved;
  } else {
    const def = voices.find(v => v.lang.startsWith('en') && v.default)
      || voices.find(v => v.lang.startsWith('en')) || voices[0];
    if (def) voiceSelect.value = def.voiceURI;
  }
}

synth.addEventListener('voiceschanged', loadVoices);
loadVoices();

voiceSelect.addEventListener('change', () => localStorage.setItem('yapper-voice', voiceSelect.value));

function updateSpeakBtn() {
  btnSpeak.classList.toggle('speaking', speaking);
  btnSpeak.querySelector('.speak-label').textContent = speaking ? 'Stop' : 'Read aloud';
}

function stopSpeak() {
  synth.cancel();
  speaking = false;
  updateSpeakBtn();
}

function chunkText(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]?/g) || [text];
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 220) { if (cur) chunks.push(cur.trim()); cur = p; }
    else cur += p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

btnSpeak.addEventListener('click', () => {
  if (speaking) { stopSpeak(); return; }
  const text = notesEl.innerText.trim();
  if (!text) return;
  const voice = voices.find(v => v.voiceURI === voiceSelect.value);
  const chunks = chunkText(text); // chunked to dodge the long-utterance cutoff bug
  speaking = true;
  updateSpeakBtn();
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    if (voice) u.voice = voice;
    if (i === chunks.length - 1) u.onend = () => { speaking = false; updateSpeakBtn(); };
    u.onerror = () => { speaking = false; updateSpeakBtn(); };
    synth.speak(u);
  });
});

// ---------- events ----------

btnRecord.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopAndProcess);

// Turn any file the OS can hand us into the one format the transcriber reads.
// Decoding at 16 kHz is not just convenient: it keeps a two-hour voice note at
// a couple hundred megabytes instead of gigabytes of 48 kHz floats.
async function decodeToRecordingWav(src, folder, onProgress) {
  const raw = await window.yapper.importRead(src);
  const ctx = new AudioContext({ sampleRate: LIVE_RATE });
  let audio;
  try {
    audio = await ctx.decodeAudioData(raw);
  } catch {
    throw new Error('That file could not be decoded. Try exporting it as WAV or MP3.');
  } finally {
    ctx.close();
  }

  const chans = [];
  for (let c = 0; c < audio.numberOfChannels; c++) chans.push(audio.getChannelData(c));
  const total = audio.length;
  const BLOCK = LIVE_RATE * 30;   // 30 s of samples per message

  await window.yapper.importOpen(folder);
  for (let start = 0; start < total; start += BLOCK) {
    const end = Math.min(start + BLOCK, total);
    const out = new Int16Array(end - start);
    for (let i = start; i < end; i++) {
      let sum = 0;
      for (const ch of chans) sum += ch[i];
      const s = sum / chans.length;
      out[i - start] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    }
    window.yapper.recordingChunk(out.buffer);
    if (onProgress) onProgress(end / total);
    await new Promise(r => setTimeout(r, 0));   // let the UI breathe
  }
  const bytes = await window.yapper.importClose();
  if (!bytes) throw new Error('That file contains no audio.');
  return audio.duration;
}

const btnImport = $('btn-import');
btnImport.addEventListener('click', async () => {
  btnImport.disabled = true;
  btnRecord.disabled = true;
  try {
    const picked = await window.yapper.importAudio(recParticipants());
    if (!picked) return;
    currentFolder = picked.folder;
    pipelineEl.classList.remove('hidden');
    resetPipeline();
    setStep('save', 'active');
    setStatus(statusEl, 'Reading the file…\n');
    await decodeToRecordingWav(picked.src, picked.folder, p =>
      setStatus(statusEl, `Converting the audio… ${Math.round(p * 100)}%`));
    setStep('save', 'done');
    setStep('transcribe', 'active');
    setStatus(statusEl, 'Transcribing the voice note…\n');
    const transcript = await window.yapper.transcribe(picked.folder);
    setStep('transcribe', 'done');

    // An imported voice note gets the same treatment as a recorded meeting.
    // It used to stop at the transcript, which left the whole point of the app
    // — the notes — undone for anything that did not come from the recorder.
    let summary = '';
    setStep('notes', 'active');
    try {
      setStatus(statusEl, 'Generating the notes…');
      summary = await window.yapper.summarize(picked.folder, transcript,
        { ...options, participants: recParticipants() });
      setStep('notes', 'done');
    } catch (err) {
      // the transcript is already saved, so this is a partial success, not a loss
      setStep('notes', 'error');
      setStatus(statusEl, `The transcript is saved, but the notes failed: ${err.message}`, true);
    }

    let title = picked.title;
    if (!title) {
      setStatus(statusEl, 'Naming it…');
      title = await window.yapper.generateTitle(picked.folder);
    }

    if (summary) statusEl.classList.add('hidden');
    pipelineEl.classList.add('hidden');
    openMeetingView(title || formatMeetingDate(picked.folder.split(/[\\/]/).pop()),
      summary, transcript, true, recParticipants());
    participantsRec.value = '';
    await refreshMeetingList();
  } catch (err) {
    pipelineEl.querySelectorAll('.step.active').forEach(s => { s.classList.remove('active'); s.classList.add('error'); });
    setStatus(statusEl, `Error: ${err.message}`, true);
  } finally {
    btnImport.disabled = false;
    btnRecord.disabled = false;
  }
});

btnNew.addEventListener('click', () => {
  stopSpeak();
  currentFolder = null;
  showView('record');
  statusEl.classList.add('hidden');
  pipelineEl.classList.add('hidden');
  participantsRec.value = '';       // a new meeting starts with nobody in it
  refreshMeetingList();
  titleInput.focus();
});

btnRegen.addEventListener('click', async () => {
  if (!currentFolder) return;
  btnRegen.disabled = true;
  // the attendees edited in this meeting's own bar, and only for this meeting
  setStatus(regenStatusEl, 'Regenerating the notes…');
  try {
    const summary = await window.yapper.regenerate(currentFolder,
      { ...options, participants: participantsMeet.value.trim() });
    regenStatusEl.classList.add('hidden');
    renderNotes(summary);
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Error: ${err.message}`, true);
  } finally {
    btnRegen.disabled = false;
  }
});

btnCopy.addEventListener('click', async () => {
  if (!currentNotesMd) return;
  try {
    await navigator.clipboard.writeText(currentNotesMd);
    btnCopy.textContent = 'Copied';
  } catch {
    // The clipboard can refuse — another app holding it, or the window not
    // focused at the moment of the click. Unhandled, that left the button
    // looking like it simply did nothing.
    btnCopy.textContent = 'Copy failed';
  }
  setTimeout(() => { btnCopy.textContent = 'Copy'; }, 1500);
});

// ---------- edit notes by hand ----------

const notesEditor = $('notes-editor');
const notesTextarea = $('notes-textarea');
const btnEdit = $('btn-edit');

function enterEditMode() {
  stopSpeak();
  notesTextarea.value = currentNotesMd || '';
  notesEl.classList.add('hidden');
  notesEditor.classList.remove('hidden');
  btnEdit.classList.add('speaking'); // reuse accent style to show active state
  notesTextarea.focus();
}

function exitEditMode() {
  notesEditor.classList.add('hidden');
  notesEl.classList.remove('hidden');
  btnEdit.classList.remove('speaking');
}

btnEdit.addEventListener('click', () => {
  if (notesEditor.classList.contains('hidden')) enterEditMode();
  else exitEditMode();
});

$('btn-cancel-notes').addEventListener('click', exitEditMode);

$('btn-save-notes').addEventListener('click', async () => {
  if (!currentFolder) return;
  const md = notesTextarea.value.trim();
  const btn = $('btn-save-notes');
  btn.disabled = true;
  try {
    await window.yapper.saveNotes(currentFolder, md);
    currentNotesMd = md;
    renderNotes(md);
    exitEditMode();
    await refreshMeetingList();
  } catch (err) {
    setStatus(regenStatusEl, `Could not save notes: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

// print palette: neutral slate, with the accent reserved for what needs doing
const SECTION_PDF_COLORS = {
  'sec-summary': '#7A8A96', 'sec-key': '#7A8A96', 'sec-decision': '#7A8A96',
  'sec-action': '#C0392B', 'sec-question': '#7A8A96', 'sec-risk': '#C0392B',
  'sec-next': '#7A8A96', 'sec-neutral': '#7A8A96'
};

function buildPdfHtml(title) {
  // Same chapter structure on paper: a rule carrying the minute, then the section.
  let body = '';
  for (const sec of notesEl.querySelectorAll('.note-sec')) {
    const hot = sec.classList.contains('sec-action') || sec.classList.contains('sec-risk');
    const head = sec.querySelector('.note-head');
    const at = sec.querySelector('.note-rule .at');
    const clone = sec.cloneNode(true);
    clone.querySelectorAll('.li-add, button, .note-rule, .note-head').forEach(el => el.remove());

    body += `<section class="${hot ? 'hot' : ''}">`
      + `<div class="rule">${at ? `<span class="at">${escapeHtml(at.textContent)}</span>` : ''}</div>`
      + (head ? `<h2>${escapeHtml(head.textContent.trim())}</h2>` : '')
      + clone.innerHTML
      + '</section>';
  }
  const css = `
    @font-face { font-family: 'Geist'; src: url('fonts/Geist-latin.woff2') format('woff2'); font-weight: 400; }
    @font-face { font-family: 'Geist'; src: url('fonts/Geist-latin.woff2') format('woff2'); font-weight: 600; }
    @font-face { font-family: 'Geist'; src: url('fonts/Geist-latin.woff2') format('woff2'); font-weight: 700; }
    * { box-sizing: border-box; }
    body { font-family: 'Geist', system-ui, sans-serif; color: #1A1815; margin: 0; font-size: 10.5pt; }
    h1 { font-size: 17pt; margin: 0 0 3px; font-weight: 600; letter-spacing: -0.2px; }
    .date { color: #918D83; font-size: 9pt; margin-bottom: 6px; }
    section { page-break-inside: avoid; }
    .rule { position: relative; height: 1px; background: #E4E0D8; margin: 20px 0 11px; }
    .at { position: absolute; left: 0; top: -6px; background: #fff; padding-right: 9px;
          font-family: Consolas, monospace; font-size: 8pt; color: #918D83; }
    section.hot .rule { background: #EBD9BF; }
    section.hot .at { color: #A66A1E; }
    h2 { font-size: 11.5pt; font-weight: 600; margin: 0 0 5px; letter-spacing: -0.01em; }
    section.hot h2 { color: #A66A1E; }
    ul { list-style: none; padding: 0; margin: 4px 0; }
    li { position: relative; padding-left: 13px; margin-bottom: 4px; line-height: 1.5; color: #3D3A34; }
    li::before { content: ''; position: absolute; left: 0; top: 6px; width: 3.5px; height: 3.5px; background: #918D83; }
    section.hot li::before { background: #A66A1E; }
    p { margin: 4px 0; line-height: 1.55; color: #3D3A34; }
    strong { color: #1A1815; font-weight: 600; }
    h3 { font-size: 10.5pt; margin: 9px 0 4px; color: #1A1815; }
    .foot { margin-top: 26px; color: #A8A49A; font-size: 8pt; border-top: 1px solid #E4E0D8; padding-top: 8px; }`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1><div class="date">${escapeHtml(resultDateStr)}</div>` +
    `${body}<div class="foot">Generated with Yapper</div></body></html>`;
}

// ---------- export menu ----------

const btnExport = $('btn-export');
const exportMenu = $('export-menu');

function closeExportMenu() { exportMenu.classList.add('hidden'); }

btnExport.addEventListener('click', e => {
  e.stopPropagation();
  exportMenu.classList.toggle('hidden');
});
document.addEventListener('click', closeExportMenu);
exportMenu.addEventListener('click', e => e.stopPropagation());

function exportHeader() {
  const title = resultTitle.textContent || 'Meeting';
  return `# ${title}\n\n_${resultDateStr}_\n`;
}

/**
 * The transcript as readable Markdown rather than a wall of text: each line
 * keeps its timestamp as bold, and a gap of a minute or more starts a new
 * paragraph, which is roughly where a topic changes.
 */
const TRANSCRIPT_PARA_GAP = 60;   // seconds of silence that read as a new topic

function transcriptToMd(text) {
  const blocks = [];
  let block = [];
  let lastSec = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\[(\d+):(\d\d):(\d\d)\]\s*(.*)$/);
    if (!m) { block.push(escapeMd(line)); continue; }

    const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    if (lastSec !== null && sec - lastSec >= TRANSCRIPT_PARA_GAP && block.length) {
      blocks.push(block);
      block = [];
    }
    lastSec = sec;
    const stamp = +m[1] > 0 ? `${m[1]}:${m[2]}:${m[3]}` : `${m[2]}:${m[3]}`;
    block.push(`**[${stamp}]** ${escapeMd(m[4])}`);
  }
  if (block.length) blocks.push(block);

  // two trailing spaces is a hard line break: lines stay on their own line
  // inside a block, and blocks become real paragraphs
  return blocks.map(b => b.join('  \n')).join('\n\n') + '\n';
}

// A transcript is verbatim, so anything Markdown would swallow gets escaped.
function escapeMd(s) {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

async function runExport(kind) {
  closeExportMenu();
  const title = resultTitle.textContent || 'Meeting';
  const transcript = transcriptEl.textContent || '';
  const hasTranscript = transcript && transcript !== '(no transcript)';

  try {
    if (kind === 'pdf') {
      if (!currentNotesMd) throw new Error('This meeting has no notes yet.');
      return await window.yapper.exportPdf(buildPdfHtml(title), title);
    }
    if (kind === 'md') {
      if (!currentNotesMd) throw new Error('This meeting has no notes yet.');
      return await window.yapper.saveTextFile({
        defaultName: title, extension: 'md', description: 'Markdown',
        content: `${exportHeader()}\n${currentNotesMd}\n`
      });
    }
    if (kind === 'transcript-md') {
      if (!hasTranscript) throw new Error('This meeting has no transcript.');
      return await window.yapper.saveTextFile({
        defaultName: `${title} - transcript`, extension: 'md', description: 'Markdown',
        content: `${exportHeader()}\n## Full transcript\n\n${transcriptToMd(transcript)}`
      });
    }
    if (kind === 'txt') {
      if (!hasTranscript) throw new Error('This meeting has no transcript.');
      return await window.yapper.saveTextFile({
        defaultName: `${title} - transcript`, extension: 'txt', description: 'Text',
        content: `${title}\n${resultDateStr}\n\n${transcript}\n`
      });
    }
    if (kind === 'both') {
      if (!currentNotesMd && !hasTranscript) throw new Error('Nothing to export yet.');
      const parts = [exportHeader()];
      if (currentNotesMd) parts.push('\n' + currentNotesMd + '\n');
      if (hasTranscript) parts.push('\n---\n\n## Full transcript\n\n' + transcriptToMd(transcript));
      return await window.yapper.saveTextFile({
        defaultName: `${title} - full`, extension: 'md', description: 'Markdown',
        content: parts.join('')
      });
    }
  } catch (err) {
    setStatus(regenStatusEl, `Export failed: ${err.message}`, true);
    return null;
  }
}

exportMenu.querySelectorAll('button').forEach(b => {
  b.addEventListener('click', async () => {
    btnExport.disabled = true;
    const saved = await runExport(b.dataset.export);
    btnExport.disabled = false;
    if (saved) {
      const label = btnExport.childNodes[0];
      label.nodeValue = ' Saved ';
      setTimeout(() => { label.nodeValue = ' Export '; }, 1500);
    }
  });
});

btnOpenFolder.addEventListener('click', () => {
  if (currentFolder) window.yapper.openFolder(currentFolder);
});

window.yapper.onTranscribeProgress(text => {
  for (const el of [statusEl, regenStatusEl]) {
    if (el.classList.contains('hidden')) continue;
    // a leading \r means "rewrite the last line", the way a terminal would —
    // otherwise a percentage counter would print a hundred lines
    if (text.startsWith('\r')) {
      const keep = el.textContent.replace(/[^\n]*$/, '');
      el.textContent = keep + text.slice(1);
    } else {
      el.textContent += text;
    }
    el.scrollTop = el.scrollHeight;
  }
});

// ---------- reminders / action items ----------

const btnReminders = $('btn-reminders');
const remindersCount = $('reminders-count');
const remindersList = $('reminders-list');
const newReminderInput = $('new-reminder');
const actionCountEl = $('action-count');

function updateReminderCount(list) {
  const pending = list.filter(r => !r.done).length;
  remindersCount.textContent = pending;
  remindersCount.classList.toggle('hidden', pending === 0);
  updateActionSummary(list);
}

/**
 * The one-line version for the main screen: "5 action items pending, 2 of them
 * high priority." Written from the same list the view shows, so the two can
 * never disagree.
 */
function actionSummaryText(list) {
  const open = list.filter(r => !r.done);
  if (!open.length) return '';
  const high = open.filter(r => r.priority === 'high').length;
  const owned = open.filter(r => r.owner).length;
  const parts = [`${open.length} action item${open.length === 1 ? '' : 's'} pending`];
  if (high) parts.push(`${high} high priority`);
  else if (owned) parts.push(`${owned} with an owner`);
  return parts.join(', including ') + '.';
}

// Which slice of the list is on screen. "Open" first, because the question the
// view answers is "what do I still owe anyone".
let actionFilter = 'open';

const ACTION_FILTERS = {
  open: r => !r.done,
  high: r => !r.done && r.priority === 'high',
  mine: r => !r.done && !!r.owner,
  done: r => r.done,
  all: () => true
};

const EMPTY_FOR = {
  open: 'Nothing pending. Action items appear here as your meetings produce them.',
  high: 'Nothing marked urgent.',
  mine: 'No action item has a named owner yet. Owners come from what was said in the meeting.',
  done: 'Nothing checked off yet.',
  all: 'No action items yet. Add one above, or use the + on an action item inside a meeting.'
};

function renderReminders(list) {
  remindersList.innerHTML = '';
  const shown = list.filter(ACTION_FILTERS[actionFilter] || ACTION_FILTERS.all);

  const open = list.filter(r => !r.done);
  const high = open.filter(r => r.priority === 'high');
  actionCountEl.textContent = list.length
    ? `${shown.length} shown · ${open.length} open${high.length ? `, ${high.length} high priority` : ''}`
    : '';

  if (shown.length === 0) {
    const li = document.createElement('li');
    li.className = 'reminders-empty';
    li.textContent = EMPTY_FOR[actionFilter] || EMPTY_FOR.all;
    remindersList.appendChild(li);
    return;
  }

  // Urgent first, then whatever was said most recently.
  const rank = r => (r.priority === 'high' ? 0 : r.priority === 'low' ? 2 : 1);
  const sorted = [...shown].sort((a, b) =>
    (a.done - b.done) || (rank(a) - rank(b)) || ((b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)));

  for (const r of sorted) {
    const li = document.createElement('li');
    li.className = 'reminder' + (r.done ? ' done' : '') + (r.priority === 'high' ? ' urgent' : '');

    const check = document.createElement('button');
    check.className = 'r-check';
    check.title = r.done ? 'Mark as not done' : 'Mark as done';
    check.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3 3 7-7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    check.addEventListener('click', async () => {
      await window.yapper.updateReminder(r.id, { done: !r.done, updatedAt: Date.now() });
      await refreshReminders();
    });

    const main = document.createElement('div');
    main.className = 'r-main';
    const text = document.createElement('input');
    text.className = 'r-text';
    text.value = r.text;
    text.addEventListener('change', () =>
      window.yapper.updateReminder(r.id, { text: text.value.trim(), updatedAt: Date.now() }));
    text.addEventListener('keydown', e => { if (e.key === 'Enter') text.blur(); });
    main.appendChild(text);

    // Everything below the text is only shown when the meeting actually said it.
    const meta = document.createElement('div');
    meta.className = 'r-meta';

    if (r.owner) meta.appendChild(chip('r-owner', r.owner, 'Owner'));
    if (r.due) meta.appendChild(chip('r-due', r.due, 'Due'));
    if (r.priority === 'high') meta.appendChild(chip('r-prio', 'high priority', ''));

    if (r.folder) {
      const open = document.createElement('button');
      open.className = 'r-open';
      open.textContent = r.meeting || 'the meeting';
      open.title = `Open ${r.meeting || 'the meeting'}${r.meetingDate ? ` — ${r.meetingDate}` : ''}`;
      open.addEventListener('click', () => openMeetingByFolder(r.folder));
      meta.appendChild(open);
    } else if (r.source) {
      meta.appendChild(chip('r-source', `from: ${r.source}`, ''));
    }

    // Mentioned again in later meetings: one row, all its sources.
    const extra = (r.mentions || []).filter(x => x.folder !== r.folder);
    if (extra.length) {
      const again = document.createElement('span');
      again.className = 'r-again';
      again.textContent = `also in ${extra.length} other meeting${extra.length === 1 ? '' : 's'}`;
      again.title = extra.map(x => `${x.title} — ${x.date}`).join('\n');
      meta.appendChild(again);
    }

    if (meta.childNodes.length) main.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'r-del';
    del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    del.addEventListener('click', async () => {
      await window.yapper.deleteReminder(r.id);
      await refreshReminders();
    });

    li.append(check, main, del);
    remindersList.appendChild(li);
  }
}

function chip(cls, value, label) {
  const el = document.createElement('span');
  el.className = `r-chip ${cls}`;
  el.textContent = value;
  if (label) el.title = `${label}: ${value}`;
  return el;
}

/** Open a meeting from anywhere that references one. */
async function openMeetingByFolder(folder) {
  if (!folder) return;
  try {
    const data = await window.yapper.loadMeeting(folder);
    currentFolder = folder;
    openMeetingView(data.title || formatMeetingDate(folder.split(/[\\/]/).pop()),
      data.summary, data.transcript, data.hasRecording, data.participants);
    renderMeetingList();
  } catch (err) {
    setStatus(statusEl, `That meeting could not be opened: ${err.message}`, true);
  }
}

async function refreshReminders() {
  const list = await window.yapper.listActions();
  updateReminderCount(list);
  if (!viewReminders.classList.contains('hidden')) renderReminders(list);
  return list;
}

document.querySelectorAll('#action-filter .seg-btn').forEach(b => {
  b.addEventListener('click', async () => {
    actionFilter = b.dataset.filter;
    document.querySelectorAll('#action-filter .seg-btn').forEach(x =>
      x.classList.toggle('active', x === b));
    renderReminders(await window.yapper.listActions());
  });
});

async function addReminderFromText(text, source) {
  const t = (text || '').trim();
  if (!t) return false;
  await window.yapper.addReminder(t, source || '');
  await refreshReminders();
  return true;
}

const actionSummaryEl = $('action-summary');

function updateActionSummary(list) {
  const text = actionSummaryText(list);
  actionSummaryEl.textContent = text;
  actionSummaryEl.classList.toggle('hidden', !text);
}

actionSummaryEl.addEventListener('click', () => btnReminders.click());

btnReminders.addEventListener('click', async () => {
  stopSpeak();
  showView('reminders');
  const list = await window.yapper.listActions();
  updateReminderCount(list);
  renderReminders(list);
});

function submitNewReminder() {
  const t = newReminderInput.value.trim();
  if (!t) return;
  newReminderInput.value = '';
  addReminderFromText(t, '');
}
$('btn-add-reminder').addEventListener('click', submitNewReminder);
newReminderInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitNewReminder(); });

// ---------- init ----------

syncOptionControls();
showView('record');
refreshMeetingList();
refreshReminders();

(async () => {
  await unlockMicLabels();
  await populateMicSelect();
})();

(async () => {
  try {
    const env = await window.yapper.checkEnvironment();
    const issues = [];
    if (!env.whisper) issues.push('• The transcription engine is missing — transcription will not work. Run setup.ps1 from the app folder.');
    if (env.notes && !env.notes.ok) issues.push(`• ${env.notes.reason} Recording and transcription still work.`);
    if (issues.length) {
      setStatus(statusEl, 'Setup needed:\n' + issues.join('\n'), true);
    } else if (env.tier === 'modest') {
      // not a failure: this machine simply gets the transcript after the
      // meeting instead of during it
      setStatus(statusEl, 'Live transcript is off on this machine — it is not fast enough to keep up. Recording and notes work as usual.');
    }
  } catch { /* never block the app on the preflight check */ }
})();
