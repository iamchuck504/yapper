const $ = id => document.getElementById(id);

const viewRecord = $('view-record');
const viewMeeting = $('view-meeting');
const viewReminders = $('view-reminders');
const viewSearch = $('view-search');
const btnRecord = $('btn-record');
const btnStop = $('btn-stop');
const btnNew = $('btn-new');
const btnNewLabel = $('btn-new-label');

// ---------- the options fold away ----------
// The card is a page of settings sitting between the reader and the button
// they came for. Recording and importing are the first thing in the view now,
// and the settings live behind one line that says what is currently chosen —
// open it when you want to change something, which is not most meetings.
const viewRecordEl = $('view-record');
const optionsCardEl = $('options-card');
const optsToggleEl = $('opts-toggle');

/** "General · Concise" — what the folded card is currently set to. */
function chosenOptions() {
  const picked = sel => {
    const b = document.querySelector(`${sel} .seg-btn.active`);
    return b ? b.textContent.trim() : null;
  };
  // The language is only worth a word in the summary when it is not the default.
  // Read from the DOM, not `options`: this runs during module evaluation, before
  // that object exists.
  const langBtn = document.querySelector('#lang-seg .seg-btn.active');
  const lang = langBtn && langBtn.dataset.lang !== 'en' ? langBtn.textContent.trim() : null;
  return [picked('#style-pills'), picked('#detail-seg'), lang].filter(Boolean).join(' · ');
}

function paintOptsToggle() {
  const open = !optionsCardEl.classList.contains('collapsed');
  const what = chosenOptions();
  $('opts-sum').textContent = what;
  // "Show" / "Hide" spelled out beside the chevron: the chevron alone was read
  // as decoration on a label, and the settings behind it were never found.
  $('opts-more-text').textContent = open ? 'Hide' : 'Show';
  // Something in there is unfinished — today only a provider without its key.
  // Folded, that warning is off screen, and the first time it is noticed is at
  // the end of the first meeting, which is what it exists to prevent.
  // Looked up rather than closed over: this runs once during module
  // evaluation, before the settings elements have been bound.
  const llm = document.getElementById('llm-status');
  $('opts-flag').classList.toggle('hidden', open || !llm || llm.dataset.kind !== 'needs-key');
  optsToggleEl.setAttribute('aria-expanded', String(open));
}

function setOptionsOpen(open) {
  optionsCardEl.classList.toggle('collapsed', !open);
  paintOptsToggle();
}

optsToggleEl.addEventListener('click', () =>
  setOptionsOpen(optionsCardEl.classList.contains('collapsed')));

// Folded, every launch. It used to remember having been opened, which meant
// the view could still open on the wall of settings instead of on the button
// people came for — the whole point of the fold.
setOptionsOpen(false);
localStorage.removeItem('yapper-options-open');

function layoutForRecording(on) {
  viewRecordEl.classList.toggle('is-recording', on);
  // Nothing in there can be changed mid-meeting, so it folds and stays folded
  // until the recording ends.
  if (on) setOptionsOpen(false);
  paintOptsToggle();
}

/** The sidebar button doubles as the recording indicator and the way back. */
function markRecordingInSidebar(on) {
  layoutForRecording(on);
  btnNew.classList.toggle('recording', on);
  btnNew.title = on ? 'Recording — click to go back to the controls' : '';
  if (!on) btnNewLabel.textContent = 'New meeting';
}
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
const regenLang = $('regen-lang');

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

// macOS: the system waveform's samples are captured and mixed in the main
// process, so they arrive over IPC — but drawing them as they arrive tied the
// animation to the delivery rate, about eighteen packets a second, and it read
// as robotic beside a microphone meter running off a live analyser every
// frame.
//
// So the packets fill a ring, and the drawing walks that ring on its own
// clock: 256 points per second of audio, advanced by however long the last
// frame took. Between packets it keeps moving through samples it already has,
// which is what makes it look like sound rather than like a slideshow. It
// deliberately reads a little behind the newest sample, because a trace that
// stalls waiting for the next packet is exactly the stutter being removed.
const SYS_WAVE_POINTS = 160;    // one screenful: 10 ms, like the mic's analyser
const SYS_WAVE_RATE = 16000;
const SYS_RING = 8192;          // half a second of slack
const SYS_LAG = 1600;           // 100 ms, against a late packet

const sysRing = new Uint8Array(SYS_RING).fill(128);
let sysWritten = 0;                 // points ever received
let sysCursor = 0;                  // points already drawn past
let sysFrameAt = 0;

if (window.yapper.platform === 'darwin') {
  window.yapper.onSystemWave(bytes => {
    // Packets keep arriving for a moment after stopping — the helper is asked
    // to stop from here and takes a beat to hear it. Without this, the ring is
    // emptied on stop and then refilled by that tail, and the next meeting
    // opens on the previous one's audio.
    if (!recording || !bytes || !bytes.length) return;
    for (let i = 0; i < bytes.length; i++) sysRing[(sysWritten + i) % SYS_RING] = bytes[i];
    sysWritten += bytes.length;
  });
}

function resetSysWave() {
  sysRing.fill(128);
  sysWritten = 0;
  sysCursor = 0;
  sysFrameAt = 0;
}

/** The next screenful, walked at the rate the audio was recorded. */
function sysWaveInto(target) {
  const now = performance.now();
  const dt = sysFrameAt ? Math.min(0.25, (now - sysFrameAt) / 1000) : 0;
  sysFrameAt = now;
  sysCursor += dt * SYS_WAVE_RATE;

  // Never past what has arrived, and never so far behind that the trace is
  // showing old news — a long stall is caught up rather than crawled through.
  const newest = sysWritten - SYS_WAVE_POINTS - SYS_LAG;
  if (sysCursor > newest) sysCursor = newest;
  if (sysCursor < newest - SYS_WAVE_RATE) sysCursor = newest;
  if (sysCursor < 0) sysCursor = 0;

  const start = Math.floor(sysCursor);
  for (let i = 0; i < target.length; i++) {
    target[i] = sysWritten > 0 ? sysRing[(start + i) % SYS_RING] : 128;
  }
}
let gainMic = numOr(localStorage.getItem('yapper-gain-mic'), 1);
const micStreams = new Map(); // deviceId|'default' -> MediaStream
const micNodes = new Map();   // deviceId|'default' -> MediaStreamAudioSourceNode
let analysers = { sys: null, mic: null };
let liveActive = false;
let liveParagraphs = []; // stable text, split into paragraphs on long pauses
let liveTentative = '';  // unstable tail, still being refined
let liveDirty = false;   // text arrived while the transcript was not on screen
// Whether this window is on screen, as the main process sees it. `document
// .hidden` cannot answer this while a recording is running: background
// throttling is lifted then, and Chromium reports a hidden or minimized
// window as visible precisely so the page keeps working.
let windowOnScreen = true;
window.yapper.onWindowVisible(v => { windowOnScreen = v; });
let timerInterval = null;
let levelTimer = null;     // the pause between meter frames
let micError = null;       // why the last microphone acquisition failed, if it did
let currentFolder = null;
let currentNotesMd = '';
let resultDateStr = '';
let allMeetings = [];
let searchQuery = '';
let noteStreamFolder = '';
let noteStreamStartedAt = 0;
let noteStreamFirstTextMs = null;
let noteStreamFrame = 0;
let noteStreamTimer = 0;     // the pause between streaming paints
let noteStreamPaintAt = 0;   // when the draft was last painted
let noteStreamPending = null;
let noteStreamPreviousMd = '';

const resultDate = $('result-date');
const resultSpeed = $('result-speed');
const searchInput = $('search');
const btnSpeak = $('btn-speak');
const voiceSelect = $('voice-select');

const micSelect = $('mic-select');
let micSelection = localStorage.getItem('yapper-mic') || 'default';

const liveWrap = $('live-wrap');
const liveTranscriptEl = $('live-transcript');

// ---------- theme (persisted) ----------

const btnTheme = $('btn-theme');
const themeSeg = $('theme-seg');
// The preference, which may be "auto" — not the colour it resolves to. Dark
// unless someone chose otherwise. Main resolves the same three values before
// the stylesheet lands, for the window background and the splash, so the
// defaults have to agree or a launch opens on a flash of the other one.
const THEMES = ['auto', 'light', 'dark'];
let theme = THEMES.includes(window.yapper.theme) ? window.yapper.theme : 'dark';
// It used to live here too, and the two copies drifted apart: settings said
// auto while this said light, so the window opened one colour and the page
// painted the other. Settings is the only copy now.
localStorage.removeItem('yapper-theme');

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = () =>
  theme === 'auto' ? (systemDark.matches ? 'dark' : 'light') : theme;

function applyTheme() {
  const showing = resolvedTheme();
  document.body.classList.toggle('light', showing === 'light');
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === theme));
  // The bubble is told what to paint; main is told what was chosen, so that
  // "auto" is still "auto" the next time the app opens.
  window.yapper.bubbleState({ theme: showing });
  window.yapper.setTheme(theme);
}

function setTheme(next) {
  theme = THEMES.includes(next) ? next : 'dark';
  applyTheme();       // which is what tells main, the only place it is kept
}

// On auto, the system can change under a running app — at sunset, or when
// someone flips it in System Settings. Following it is the whole point.
systemDark.addEventListener('change', () => { if (theme === 'auto') applyTheme(); });

// The button beside the title is the quick way, and it commits to a side:
// flipping "auto" would otherwise land on whatever the system already was.
btnTheme.addEventListener('click', () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'));

themeSeg.addEventListener('click', e => {
  const b = e.target.closest('.seg-btn');
  if (b) setTheme(b.dataset.theme);
});

applyTheme();

// ---------- note options (persisted) ----------

const participantsRec = $('participants-rec');
const participantsMeet = $('participants-meet');
const speakerMapEl = $('speaker-map');
const speakerMapFields = $('speaker-map-fields');
const speakerNameOptions = $('speaker-name-options');
let currentSpeakers = [];
let speakerSaveTimer = 0;

const options = Object.assign(
  { style: 'general', detail: 'concise', lang: 'en', custom: '' },
  JSON.parse(localStorage.getItem('yapper-options') || '{}')
);
if (!['en', 'es', 'auto'].includes(options.lang)) options.lang = 'en';
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

function meetingParticipantNames() {
  return [...new Set(participantsMeet.value.split(/[,;\n]/)
    .map(name => name.trim()).filter(Boolean))].slice(0, 100);
}

function speakerLabelText(label) {
  if (label === 'Me') return 'Recorder (Me)';
  if (label === 'Them') return 'Remote side';
  return label;
}

function paintSpeakerMap(speakers = currentSpeakers) {
  currentSpeakers = Array.isArray(speakers) ? speakers : [];
  speakerMapFields.replaceChildren();
  speakerNameOptions.replaceChildren(...meetingParticipantNames().map(name => {
    const option = document.createElement('option');
    option.value = name;
    return option;
  }));
  speakerMapEl.classList.toggle('hidden', !currentSpeakers.length);
  for (const speaker of currentSpeakers) {
    const row = document.createElement('div');
    row.className = 'speaker-field';
    const label = document.createElement('label');
    label.textContent = speakerLabelText(speaker.label);
    const input = document.createElement('input');
    input.value = speaker.name || '';
    input.placeholder = 'Choose or type a name';
    input.setAttribute('list', 'speaker-name-options');
    input.dataset.speaker = speaker.label;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', scheduleSpeakerMapSave);
    input.addEventListener('change', () => scheduleSpeakerMapSave(true));
    row.append(label, input);
    speakerMapFields.appendChild(row);
  }
}

function scheduleSpeakerMapSave(now = false) {
  clearTimeout(speakerSaveTimer);
  const folder = currentFolder;
  const save = async () => {
    if (!folder || folder !== currentFolder) return;
    const map = {};
    speakerMapFields.querySelectorAll('input[data-speaker]').forEach(input => {
      if (input.value.trim()) map[input.dataset.speaker] = input.value.trim();
    });
    try {
      const result = await window.yapper.setSpeakerMap(folder, map);
      if (folder !== currentFolder) return;
      transcriptEl.textContent = result.transcript || '(no transcript)';
      currentSpeakers = result.speakers || [];
      setStatus(regenStatusEl, 'Speaker names saved. Regenerate the notes to update them.');
      await refreshMeetingList();
    } catch (err) {
      if (folder === currentFolder) setStatus(regenStatusEl, `Could not save speaker names: ${err.message}`, true);
    }
  };
  speakerSaveTimer = setTimeout(save, now ? 0 : 500);
}

participantsMeet.addEventListener('input', () => paintSpeakerMap());

function syncOptionControls() {
  document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
    p.classList.toggle('active', p.dataset.style === options.style));
  document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.detail === options.detail));
  document.querySelectorAll('#noise-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.noise === noiseReduction));
  document.querySelectorAll('#lang-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === options.lang));
  customInput.value = options.custom || '';
  regenStyle.value = options.style;
  regenDetail.value = options.detail;
  regenLang.value = options.lang;
  // The folded line summarises these. Without this it kept whatever was chosen
  // the last time the fold was opened or closed — a summary that says
  // "General · Concise" over a meeting set to Minutes is worse than none.
  paintOptsToggle();
}

document.querySelectorAll('#style-pills .seg-btn').forEach(p =>
  p.addEventListener('click', () => { options.style = p.dataset.style; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#detail-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { options.detail = b.dataset.detail; saveOptions(); syncOptionControls(); }));
document.querySelectorAll('#noise-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { setNoiseReduction(b.dataset.noise); syncOptionControls(); }));
document.querySelectorAll('#lang-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => { options.lang = b.dataset.lang; saveOptions(); syncOptionControls(); }));
customInput.addEventListener('change', saveOptions);


// ---------- live behaviour toggles (persisted) ----------

const bubbleToggle = $('opt-bubble');
const autoDetectToggle = $('opt-autodetect');
const startupToggle = $('opt-startup');
// The switch does the same thing on both platforms, but "Start with Windows"
// on a Mac reads like a setting that belongs to some other computer.
if (window.yapper.platform === 'darwin') $('startup-label').textContent = 'Start at login';
let bubbleEnabled = localStorage.getItem('yapper-bubble') !== 'off';
let autoDetectEnabled = localStorage.getItem('yapper-autodetect') !== 'off';   // on by default

bubbleToggle.checked = bubbleEnabled;
autoDetectToggle.checked = autoDetectEnabled;
window.yapper.setAutoDetect(autoDetectEnabled);

// "start with Windows" lives in the main process (it writes the login item),
// and on macOS the main process is only reporting what the system said. It can
// answer something other than what was asked: refused, waiting to be allowed in
// System Settings, or unavailable because this copy is not installed anywhere a
// registration would still mean it tomorrow. So the answer decides what the
// switch shows, never the click.
const startupHint = $('startup-hint');

// The controller is in startup-switch.js so the awkward half — what the switch
// does when the answer never arrives — can be run without a browser. The
// checkbox is a request, never the record: after a failed write it holds the
// value that failed, so the controller keeps the last confirmed view and falls
// back to it, which is what makes the next click a retry rather than the
// opposite request.
const startupSwitch = createStartupSwitch({
  get: () => window.yapper.getOpenAtLogin(),
  set: on => window.yapper.setOpenAtLogin(on),
  render: view => {
    startupToggle.checked = !!view.checked;
    startupToggle.disabled = !!view.disabled;
    startupHint.textContent = view.hint || '';
    startupHint.hidden = !view.hint;
  }
});

startupSwitch.load();
startupToggle.addEventListener('change', () => startupSwitch.toggle(startupToggle.checked));

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

// The language Whisper is told to expect. Lives in the main process (it is
// the transcriber's setting) and is pushed there the same way auto-detect is.
const spokenLangSelect = $('spoken-lang');
let spokenLang = localStorage.getItem('yapper-spoken-lang') || 'auto';
if (![...spokenLangSelect.options].some(o => o.value === spokenLang)) spokenLang = 'auto';
spokenLangSelect.value = spokenLang;
window.yapper.setSpokenLanguage(spokenLang);
spokenLangSelect.addEventListener('change', () => {
  spokenLang = spokenLangSelect.value;
  localStorage.setItem('yapper-spoken-lang', spokenLang);
  window.yapper.setSpokenLanguage(spokenLang);
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
  paintOptsToggle();     // folded, the toggle line is where this has to show
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
  refreshSetupBanner();
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
  if (res.ok) { setLlmStatus(`Working — replied in ${res.ms} ms.`, 'ok'); refreshSetupBanner(); }
  else setLlmStatus(res.error, 'error');
  btn.disabled = false;
});

// ---------- meeting detection prompt ----------

const meetingPrompt = $('meeting-prompt');

// On macOS the other side of the call is captured natively, outside this
// process, so its failures have to be reported from there. The one worth acting
// on is the permission: without Screen Recording the recording is half a
// conversation, and the user is the only one who can fix that.
const screenPrompt = $('screen-prompt');
let missingPane = 'screen';       // which Settings pane the button should open

window.yapper.onSystemAudioStatus(info => {
  if (info.ok) {
    // It works now — whatever was on screen about it no longer applies. Only
    // what this handler put there: a microphone failure is still true.
    screenPrompt.classList.add('hidden');
    clearStatus(statusEl, 'sysaudio');
    return;
  }

  // Capture is still running; the helper only doubts it is hearing anything.
  if (info.reason === 'suspect') {
    setStatus(statusEl, info.which === 'audio'
      ? 'The other side of the call has been silent while other apps were playing. '
        + 'If that is wrong, check System Audio Recording Only in Privacy & Security — '
        + 'macOS applies it after Yapper is reopened.'
      // The screen door cannot hear protected playback at all, and on this
      // machine there is no other door: worth knowing before the meeting ends.
      : 'System audio has remained silent. '
        + 'Some apps (Safari playing protected video, for one) cannot be captured '
        + 'this way on this Mac.',
      false, 'sysaudio');
    return;
  }

  // The permission case gets buttons rather than a sentence. It used to say
  // "then record again", which does not work: macOS does not apply the grant
  // to a process that was already running, so following the instruction to the
  // letter produced another one-sided recording and no explanation.
  // Only an actual refusal gets it. Any other helper failure used to land
  // here too and told the user to grant Screen Recording — a page whose switch
  // may already be on, for a failure that was never about permission.
  if (info.reason === 'permission') {
    // A refusal is the definitive version of any doubt written earlier.
    clearStatus(statusEl, 'sysaudio');
    // Which permission depends on the route the helper took. Naming the wrong
    // one sends the user to a page that does not contain the switch.
    missingPane = info.which === 'audio' ? 'audio' : 'screen';
    $('sp-detail').textContent = (missingPane === 'audio'
      ? 'Allow Yapper under System Audio Recording Only to capture the other '
        + 'side of the call. macOS applies it only after Yapper is reopened.'
      : 'Allow Yapper under Screen Recording to capture the other side of the '
        + 'call. macOS applies it only after Yapper is reopened.')
      // It was working and is now gone: say so, or the user learns afterwards.
      + (info.midRecording && recording
        ? ' System audio stopped partway through — from here only your microphone is being recorded.'
        : '');
    $('sp-relaunch').disabled = recording;
    $('sp-relaunch').title = recording
      ? 'Stop the recording first — reopening now would discard it.'
      : '';
    screenPrompt.classList.remove('hidden');
    return;
  }

  // 'stopped' is the one that arrives mid-recording: capture was working and
  // died. Said differently on purpose — the rest of this meeting is one-sided,
  // and finding that out afterwards is worse than being interrupted now.
  setStatus(statusEl,
    info.reason === 'stopped'
      ? 'System audio stopped partway through — from here only your microphone is being recorded.'
      : 'Only your microphone is being recorded: system audio could not be started.',
    true, 'sysaudio');
});

$('sp-settings').addEventListener('click', () => window.yapper.openScreenSettings(missingPane));
$('sp-dismiss').addEventListener('click', () => screenPrompt.classList.add('hidden'));
$('sp-relaunch').addEventListener('click', async () => {
  if (recording) return;                 // the disabled state already says why
  await window.yapper.relaunchApp();
});

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
regenLang.addEventListener('change', () => { options.lang = regenLang.value; saveOptions(); syncOptionControls(); });

// ---------- helpers ----------

// The settings view hosts the record view's options card rather than a copy of
// it: one element, one set of listeners, nothing to keep in sync. Opening the
// view moves the card in and unfolds it; leaving moves it back and folds it,
// so the record view still opens on the button, not on the wall of settings.
function hostOptionsCard(inSettings) {
  if (inSettings) {
    $('settings-host').appendChild(optionsCardEl);
    optionsCardEl.classList.remove('collapsed');
  } else if (optionsCardEl.parentElement !== viewRecordEl) {
    optsToggleEl.insertAdjacentElement('afterend', optionsCardEl);
    setOptionsOpen(false);
  }
}

function showView(name) {
  viewRecord.classList.toggle('hidden', name !== 'record');
  viewMeeting.classList.toggle('hidden', name !== 'meeting');
  viewReminders.classList.toggle('hidden', name !== 'reminders');
  viewSearch.classList.toggle('hidden', name !== 'search');
  $('view-home').classList.toggle('hidden', name !== 'home');
  $('view-settings').classList.toggle('hidden', name !== 'settings');
  $('btn-reminders').classList.toggle('active', name === 'reminders');
  $('btn-search-view').classList.toggle('active', name === 'search');
  $('btn-home').classList.toggle('active', name === 'home');
  $('btn-settings').classList.toggle('active', name === 'settings');
  hostOptionsCard(name === 'settings');
  if (name === 'record' && liveDirty) renderLiveTranscript();
  if (name === 'meeting' && noteStreamPending) scheduleStreamingPaint();
}

$('btn-settings').addEventListener('click', () => {
  stopSpeak();
  showView('settings');
});

// ---------- "notes need a provider", on the first screen ----------
// The record view has always reported a provider that cannot work, but a new
// install opens on Today, where nobody saw it until the end of the first
// meeting. Same check, shown where the eyes are; gone the moment it is fixed.
const homeSetupEl = $('home-setup');

async function refreshSetupBanner(notes) {
  try {
    const n = notes || await window.yapper.notesReady();
    const missing = !!(n && n.ok === false);
    $('home-setup-reason').textContent = missing ? (n.reason || '') : '';
    homeSetupEl.classList.toggle('hidden', !missing);
  } catch { /* a failed check never blocks the day */ }
}

$('home-setup-open').addEventListener('click', () => {
  stopSpeak();
  showView('settings');
  const provider = $('llm-provider');
  provider.scrollIntoView({ block: 'center' });
  provider.focus();
});

// The recorder can have two independent faults at once. A single `dataset`
// owner prevents one source from clearing the other's line, but it cannot
// preserve a line that was overwritten in between. Keep the active owned
// statuses here; clearing one restores the newest remaining one.
const ownedStatuses = new Map();
let ownedStatusSequence = 0;

function paintStatus(el, text, isError, source) {
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
  el.textContent = text;
  el.dataset.source = source;
  el.scrollTop = el.scrollHeight;
}

function setStatus(el, text, isError = false, source = '') {
  if (el === statusEl) {
    if (source) {
      ownedStatuses.set(source, { text, isError, source, sequence: ++ownedStatusSequence });
    } else {
      // General recorder/transcription progress supersedes recording-source
      // warnings from the phase that just ended.
      ownedStatuses.clear();
    }
  }
  paintStatus(el, text, isError, source);
}

function clearStatus(el, source = '') {
  if (el !== statusEl) { el.classList.add('hidden'); return; }
  if (!source) {
    ownedStatuses.clear();
    el.dataset.source = '';
    el.classList.add('hidden');
    return;
  }
  ownedStatuses.delete(source);
  if (el.dataset.source !== source) return;
  const remaining = [...ownedStatuses.values()].sort((a, b) => b.sequence - a.sequence)[0];
  if (remaining) paintStatus(el, remaining.text, remaining.isError, remaining.source);
  else {
    el.dataset.source = '';
    el.classList.add('hidden');
  }
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

function renderNotes(md, interactive = true) {
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
        `<div class="note-head"><span>${escapeHtml(title)}</span></div>` +
        bodyToHtml(sec.body);
      if (interactive) decorateCopyButton(el, sec);
      if (interactive && (meta.cls === 'sec-action' || meta.cls === 'sec-next')) decorateAddButtons(el);
    }
    notesEl.appendChild(el);
  }
}

const folderName = folder => String(folder || '').split(/[\\/]/).pop();

/** One section as markdown, the shape that pastes cleanly into a chat or an email. */
function sectionMarkdown(sec) {
  return `## ${sec.title}\n\n${sec.body.join('\n').trim()}\n`;
}

// A small Copy on each card, shown on hover like the "+ my list" controls: the
// whole note is rarely what gets pasted into Slack — the action items are.
function decorateCopyButton(el, sec) {
  const head = el.querySelector('.note-head');
  if (!head) return;
  const btn = document.createElement('button');
  btn.className = 'sec-copy';
  btn.type = 'button';
  btn.textContent = 'Copy';
  btn.title = 'Copy this section as markdown';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sectionMarkdown(sec));
      btn.textContent = 'Copied';
      btn.classList.add('copied');
    } catch {
      btn.textContent = 'Failed';
    }
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1400);
  });
  head.appendChild(btn);
}

function seconds(ms) {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}

/** Small, local timings make a slow provider distinguishable from Whisper. */
function showGenerationTiming(timing) {
  const parts = [];
  if (timing && timing.transcribeMs != null) parts.push(`transcript ${seconds(timing.transcribeMs)}`);
  if (timing && timing.firstTextMs != null) parts.push(`first notes ${seconds(timing.firstTextMs)}`);
  if (timing && timing.notesMs != null) parts.push(`complete ${seconds(timing.notesMs)}`);
  resultSpeed.textContent = parts.length ? `Measured here · ${parts.join(' · ')}` : '';
  resultSpeed.classList.toggle('hidden', !parts.length);
}

function setNotesBusy(busy) {
  notesEl.setAttribute('aria-busy', String(busy));
  for (const id of ['btn-copy', 'btn-speak', 'btn-edit', 'btn-export']) {
    const control = $(id);
    if (control) control.disabled = busy;
  }
  notesEl.querySelectorAll('.li-add').forEach(control => { control.disabled = busy; });
  regenStyle.disabled = busy;
  regenDetail.disabled = busy;
  const hasTranscript = transcriptEl.textContent && transcriptEl.textContent !== '(no transcript)';
  btnRegen.disabled = !busy && !hasTranscript;
  btnRegen.querySelector('.regen-label').textContent = busy ? 'Cancel' : 'Regenerate';
  btnRegen.title = busy ? 'Cancel note generation; the transcript stays safe'
    : 'Regenerate notes with the selected style';
}

/** Hide the metadata line until it is complete; everything after it is notes. */
function splitStreamingDraft(raw) {
  const text = String(raw || '').replace(/^\s+/, '');
  const expected = 'YAPPER_TITLE:';
  const upper = text.toUpperCase();
  const newline = text.search(/\r?\n/);
  if (newline < 0 && (expected.startsWith(upper) || upper.startsWith(expected))) {
    return { title: '', summary: '' };
  }
  if (upper.startsWith(expected)) {
    const lineEnd = newline < 0 ? text.length : newline;
    return {
      title: text.slice(expected.length, lineEnd).trim().slice(0, 120),
      summary: newline < 0 ? '' : text.slice(lineEnd).replace(/^\r?\n+/, '')
    };
  }
  return { title: '', summary: text };
}

// The draft used to be re-parsed and rebuilt on every animation frame while
// tokens streamed in — sixty rebuilds a second of a document that grows to
// several kilobytes, for the whole generation. Ten a second reads the same;
// and a meeting view that is not on screen is painted once, when it is.
const NOTE_PAINT_MS = 100;

function scheduleStreamingPaint() {
  if (noteStreamFrame || noteStreamTimer) return;
  const wait = Math.max(0, NOTE_PAINT_MS - (performance.now() - noteStreamPaintAt));
  noteStreamTimer = setTimeout(() => {
    noteStreamTimer = 0;
    noteStreamFrame = requestAnimationFrame(paintStreamingDraft);
  }, wait);
}

function paintStreamingDraft() {
  noteStreamFrame = 0;
  if (!noteStreamPending || !noteStreamFolder) { noteStreamPending = null; return; }
  if (viewMeeting.classList.contains('hidden')) return;   // kept pending for showView
  const draft = noteStreamPending;
  noteStreamPending = null;
  noteStreamPaintAt = performance.now();
  if (draft.title) resultTitle.textContent = draft.title;
  if (draft.summary.trim()) renderNotes(draft.summary, false);
}

function beginNotesStream(folder, title, transcript, participants, keepNotes = false) {
  const previous = keepNotes ? currentNotesMd : '';
  openMeetingView(title || 'Writing notes…', previous, transcript,
    true, participants);
  noteStreamFolder = folderName(folder);
  noteStreamStartedAt = performance.now();
  noteStreamFirstTextMs = null;
  noteStreamPending = null;
  noteStreamPreviousMd = previous;
  if (!keepNotes) {
    currentNotesMd = '';
    notesEl.innerHTML = '<div class="note-sec sec-neutral notes-writing"><p>Notes will appear here as they are written…</p></div>';
  }
  setNotesBusy(true);
  setStatus(regenStatusEl, 'Writing notes…');
  document.querySelector('#view-meeting details').open = false;
}

function finishNotesStream(timing = null) {
  if (noteStreamFrame) cancelAnimationFrame(noteStreamFrame);
  if (noteStreamTimer) clearTimeout(noteStreamTimer);
  noteStreamFrame = 0;
  noteStreamTimer = 0;
  noteStreamPending = null;
  noteStreamFolder = '';
  noteStreamPreviousMd = '';
  setNotesBusy(false);
  regenStatusEl.classList.add('hidden');
  showGenerationTiming(timing);
}

function failNotesStream(message, retry = false) {
  if (noteStreamFrame) cancelAnimationFrame(noteStreamFrame);
  if (noteStreamTimer) clearTimeout(noteStreamTimer);
  noteStreamFrame = 0;
  noteStreamTimer = 0;
  noteStreamPending = null;
  noteStreamFolder = '';
  const previous = noteStreamPreviousMd;
  noteStreamPreviousMd = '';
  // A partial response is useful only while it is visibly in progress. Once
  // the job fails or is canceled, return to the last complete saved state —
  // or the honest empty state for a meeting that never had notes.
  renderNotes(previous);
  setNotesBusy(false);
  // The placeholder title was waiting on the same response that failed.
  if (resultTitle.textContent === 'Writing notes…') resultTitle.textContent = resultDateStr || 'Untitled meeting';
  setStatus(regenStatusEl, message, true);
  // The transcript is on disk, so the expensive half is done: offer the cheap
  // half as one button instead of a sentence pointing at Regenerate.
  if (retry && currentFolder) {
    const btn = document.createElement('button');
    btn.id = 'btn-retry-notes';
    btn.className = 'inline-action';
    btn.type = 'button';
    btn.textContent = 'Retry notes';
    btn.title = 'Write the notes again from the saved transcript — nothing is re-transcribed';
    btn.addEventListener('click', retryNotes);
    regenStatusEl.append(document.createElement('br'), btn);
  }
}

/**
 * The notes again, from the transcript already on disk. Unlike Regenerate this
 * also asks for a title when the meeting never got one — the failed request was
 * the one that would have named it.
 */
async function retryNotes() {
  if (!currentFolder || noteStreamFolder) return;
  const needsTitle = !resultTitle.textContent || resultTitle.textContent === resultDateStr
    || resultTitle.textContent === 'Untitled meeting';
  const participants = participantsMeet.value.trim();
  const started = performance.now();
  beginNotesStream(currentFolder, resultTitle.textContent, transcriptEl.textContent, participants, true);
  setStatus(regenStatusEl, 'Writing the notes again from the saved transcript…');
  try {
    const draft = await window.yapper.generateNotes(currentFolder, { ...options, participants }, needsTitle);
    if (draft.title) resultTitle.textContent = draft.title;
    renderNotes(draft.summary);
    finishNotesStream({ firstTextMs: noteStreamFirstTextMs, notesMs: performance.now() - started });
    await refreshMeetingList();
  } catch (err) {
    failNotesStream(noteGenerationCanceled(err)
      ? 'Note generation canceled. The transcript is safe.'
      : `The notes failed again: ${err.message}`, !noteGenerationCanceled(err));
  }
}

const noteGenerationCanceled = err => /generation canceled/i.test(String(err && err.message || err));

window.yapper.onNotesProgress(progress => {
  if (!noteStreamFolder || folderName(currentFolder) !== noteStreamFolder
      || folderName(progress && progress.folder) !== noteStreamFolder) return;
  if (noteStreamFirstTextMs == null) {
    noteStreamFirstTextMs = progress.firstTextMs != null
      ? progress.firstTextMs : performance.now() - noteStreamStartedAt;
  }
  noteStreamPending = splitStreamingDraft(progress.text);
  scheduleStreamingPaint();
  // The same string after the first chunk; setStatus forces a layout each time.
  const status = `Writing notes… first text in ${seconds(noteStreamFirstTextMs)}`;
  if (regenStatusEl.textContent !== status || regenStatusEl.classList.contains('hidden')) {
    setStatus(regenStatusEl, status);
  }
});

// The notes may describe everybody's work. Nothing enters the personal list
// until this button is chosen on that specific item.
function decorateAddButtons(card) {
  for (const li of card.querySelectorAll('li')) {
    const text = li.textContent.trim();
    if (!text) continue;
    const btn = document.createElement('button');
    btn.className = 'li-add';
    btn.textContent = '+ my list';
    btn.title = 'Add this item to my action list';
    btn.addEventListener('click', async () => {
      if (await addReminderFromText(text, {
        title: resultTitle.textContent,
        folder: currentFolder
      })) {
        btn.textContent = '✓ added';
        btn.classList.add('added');
        btn.disabled = true;
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

function acquireMic(key, reduction = noiseReduction) {
  const on = reduction !== 'off';
  const audio = {
    echoCancellation: on,
    noiseSuppression: on,
    autoGainControl: reduction === 'strong'
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
    await applyMicSelection({ reset: true });
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
// One at a time. Two runs overlapping — a device ending while a noise-
// reduction change or a picker change is in flight — could both pass the
// `micNodes.has(key)` check and both connect the same device to the bus: the
// loser's node stays connected but untracked, so `dropMic` can never
// disconnect it or stop its track, and that microphone is mixed into the
// recording twice for the rest of the meeting.
let captureGeneration = 0;
let micSelectionRun = Promise.resolve();
function applyMicSelection({ reset = false } = {}) {
  // Bind this request to the graph and intent that asked for it. getUserMedia
  // can stay pending while a recording stops or a new one starts; a late
  // answer must be stopped, never attached to whatever globals exist then.
  const request = {
    generation: captureGeneration,
    context: audioCtx,
    bus: micBus,
    selection: micSelection,
    reduction: noiseReduction,
    reset
  };
  const run = () => reconcileMics(request);
  const next = micSelectionRun.then(run, run);
  micSelectionRun = next.catch(() => { });
  return next;
}

async function reconcileMics(request) {
  const { generation, context, bus, selection, reduction, reset } = request;
  const current = () => generation === captureGeneration
    && context === audioCtx && bus === micBus && !!context && !!bus;
  if (!current()) return;
  if (reset) {
    for (const key of [...micNodes.keys()]) dropMic(key);
  }
  const mics = await listMics();
  if (!current()) return;
  let desired = selection === 'all' ? mics.map(d => d.deviceId) : [selection];
  if (desired.length === 0) desired = ['default'];

  for (const key of [...micNodes.keys()]) {
    if (!desired.includes(key)) dropMic(key);
  }
  let failed = null;
  for (const key of desired) {
    if (micNodes.has(key)) continue;
    let stream = null;
    try {
      stream = await acquireMic(key, reduction);
      if (!current()) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      const node = context.createMediaStreamSource(stream);
      node.connect(bus);
      micStreams.set(key, stream);
      micNodes.set(key, node);
      for (const track of stream.getAudioTracks()) {
        track.addEventListener('ended', async () => {
          // `dropMic` also stops tracks. Only a track that is still the live
          // source owns this callback; an intentional replacement must not
          // re-acquire the source it just removed.
          if (!current() || micStreams.get(key) !== stream) return;
          dropMic(key);
          await applyMicSelection();
        }, { once: true });
      }
    } catch (err) {
      // createMediaStreamSource/connect can fail after acquisition. A stream
      // that was never installed in the maps has no later owner to stop it.
      if (stream && micStreams.get(key) !== stream) {
        stream.getTracks().forEach(t => t.stop());
      }
      if (!current()) return;
      // Device busy or unplugged: skip it, another may work. But remember
      // why, because one refusal is not like the others — macOS denying the
      // microphone outright (a missing permission, or a build signed without
      // the entitlement) leaves the graph running on nothing, and the only
      // sign used to be a flat meter. 0.1.10 recorded a whole call that way.
      failed = err;
    }
  }
  if (current()) micError = micNodes.size ? null : failed;
}

/** What to tell the person when the microphone is silent, given how it failed. */
function micSilenceMessage(withSys) {
  if (micError && micError.name === 'NotAllowedError') {
    return 'macOS is not letting Yapper use the microphone. Allow it under '
      + 'System Settings → Privacy & Security → Microphone, then pick the '
      + 'microphone again in Settings — recording continues meanwhile'
      + (withSys ? ', with the other side only.' : '.');
  }
  if (micError) {
    return `The microphone could not be opened (${micError.name || 'error'}). `
      + 'Pick another one in Settings — recording continues meanwhile'
      + (withSys ? ', with the other side only.' : '.');
  }
  return withSys
    ? 'The microphone has captured only silence so far. If it is a wireless headset, check that it is on.'
    : 'Nothing but silence has been captured so far — check that the headset or microphone is on.';
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
  // On macOS there is no gain node here to turn: the mixing happens in the
  // main process, so the slider has to reach it or it moves nothing.
  if (window.yapper.platform === 'darwin') window.yapper.setSysGain(gainSys);
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
    // Re-acquire through the same serialized transaction so a device event
    // cannot overlap a picker/noise change and leave an untracked source.
    await applyMicSelection({ reset: micSelection === 'default' });
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

function liveTranscriptOnScreen() {
  return liveTranscriptEl.checkVisibility
    ? liveTranscriptEl.checkVisibility() : liveTranscriptEl.offsetParent !== null;
}

function renderLiveTranscript() {
  if (!liveParagraphs.length && !liveTentative) {
    liveTranscriptEl.innerHTML = '';   // stays :empty so the hint shows
    liveDirty = false;
    return;
  }
  // Rebuilding hundreds of paragraphs for a panel that is collapsed or on
  // another view is work nobody sees. It is done once, when the panel is.
  if (!liveTranscriptOnScreen()) { liveDirty = true; return; }
  liveDirty = false;
  const stick = liveTranscriptEl.scrollHeight - liveTranscriptEl.scrollTop
    - liveTranscriptEl.clientHeight < 40;
  liveTranscriptEl.innerHTML = '';

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
  // A pass that confirmed nothing and changed nothing — most passes over a
  // pause — used to rebuild the whole transcript anyway.
  if (!msg.commit && (msg.tentative || '') === liveTentative) return;
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
  if (!collapsed && liveDirty) renderLiveTranscript();
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
  // Two problems pull in opposite directions here, and this draws for both.
  //
  // At true scale a voice sits around 8% of an int16 — a line with a tremor in
  // it, indistinguishable from a dead input, which is how "the waveforms don't
  // work" was meant. Normalising to a rolling peak fixes that and breaks the
  // gain sliders: turn one up, the signal grows, the peak grows with it, the
  // scale shrinks by exactly as much, and the trace never moves. A meter that
  // normalises away the thing its own slider controls is worse than a quiet
  // one. A fixed boost fixes the sliders and puts the first problem back, since
  // whatever multiplier suits a quiet microphone saturates a loud call.
  //
  // So: normalised for visibility, then multiplied by the gain the user chose.
  // The shape is always readable whatever the source level, turning the gain up
  // grows the trace until it flattens against the edges — which is what
  // clipping looks like everywhere else, and the honest signal that the
  // recording is too hot — and turning it down visibly shrinks it.
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = Math.abs(buf[i] - 128);
    if (d > peak) peak = d;
  }
  // Decays rather than resets, so the scale does not jump between frames, and
  // floored so silence is not stretched into a convincing signal — a worse lie
  // than a flat line, and one that would hide the very failure the silence
  // warning exists to catch.
  m.peak = Math.max(peak, (m.peak || 0) * 0.92, VIZ_FLOOR);
  const scale = (mid * 0.92) / m.peak * (m.gainOf ? m.gainOf() : 1);

  const step = w / buf.length;
  let x = 0;
  for (let i = 0; i < buf.length; i++) {
    const y = mid + Math.max(-mid * 0.98, Math.min(mid * 0.98, (buf[i] - 128) * scale));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    x += step;
  }
  ctx.stroke();
}

// About 6% of full scale: below this the input is silence or its noise floor.
const VIZ_FLOOR = 8;

// Meters redraw this often. 30 fps looks like 120 and costs a quarter of it.
const METER_FRAME_MS = 1000 / 30;

/** Has this input delivered anything but exact zeros in its current window? */
function hasSignal(m) {
  if (!m || !m.fbuf || !m.analyser.getFloatTimeDomainData) return true;
  m.analyser.getFloatTimeDomainData(m.fbuf);
  for (let i = 0; i < m.fbuf.length; i++) if (m.fbuf[i] !== 0) return true;
  return false;
}

/** Peak deviation in a viz's current buffer, 0..1 — what the bubble's bars show. */
function levelOf(m) {
  if (!m) return 0;
  let peak = 0;
  for (let i = 0; i < m.buf.length; i++) {
    const d = Math.abs(m.buf[i] - 128);
    if (d > peak) peak = d;
  }
  return peak / 128;
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
  if (on) window.yapper.bubbleState({ level: 0 });   // the capsule goes quiet too
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

window.yapper.onMeetingEnded(ended => {
  if (!ended) { clearEndedPrompt(); return; }
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
  markRecordingInSidebar(false);
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
  // Recording can be started from the sidebar, from the detected-meeting card or
  // from the system notification, and any of those can happen while another view
  // is open. The timer and the stop button have to be the thing on screen.
  showView('record');
  try {
    // main.js answers this with Windows system-audio loopback (video must be
    // requested even if unused). Not on macOS: Electron's loopback is
    // Windows-only, and asking there would trigger a Screen Recording
    // permission prompt — and, if it were refused, reject and take the whole
    // recording down with it. The microphone alone is what a Mac can offer,
    // so it asks for exactly that.
    const sys = window.yapper.platform === 'darwin'
      ? null
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (sys) {
      sys.getVideoTracks().forEach(t => (t.enabled = false));
      sysStream = sys;
    }

    // A fresh generation owns every asynchronous microphone acquisition made
    // below. The previous queue must not delay this recording if an old
    // getUserMedia request is still waiting on the OS.
    captureGeneration++;
    micSelectionRun = Promise.resolve();
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
      return { analyser, canvas, ctx: canvas.getContext('2d'), color,
        buf: new Uint8Array(analyser.fftSize),
        // The meter reads bytes; whether the microphone is alive is asked of
        // the floats. A byte is 1/256 of full scale, so everything below
        // about -48 dBFS — a quiet room, a soft voice at the far end of a
        // table — is 128, indistinguishable from a device delivering nothing.
        // The claim being made is "exact digital zeros", and only the float
        // data can support it: a live microphone always carries its own noise
        // floor, however faint.
        fbuf: new Float32Array(analyser.fftSize),
        gainOf: () => (canvas === vizSys ? gainSys : gainMic) };
    };

    analysers = { sys: null, mic: null };
    if (sys && sys.getAudioTracks().length) {
      const sysSrc = audioCtx.createMediaStreamSource(sys);
      sysGainNode = audioCtx.createGain();
      sysGainNode.gain.value = gainSys;
      sysSrc.connect(sysGainNode);
      sysGainNode.connect(dest);
      analysers.sys = makeViz(sysGainNode, vizSys, colSys);
    } else if (window.yapper.platform === 'darwin') {
      window.yapper.setSysGain(gainSys);      // the stored preference, applied
      resetSysWave();
      // No stream to hang an analyser on: on macOS these samples are captured
      // and mixed in the main process and never reach this side. The meter is
      // fed from there instead, through something shaped like an analyser so
      // drawWave and levelOf do not have to know the difference.
      analysers.sys = {
        analyser: { getByteTimeDomainData: sysWaveInto },
        canvas: vizSys,
        ctx: vizSys.getContext('2d'),
        color: colSys,
        buf: new Uint8Array(SYS_WAVE_POINTS),
        gainOf: () => gainSys
      };
    }
    analysers.mic = makeViz(micBus, vizMic, colMic);

    await applyMicSelection();

    let levelSentAt = 0;
    let levelSent = -1;       // the last level the bubble was given
    let levelRepeats = 0;     // how many times in a row it was the same
    // A device can exist and still deliver pure digital zeros — a wireless
    // headset that fell asleep, a hardware mute. The graph runs, the waveform
    // draws a flat line, and two hours later the recording is silence. A live
    // microphone always carries at least its own noise floor, so an exact zero
    // held for seconds is a dead device, and it is said out loud rather than
    // drawn quietly.
    let lastMicSignalAt = performance.now();
    let silenceWarned = false;
    // The meters used to redraw on every animation frame, which on a ProMotion
    // display is 120 times a second: two canvases, each frame, for the whole
    // meeting. That alone held the GPU process at a third of a core and the
    // renderer at a quarter. Thirty frames a second reads exactly the same,
    // and a meter nobody can see — the panel closed, the window covered — is
    // not painted at all. The samples are still read every frame, because the
    // silence check and the bubble's bars come from them.
    const updateLevels = () => {
      levelTimer = null;
      const frameAt = performance.now();
      const visible = windowOnScreen && !document.hidden;
      for (const m of [analysers.sys, analysers.mic]) {
        if (!m) continue;
        const shown = visible && (m.canvas.checkVisibility
          ? m.canvas.checkVisibility() : m.canvas.offsetParent !== null);
        // Painting is for what someone can see; reading is what the silence
        // check and the bubble's meter live on, and that happens either way.
        if (shown) drawWave(m);
        else m.analyser.getByteTimeDomainData(m.buf);
      }
      const now = performance.now();
      // Deliberate silence is not a fault: the slider goes to zero, and
      // someone recording only the far side of a call means it.
      const micMuted = !!micBus && micBus.gain.value === 0;
      const micAlive = micMuted || hasSignal(analysers.mic);
      if (micAlive) lastMicSignalAt = now;
      // A refusal is said at once; plain silence gets six seconds to be a
      // headset waking up. This is consecutive silence, not a lifetime peak:
      // a microphone that worked at the start can still die halfway through.
      // Never against something this same tick just counted as alive: with
      // the slider at zero *and* the microphone refused, the two branches
      // took turns thirty times a second — the warning was written and wiped
      // within a frame, so the one line that says what to do about a refusal
      // (written by startRecording) was erased and never seen again.
      if (!silenceWarned && !micAlive && (micError || now - lastMicSignalAt > 6000)) {
        silenceWarned = true;
        setStatus(statusEl, micSilenceMessage(!!analysers.sys), !analysers.sys || !!micError, 'mic');
      }
      if (silenceWarned && micAlive) {
        silenceWarned = false;
        // The device woke up — but only this handler's own line goes away
        // with it: a system-audio warning written since then is still true.
        clearStatus(statusEl, 'mic');
      }
      // The bubble's capsule shows this same signal. Throttled: the bars only
      // have ~100 ms of resolution anyway, and paused means silent on purpose.
      if (bubbleEnabled && !paused) {
        const now = performance.now();
        if (now - levelSentAt > 110) {
          levelSentAt = now;
          const level = Math.max(levelOf(analysers.sys), levelOf(analysers.mic));
          // The bubble's bars trail the last few levels, so an unchanged level
          // is sent a few more times to let them settle — and then not at all.
          // Nine identical messages a second through a silence kept the bubble
          // re-compositing for nothing.
          if (Math.abs(level - levelSent) < 0.01) levelRepeats++;
          else levelRepeats = 0;
          levelSent = level;
          if (levelRepeats <= 4) window.yapper.bubbleState({ level });
        }
      }
      const wait = Math.max(0, METER_FRAME_MS - (performance.now() - frameAt));
      // A timer, not an animation frame. The meters are drawn from this loop,
      // but what it is really doing is *measuring* — the level the bubble
      // shows, and whether the microphone has delivered anything but exact
      // zeros — and animation frames stop entirely in a window that is not on
      // screen. A meeting recorded with Zoom in front of Yapper would have
      // gone unmeasured: no bubble meter, and no warning for a dead
      // microphone, which is the one failure this loop exists to catch.
      levelTimer = setTimeout(updateLevels, wait);
    };
    updateLevels();

    // open the file first: every block of samples goes straight to disk from
    // here on, so an interrupted meeting still leaves a playable recording
    // Clear the previous recorder phase before starting the helper. A missing
    // helper reports synchronously from inside recordingStart(); clearing here
    // means that actionable line cannot be erased when the IPC resolves.
    clearStatus(statusEl);
    currentFolder = await window.yapper.recordingStart(recParticipants());
    paused = false;     // the tap reads this on its very first block
    recording = true;
    markRecordingInSidebar(true);

    startPcmTap();      // the single audio source: file and live share it
    startLivePreview();

    btnRecord.classList.add('hidden');
    recLive.classList.remove('hidden');
    pipelineEl.classList.add('hidden');
    const sysAudio = !!(sys && sys.getAudioTracks().length);
    // applyMicSelection already knows the difference between permission denied,
    // a busy device and ordinary silence. Preserve that actionable explanation:
    // the generic no-source fallback used to overwrite it immediately on macOS.
    if (micError) {
      setStatus(statusEl, micSilenceMessage(!!analysers.sys), true, 'mic');
    } else if (micNodes.size === 0 && !sysAudio) {
      setStatus(statusEl, 'Warning: no audio source could be captured.');
    } else if (!sysAudio) {
      // On macOS system audio does not come through the renderer at all: the
      // native helper captures it and main.js mixes it in. So silence here is
      // the normal case, and the only thing worth saying is when that helper
      // could not start — which arrives separately, on 'system-audio-status'.
      if (window.yapper.platform !== 'darwin') {
        setStatus(statusEl, 'Warning: system audio could not be captured; only the mic is being recorded.', false, 'sysaudio');
      }
    } else if (micNodes.size === 0) {
      setStatus(statusEl, 'Warning: no microphone could be captured; only system audio is being recorded.', false, 'mic');
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

    let timerText = '';
    timerInterval = setInterval(() => {
      // Twice a second so a pause lands within half a second of the button;
      // the text itself changes once a second, and only then is it written.
      const text = stamp(elapsed());
      if (text === timerText) return;
      timerText = text;
      timerEl.textContent = text;
      btnNewLabel.textContent = `Recording — ${text}`;
      if (bubbleEnabled) window.yapper.bubbleState({ timer: text });
    }, 500);
  } catch (err) {
    await abortRecording(err);
  }
}

function cleanupCapture() {
  // Invalidate pending listMics/getUserMedia work before tearing down the
  // graph. Any stream that arrives afterwards sees a stale generation and is
  // stopped instead of being connected to this or the next recording.
  captureGeneration++;
  micSelectionRun = Promise.resolve();
  if (timerInterval) clearInterval(timerInterval);
  if (levelTimer) clearTimeout(levelTimer);
  timerInterval = null;
  levelTimer = null;
  micError = null;
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
  markRecordingInSidebar(false);
  // If the Screen Recording prompt is up, its reopen button was held back
  // while a meeting was in the air. Nothing is at stake now.
  const relaunch = $('sp-relaunch');
  if (relaunch) { relaunch.disabled = false; relaunch.title = ''; }
  resetSysWave();                    // flat, not frozen on the last peak
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
    const transcribeStarted = performance.now();
    const transcript = await window.yapper.transcribe(folder);
    const transcribeMs = performance.now() - transcribeStarted;
    setStep('transcribe', 'done');

    setStep('notes', 'active');
    setStatus(statusEl, 'Generating the notes…');
    const typedTitle = titleInput.value.trim();
    const participants = recParticipants();
    beginNotesStream(folder, typedTitle, transcript, participants);
    const draft = await window.yapper.generateNotes(folder,
      { ...options, participants, markers }, !typedTitle);
    const summary = draft.summary;
    setStep('notes', 'done');

    // With no typed title the same model response carries both results. This
    // removes an entire provider round trip from the visible stop path.
    const title = typedTitle || draft.title;

    clearStatus(statusEl);
    pipelineEl.classList.add('hidden');
    const meetingData = await window.yapper.loadMeeting(folder);
    openMeetingView(title || formatMeetingDate(folder.split(/[\\/]/).pop()), summary, transcript,
      true, participants, { transcribeMs, ...draft.metrics }, meetingData.speakers);
    finishNotesStream({ transcribeMs, ...draft.metrics });
    titleInput.value = '';
    participantsRec.value = '';     // these people were in that meeting, not the next one
    await refreshMeetingList();
  } catch (err) {
    if (noteStreamFolder) {
      failNotesStream(noteGenerationCanceled(err)
        ? 'Note generation canceled. The transcript is safe — use Regenerate whenever you are ready.'
        : `The transcript is safe, but the notes failed: ${err.message}`, !noteGenerationCanceled(err));
      pipelineEl.classList.add('hidden');
    } else {
      pipelineEl.querySelectorAll('.step.active').forEach(s => { s.classList.remove('active'); s.classList.add('error'); });
      setStatus(statusEl, `Error: ${err.message}\nYour recording is safe — open the meeting in the sidebar and use "Transcribe now" to retry.`, true);
    }
    refreshMeetingList();
  } finally {
    btnRecord.disabled = false;
  }
}

// ---------- meeting view ----------

function openMeetingView(title, summary, transcript, hasRecording = true, participants = null, timing = null, speakers = null) {
  if (noteStreamFolder && folderName(currentFolder) !== noteStreamFolder) finishNotesStream();
  stopSpeak();
  exitEditMode();
  showView('meeting');
  regenStatusEl.classList.add('hidden');
  resultTitle.textContent = title;
  resultDateStr = currentFolder ? formatMeetingDate(currentFolder.split(/[\\/]/).pop()) : '';
  resultDate.textContent = resultDateStr;
  showGenerationTiming(timing);
  participantsMeet.value = participants || '';
  clearTimeout(speakerSaveTimer);
  paintSpeakerMap(speakers || []);
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
    openMeetingView(resultTitle.textContent, data.summary, data.transcript, data.hasRecording, data.participants, null, data.speakers);
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
      openMeetingView(data.title || formatMeetingDate(m.name), data.summary, data.transcript, data.hasRecording, data.participants, null, data.speakers);
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

// ---------- search ----------
// A question gets an answer written only from retrieved passages; anything else
// gets ranked passages. Either way the passages are shown, because they are the
// evidence — an answer with nothing under it is not worth reading.

const searchInputEl = $('search-q');
const searchStatusEl = $('search-status');
const searchAnswerEl = $('search-answer');
const searchResultsEl = $('search-results');

$('btn-search-view').addEventListener('click', () => {
  stopSpeak();
  showView('search');
  searchInputEl.focus();
});

$('btn-search').addEventListener('click', runSearch);
searchInputEl.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
document.querySelectorAll('#search-examples button').forEach(b =>
  b.addEventListener('click', () => { searchInputEl.value = b.dataset.q; runSearch(); }));

let searchRun = 0;

async function runSearch() {
  const query = searchInputEl.value.trim();
  searchAnswerEl.classList.add('hidden');
  searchResultsEl.innerHTML = '';
  if (!query) {
    setStatus(searchStatusEl, 'Type something to look for.');
    return;
  }

  const run = ++searchRun;
  setStatus(searchStatusEl, 'Searching your meetings…');
  try {
    const res = await window.yapper.search(query, { limit: 20 });
    if (run !== searchRun) return;               // a newer search already started

    if (!res.results.length) {
      setStatus(searchStatusEl,
        res.meetings === 0
          ? 'There are no meetings to search yet.'
          : `Nothing matched "${query}" across ${res.meetings} meeting${res.meetings === 1 ? '' : 's'}.`);
      return;
    }

    searchStatusEl.classList.add('hidden');
    renderSearchResults(res);

    // A question gets an answer on top of the passages, not instead of them.
    if (res.query.question) {
      setStatus(searchStatusEl, 'Reading the passages…');
      const answered = await window.yapper.ask(query);
      if (run !== searchRun) return;
      searchStatusEl.classList.add('hidden');
      if (answered.answer) showSearchAnswer(answered.answer);
      else if (answered.error) setStatus(searchStatusEl, `Could not answer: ${answered.error}`, true);
    }
  } catch (err) {
    if (run !== searchRun) return;
    setStatus(searchStatusEl, `Search failed: ${err.message}`, true);
  }
}

function showSearchAnswer(answer) {
  searchAnswerEl.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'answer-body';
  // Citations are the point, so they are marked rather than left inline.
  body.innerHTML = escapeHtml(answer)
    .replace(/\[([^\]]+)\]/g, '<span class="cite">$1</span>')
    .replace(/\n/g, '<br>');
  const note = document.createElement('div');
  note.className = 'answer-note';
  note.textContent = 'Written only from the passages below.';
  searchAnswerEl.append(body, note);
  searchAnswerEl.classList.remove('hidden');
}

const KIND_LABEL = {
  transcript: 'transcript', decision: 'decision', action: 'action item',
  risk: 'risk', question: 'open question', notes: 'notes'
};

function renderSearchResults(res) {
  searchResultsEl.innerHTML = '';

  // Say out loud when a date in the query narrowed things, so an unexpectedly
  // short list is explained rather than mysterious.
  if (res.query.from) {
    const scope = document.createElement('li');
    scope.className = 'result-scope';
    scope.textContent = res.query.from === res.query.to
      ? `Only meetings on ${res.query.from}.`
      : `Only meetings between ${res.query.from} and ${res.query.to}.`;
    searchResultsEl.appendChild(scope);
  }

  for (const r of res.results) {
    const li = document.createElement('li');
    li.className = 'result';

    const head = document.createElement('div');
    head.className = 'result-head';

    const open = document.createElement('button');
    open.className = 'result-meeting';
    open.textContent = r.meeting.title;
    open.title = 'Open this meeting';
    open.addEventListener('click', () => openMeetingByFolder(r.meeting.folder));
    head.appendChild(open);

    const when = document.createElement('span');
    when.className = 'result-when';
    when.textContent = r.meeting.date + (r.stamp ? ` · ${r.stamp}` : '');
    head.appendChild(when);

    const kind = document.createElement('span');
    kind.className = `result-kind kind-${r.kind}`;
    kind.textContent = r.heading || KIND_LABEL[r.kind] || r.kind;
    head.appendChild(kind);

    if (r.meeting.participants.length) {
      const who = document.createElement('span');
      who.className = 'result-who';
      who.textContent = r.meeting.participants.join(', ');
      head.appendChild(who);
    }

    const body = document.createElement('div');
    body.className = 'result-text';
    body.textContent = r.text;

    li.append(head, body);
    searchResultsEl.appendChild(li);
  }
}

// ---------- home: the day, and the week ----------
//
// Two panels behind one button, and they are deliberately different kinds of
// thing. "Today" is assembled from the notes — every line on it is a copy of
// something in a file, with the meeting it came from attached, so it appears
// instantly and works with no provider configured. "This week" is the only
// place a model is asked to write, and even there the numbers above it are
// assembled, so a failed call leaves facts on screen instead of an error alone.

const viewHome = $('view-home');
const homeCountEl = $('home-count');
let homeScope = 'day';
let homeDay = '';        // '' means today; set when jumping to an earlier day
let homeWeekOf = '';
let homeRun = 0;

$('btn-home').addEventListener('click', () => {
  homeDay = '';
  homeWeekOf = '';
  showView('home');
  loadHome();
});

document.querySelectorAll('#home-scope .seg-btn').forEach(b =>
  b.addEventListener('click', () => {
    homeScope = b.dataset.scope;
    document.querySelectorAll('#home-scope .seg-btn')
      .forEach(x => x.classList.toggle('active', x === b));
    loadHome();
  }));

$('btn-week-refresh').addEventListener('click', () => loadHome({ refresh: true }));

function loadHome(opts = {}) {
  $('home-day').classList.toggle('hidden', homeScope !== 'day');
  $('home-week').classList.toggle('hidden', homeScope !== 'week');
  return homeScope === 'day' ? loadDay() : loadWeek(opts);
}

// ---- the day ----

async function loadDay() {
  const run = ++homeRun;
  $('home-hint').textContent = '';
  try {
    const d = await window.yapper.dailyDigest(homeDay || undefined);
    if (run !== homeRun) return;
    renderDay(d);
  } catch (err) {
    if (run !== homeRun) return;
    showDayEmpty(`Could not read your meetings: ${err.message}`, true);
  }
}

function renderDay(d) {
  homeDay = d.day;
  const isToday = d.day === localToday();
  $('home-title').textContent = isToday ? 'Today' : longDate(d.day);
  $('home-sub').textContent = isToday
    ? 'Everything your meetings recorded today, taken straight from the notes.'
    : `What happened on ${longDate(d.day)}.`;

  fillList('day-attention', d.attention, item => {
    const li = document.createElement('li');
    li.className = 'digest-item';
    const tag = document.createElement('span');
    tag.className = `digest-tag tag-${item.kind}`;
    tag.textContent = { 'no-notes': 'no notes', overdue: 'overdue', urgent: 'urgent' }[item.kind] || item.kind;
    const text = document.createElement('span');
    text.className = 'digest-text';
    text.textContent = item.text;
    li.append(tag, text);
    if (item.owner) li.appendChild(meta(item.owner));
    if (item.due) li.appendChild(meta(`due ${item.due}`));
    li.appendChild(sourceButton(item.meeting && item.meeting.folder
      ? item.meeting : { title: item.meeting, folder: item.folder }));
    return li;
  });

  fillList('day-meetings', d.meetings, m => {
    const li = document.createElement('li');
    li.className = 'digest-item';
    const time = document.createElement('span');
    time.className = 'digest-time';
    time.textContent = m.time || '—';
    const open = document.createElement('button');
    open.className = 'result-meeting';
    open.textContent = m.title;
    open.title = 'Open this meeting';
    open.addEventListener('click', () => openMeetingByFolder(m.folder));
    li.append(time, open);
    if (m.participants.length) li.appendChild(meta(m.participants.join(', ')));
    return li;
  });

  fillList('day-decisions', d.decisions, dec => {
    const li = document.createElement('li');
    li.className = 'digest-item';
    const text = document.createElement('span');
    text.className = 'digest-text';
    text.textContent = dec.text;
    li.append(text, sourceButton(dec.meeting));
    return li;
  });

  fillList('day-actions', d.created, a => {
    const li = document.createElement('li');
    li.className = 'digest-item';
    const text = document.createElement('span');
    text.className = 'digest-text';
    text.textContent = a.text;
    li.appendChild(text);
    li.appendChild(meta(a.owner || 'nobody named'));
    if (a.due) li.appendChild(meta(`due ${a.due}`));
    li.appendChild(sourceButton({ title: a.meeting, folder: a.folder }));
    return li;
  });

  if (d.empty) {
    // A first run and a quiet Tuesday look the same from here, but they are not
    // the same sentence: one needs telling what to do, the other does not.
    const label = d.library === 0
      ? 'Nothing here yet. Record a meeting or import a voice note, and it will show up here.'
      : isToday ? 'No meetings recorded today.' : `Nothing on ${longDate(d.day)}.`;
    showDayEmpty(label, false, d.previous);
  } else {
    $('day-empty').classList.add('hidden');
    const c = d.counts;
    $('home-hint').textContent = `${count(c.meetings, 'meeting')} · `
      + `${count(c.decisions, 'decision')} · ${count(c.openTotal, 'item')} still open`;
  }
  homeCountEl.textContent = d.attention.length;
  homeCountEl.classList.toggle('hidden', !d.attention.length);
}

function showDayEmpty(text, isError, previous) {
  for (const id of ['day-attention', 'day-meetings', 'day-decisions', 'day-actions']) {
    $(id).innerHTML = '';
    $(`${id}-block`).classList.add('hidden');
  }
  const box = $('day-empty');
  box.innerHTML = '';
  box.classList.remove('hidden');
  box.classList.toggle('error', !!isError);
  const p = document.createElement('p');
  p.textContent = text;
  box.appendChild(p);
  if (previous) {
    const back = document.createElement('button');
    back.className = 'btn-ghost';
    back.textContent = `Show ${longDate(previous)} instead`;
    back.addEventListener('click', () => { homeDay = previous; loadDay(); });
    box.appendChild(back);
  }
}

/** Fill a digest list, and hide the whole block when there is nothing in it. */
function fillList(id, items, build) {
  const ul = $(id);
  ul.innerHTML = '';
  for (const item of items || []) ul.appendChild(build(item));
  $(`${id}-block`).classList.toggle('hidden', !(items || []).length);
}

function meta(text) {
  const el = document.createElement('span');
  el.className = 'digest-meta';
  el.textContent = text;
  return el;
}

/** The link back to where a line came from. Every line has one. */
function sourceButton(meeting) {
  const btn = document.createElement('button');
  btn.className = 'digest-source';
  btn.textContent = (meeting && meeting.title) || 'the meeting';
  btn.title = 'Open the meeting this came from';
  if (meeting && meeting.folder) {
    btn.addEventListener('click', () => openMeetingByFolder(meeting.folder));
  } else {
    btn.disabled = true;
  }
  return btn;
}

// ---- the week ----

async function loadWeek(opts = {}) {
  const run = ++homeRun;
  $('week-sections').innerHTML = '';
  $('week-foot').classList.add('hidden');
  // Offering to write it again before anything was written reads as a broken
  // button, so it stays hidden until there is something to rewrite.
  $('btn-week-refresh').classList.add('hidden');
  setStatus($('week-status'), opts.refresh ? 'Writing it again…' : 'Reading this week\'s notes…');
  try {
    const w = await window.yapper.weeklySummary({
      week: homeWeekOf || undefined, refresh: !!opts.refresh
    });
    if (run !== homeRun) return;
    renderWeek(w);
  } catch (err) {
    if (run !== homeRun) return;
    setStatus($('week-status'), `Could not build the weekly review: ${err.message}`, true);
  }
}

// The written half lands in the background; when it does, the week on screen
// is the only one that cares. Any other week reads the fresh cache when opened.
window.yapper.onWeeklyWritten(info => {
  if (viewHome.classList.contains('hidden') || homeScope !== 'week') return;
  if (homeWeekOf && info.from !== homeWeekOf) return;
  loadWeek();
});

function renderWeek(w) {
  homeWeekOf = w.from;
  $('home-title').textContent = 'This week';
  $('home-sub').textContent = `${longDate(w.from)} — ${longDate(w.to)}`;
  $('home-hint').textContent = w.week;
  renderWeekFacts(w.facts);

  // Whatever happens next, the numbers above stay on screen.
  const status = $('week-status');
  if (w.reason === 'no-meetings') {
    setStatus(status, 'No meetings this week yet.');
    return offerPreviousWeek(w);
  }
  if (w.reason === 'no-notes') {
    setStatus(status, `${count(w.facts.meetings.length, 'meeting')} this week, but none of them have notes yet. `
      + 'Generate notes for one and the review can be written.');
    return offerPreviousWeek(w);
  }
  if (w.reason === 'thin') {
    setStatus(status, 'Only one meeting has notes this week. A review connects meetings to each '
      + 'other, so there is nothing to connect yet.');
    return offerPreviousWeek(w);
  }
  if (w.error && !w.sections) {
    setStatus(status, `The written review failed: ${w.error}`, true);
    $('week-foot').classList.remove('hidden');
    $('btn-week-refresh').classList.remove('hidden');   // retrying is the useful move here
    $('week-note').textContent = 'The counts above come from your notes and do not need a model.';
    return;
  }

  // The first write of the week: nothing to show under the facts yet, but the
  // reply came back instantly and the writing is already under way.
  if (w.writing && !w.sections) {
    setStatus(status, 'Writing the review from this week\'s notes…');
    $('week-foot').classList.add('hidden');
    return;
  }

  if (w.error) {
    setStatus(status, `The rewrite failed: ${w.error} — this is the previous review.`, true);
  } else if (w.writing) {
    setStatus(status, w.stale
      ? 'The notes changed — writing an updated review. This one is from before the change.'
      : 'Writing it again…');
  } else {
    status.classList.add('hidden');
  }
  const host = $('week-sections');
  host.innerHTML = '';
  let shown = 0;

  for (const section of w.sections || []) {
    const block = document.createElement('section');
    block.className = 'digest-block week-section';
    const h = document.createElement('h2');
    h.className = 'digest-h';
    h.textContent = section.title;
    block.appendChild(h);

    if (!section.items.length) {
      const none = document.createElement('p');
      none.className = 'week-none';
      none.textContent = section.title === 'Threads'
        ? 'No topic came up in more than one meeting.'
        : 'Nothing in the notes.';
      block.appendChild(none);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'digest-list';
      for (const item of section.items) {
        const li = document.createElement('li');
        li.className = 'digest-item';
        const text = document.createElement('span');
        text.className = 'digest-text';
        text.textContent = item.text;
        li.appendChild(text);
        for (const c of item.cites) li.appendChild(sourceButton(c));
        ul.appendChild(li);
      }
      block.appendChild(ul);
      shown += section.items.length;
    }
    host.appendChild(block);
  }

  if (!shown && !w.writing && !w.error) {
    setStatus(status, 'The notes from this week did not support any cross-meeting points.');
  }

  $('week-foot').classList.remove('hidden');
  // While a rewrite is running, offering to start another reads as a broken button.
  $('btn-week-refresh').classList.toggle('hidden', !!w.writing);
  const notes = [];
  if (w.stale) notes.push('From the notes as they were before the last change');
  else if (w.cached) notes.push('Written earlier from the same notes');
  notes.push(`from ${count(w.fromMeetings || 0, 'meeting')}`);
  if (w.dropped) notes.push(`${count(w.dropped, 'line')} left out for not naming a meeting`);
  if (w.truncated) notes.push(`${count(w.truncated, 'long note')} shortened`);
  $('week-note').textContent = notes.join(' · ');
}

function renderWeekFacts(f) {
  const host = $('week-facts');
  host.innerHTML = '';
  // Six zeros in a row look like a broken screen rather than an empty week.
  host.classList.toggle('hidden', !!f.empty);
  if (f.empty) return;
  const stats = [
    [f.meetings.length, 'meetings'],
    [f.days.length, f.days.length === 1 ? 'day' : 'days'],
    [f.people.length, 'people'],
    [f.decisionCount, 'decisions'],
    [f.openFromWeek, 'new items'],
    [f.overdue, 'overdue']
  ];
  for (const [n, label] of stats) {
    const cell = document.createElement('div');
    cell.className = 'week-stat' + (label === 'overdue' && n ? ' stat-warn' : '');
    const big = document.createElement('span');
    big.className = 'week-stat-n';
    big.textContent = n;
    const small = document.createElement('span');
    small.className = 'week-stat-l';
    small.textContent = label;
    cell.append(big, small);
    host.appendChild(cell);
  }
  if (f.missingNotes.length) {
    const warn = document.createElement('div');
    warn.className = 'week-missing';
    warn.textContent = `${count(f.missingNotes.length, 'meeting')} transcribed without notes: `;
    for (const m of f.missingNotes) warn.appendChild(sourceButton(m));
    host.appendChild(warn);
  }
}

/**
 * The way out of an empty week — but only when there is one. `previous` is the
 * last week that actually had a meeting, so a new install gets no button rather
 * than one that walks backwards through empty weeks.
 */
function offerPreviousWeek(w) {
  $('week-sections').innerHTML = '';
  $('week-note').textContent = '';
  if (!w.previous) {
    $('week-foot').classList.add('hidden');
    return;
  }
  $('week-foot').classList.remove('hidden');
  const back = document.createElement('button');
  back.className = 'btn-ghost';
  back.textContent = 'Show the last week that had meetings';
  back.addEventListener('click', () => { homeWeekOf = w.previous; loadWeek(); });
  $('week-sections').appendChild(back);
}

// ---- small shared bits ----

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function localToday() {
  const now = new Date();
  const p = x => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function longDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });
}

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

/** The notes as spoken text: the cards without their controls. innerText keeps
 *  hover-only buttons (opacity, not display), so "+ my list" and "Copy" would
 *  be read out after every heading. */
function spokenNotesText() {
  const clone = notesEl.cloneNode(true);
  clone.querySelectorAll('button').forEach(el => el.remove());
  // off-screen but attached: innerText needs layout to honour line breaks
  clone.style.cssText = 'position:absolute;left:-99999px;top:0;';
  document.body.appendChild(clone);
  const text = clone.innerText.trim();
  clone.remove();
  return text;
}

btnSpeak.addEventListener('click', () => {
  if (speaking) { stopSpeak(); return; }
  const text = spokenNotesText();
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
    const transcribeStarted = performance.now();
    const transcript = await window.yapper.transcribe(picked.folder);
    const transcribeMs = performance.now() - transcribeStarted;
    setStep('transcribe', 'done');

    // An imported voice note gets the same treatment as a recorded meeting.
    // It used to stop at the transcript, which left the whole point of the app
    // — the notes — undone for anything that did not come from the recorder.
    let summary = '';
    let metrics = null;
    const participants = recParticipants();
    setStep('notes', 'active');
    beginNotesStream(picked.folder, picked.title, transcript, participants);
    try {
      setStatus(statusEl, 'Generating the notes…');
      const draft = await window.yapper.generateNotes(picked.folder,
        { ...options, participants }, !picked.title);
      summary = draft.summary;
      metrics = draft.metrics;
      if (!picked.title) picked.title = draft.title;
      setStep('notes', 'done');
    } catch (err) {
      // the transcript is already saved, so this is a partial success, not a loss
      setStep('notes', 'error');
      failNotesStream(noteGenerationCanceled(err)
        ? 'Note generation canceled. The transcript is saved — use Regenerate whenever you are ready.'
        : `The transcript is saved, but the notes failed: ${err.message}`, !noteGenerationCanceled(err));
    }

    const title = picked.title;

    if (summary) {
      clearStatus(statusEl);
      const meetingData = await window.yapper.loadMeeting(picked.folder);
      openMeetingView(title || formatMeetingDate(picked.folder.split(/[\\/]/).pop()),
        summary, transcript, true, participants, { transcribeMs, ...metrics }, meetingData.speakers);
      finishNotesStream({ transcribeMs, ...metrics });
    } else {
      resultTitle.textContent = title || formatMeetingDate(picked.folder.split(/[\\/]/).pop());
    }
    pipelineEl.classList.add('hidden');
    participantsRec.value = '';
    await refreshMeetingList();
  } catch (err) {
    if (noteStreamFolder) {
      failNotesStream(noteGenerationCanceled(err)
        ? 'Note generation canceled. The transcript is safe — use Regenerate whenever you are ready.'
        : `The transcript is safe, but the notes failed: ${err.message}`, !noteGenerationCanceled(err));
      pipelineEl.classList.add('hidden');
    } else {
      pipelineEl.querySelectorAll('.step.active').forEach(s => { s.classList.remove('active'); s.classList.add('error'); });
      setStatus(statusEl, `Error: ${err.message}`, true);
    }
  } finally {
    btnImport.disabled = false;
    btnRecord.disabled = false;
  }
});

// Where the capsule appears each recording. It never remembered being dragged,
// so the corner it starts in is the corner it lives in — and the bottom right
// is wrong as often as it is right, since that is where a video call puts its
// own controls.
const cornerSeg = $('corner-seg');

async function initBubbleCorner() {
  const current = await window.yapper.getBubbleCorner().catch(() => 'bottom-right');
  paintCorner(current);
}

function paintCorner(corner) {
  cornerSeg.querySelectorAll('.seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.corner === corner));
}

cornerSeg.addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  paintCorner(btn.dataset.corner);
  window.yapper.setBubbleCorner(btn.dataset.corner);
});

initBubbleCorner();

btnNew.addEventListener('click', () => {
  stopSpeak();
  currentFolder = null;
  if (noteStreamFolder) finishNotesStream();
  showView('record');
  clearStatus(statusEl);
  pipelineEl.classList.add('hidden');
  participantsRec.value = '';       // a new meeting starts with nobody in it
  refreshMeetingList();
  titleInput.focus();
});

btnRegen.addEventListener('click', async () => {
  if (!currentFolder) return;
  if (noteStreamFolder) {
    btnRegen.disabled = true;
    setStatus(regenStatusEl, 'Canceling note generation…');
    try {
      const canceled = await window.yapper.cancelNotes(currentFolder);
      if (!canceled) setStatus(regenStatusEl, 'The notes were already finishing…');
    } catch (err) {
      btnRegen.disabled = false;
      setStatus(regenStatusEl, `Could not cancel: ${err.message}`, true);
    }
    return;
  }
  const started = performance.now();
  beginNotesStream(currentFolder, resultTitle.textContent, transcriptEl.textContent,
    participantsMeet.value.trim(), true);
  // the attendees edited in this meeting's own bar, and only for this meeting
  setStatus(regenStatusEl, 'Regenerating the notes…');
  try {
    const summary = await window.yapper.regenerate(currentFolder,
      { ...options, participants: participantsMeet.value.trim() });
    renderNotes(summary);
    finishNotesStream({ firstTextMs: noteStreamFirstTextMs, notesMs: performance.now() - started });
    await refreshMeetingList();
  } catch (err) {
    failNotesStream(noteGenerationCanceled(err)
      ? 'Note generation canceled. Your previous notes are unchanged.'
      : `Could not regenerate the notes: ${err.message}`, !noteGenerationCanceled(err));
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

function buildPdfHtml(title, mode) {
  // The page is the app's own notes view: the same markup, the same
  // stylesheet, the same theme variables — light or dark as asked. Only the
  // interactive bits come out, and a small print sheet turns the app chrome
  // (a locked flex viewport) back into a flowing document.
  let body = '';
  for (const sec of notesEl.querySelectorAll('.note-sec')) {
    const clone = sec.cloneNode(true);
    clone.querySelectorAll('.li-add, button').forEach(el => el.remove());
    body += clone.outerHTML;
  }
  // The print margins are zero so the theme color reaches the edge of every
  // sheet (a margin set at print time cannot be painted). The frame is body
  // padding instead, and each section carries its gap as padding rather than
  // margin, because a margin is discarded at a page break and padding is not —
  // that gap is what keeps page two from starting flush against the edge.
  const print = `
    html { background: var(--bg); }
    body {
      display: block; height: auto; overflow: visible;
      padding: 0.55in 0.65in;
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .note-sec { page-break-inside: avoid; padding-top: 28px; }
    .note-sec .note-rule { margin-top: 0; }
    .pdf-date + .note-sec { padding-top: 14px; }
    .pdf-title { font-size: 22px; font-weight: 600; letter-spacing: -0.2px; color: var(--text); margin-bottom: 4px; }
    .pdf-date { font-size: 11px; color: var(--text-3); }
    .pdf-foot { margin-top: 30px; padding-top: 9px; border-top: 1px solid var(--rule); font-size: 10px; color: var(--text-3); }`;
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + `<link rel="stylesheet" href="style.css"><style>${print}</style></head>`
    + `<body${mode === 'light' ? ' class="light"' : ''}>`
    + `<h1 class="pdf-title">${escapeHtml(title)}</h1>`
    + `<div class="pdf-date">${escapeHtml(resultDateStr)}</div>`
    + body
    + '<div class="pdf-foot">Generated with Yapper</div></body></html>';
}

// ---------- export menu ----------

const btnExport = $('btn-export');
const exportMenu = $('export-menu');

function closeExportMenu() { exportMenu.classList.add('hidden'); }

btnExport.addEventListener('click', e => {
  e.stopPropagation();
  paintPdfThemeSeg();
  exportMenu.classList.toggle('hidden');
});
document.addEventListener('click', closeExportMenu);
exportMenu.addEventListener('click', e => e.stopPropagation());

// Which appearance the PDF gets. Until the user picks one it follows the app,
// so by default the export looks like what is on screen.
let pdfTheme = localStorage.getItem('yapper-pdf-theme') || '';
const pdfThemeNow = () => (pdfTheme === 'light' || pdfTheme === 'dark') ? pdfTheme : resolvedTheme();

function paintPdfThemeSeg() {
  document.querySelectorAll('#pdf-theme-seg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pdfTheme === pdfThemeNow()));
}

document.querySelectorAll('#pdf-theme-seg .seg-btn').forEach(b =>
  b.addEventListener('click', () => {
    pdfTheme = b.dataset.pdfTheme;
    localStorage.setItem('yapper-pdf-theme', pdfTheme);
    paintPdfThemeSeg();
  }));

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
      return await window.yapper.exportPdf(buildPdfHtml(title, pdfThemeNow()), title);
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
  open: 'Nothing pending. Add only the items you want from inside a meeting.',
  high: 'Nothing marked urgent.',
  mine: 'No action item has a named owner yet. Owners come from what was said in the meeting.',
  done: 'Nothing checked off yet.',
  all: 'No action items yet. Add one above, or use the + on an action item inside a meeting.'
};

// Selection mode: a checkbox per row, "Select all", and one action for the lot.
// The selection only ever holds ids that are on screen — changing the filter
// drops whatever is no longer shown, so "Mark as done" never touches a row you
// cannot see.
let selecting = false;
const selectedIds = new Set();
const bulkRow = $('bulk-row');
const selectAllBox = $('select-all-actions');
const bulkCountEl = $('bulk-count');
const btnBulkDone = $('btn-bulk-done');
const btnSelectActions = $('btn-select-actions');
let shownIds = [];

function renderBulkBar() {
  bulkRow.classList.toggle('hidden', !selecting);
  remindersList.classList.toggle('selecting', selecting);
  btnSelectActions.classList.toggle('active', selecting);
  if (!selecting) return;
  const n = selectedIds.size;
  const total = shownIds.length;
  selectAllBox.checked = total > 0 && n === total;
  selectAllBox.indeterminate = n > 0 && n < total;
  selectAllBox.disabled = total === 0;
  bulkCountEl.textContent = total ? `${n} of ${total} selected` : '';
  // In "Done" the bulk action is the reverse one; anywhere else it completes.
  btnBulkDone.textContent = actionFilter === 'done' ? 'Mark as not done' : 'Mark as done';
  btnBulkDone.disabled = n === 0;
}

function renderReminders(list) {
  remindersList.innerHTML = '';
  const shown = list.filter(ACTION_FILTERS[actionFilter] || ACTION_FILTERS.all);
  shownIds = shown.map(r => r.id);
  for (const id of [...selectedIds]) if (!shownIds.includes(id)) selectedIds.delete(id);

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
    renderBulkBar();
    return;
  }

  // Urgent first, then whatever was said most recently.
  const rank = r => (r.priority === 'high' ? 0 : r.priority === 'low' ? 2 : 1);
  const sorted = [...shown].sort((a, b) =>
    (a.done - b.done) || (rank(a) - rank(b)) || ((b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)));

  for (const r of sorted) {
    const li = document.createElement('li');
    li.className = 'reminder' + (r.done ? ' done' : '') + (r.priority === 'high' ? ' urgent' : '')
      + (selectedIds.has(r.id) ? ' selected' : '');

    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'r-select';
    pick.checked = selectedIds.has(r.id);
    pick.title = 'Select';
    pick.addEventListener('change', () => {
      if (pick.checked) selectedIds.add(r.id); else selectedIds.delete(r.id);
      li.classList.toggle('selected', pick.checked);
      renderBulkBar();
    });

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

    li.append(pick, check, main, del);
    remindersList.appendChild(li);
  }
  renderBulkBar();
}

function setSelecting(on) {
  selecting = on;
  if (!on) selectedIds.clear();
  renderBulkBar();
  if (on) remindersList.querySelectorAll('.r-select').forEach(b => { b.checked = false; });
  remindersList.querySelectorAll('.reminder.selected').forEach(li => li.classList.remove('selected'));
}

btnSelectActions.addEventListener('click', () => setSelecting(!selecting));
$('btn-bulk-cancel').addEventListener('click', () => setSelecting(false));

selectAllBox.addEventListener('change', () => {
  if (selectAllBox.checked) shownIds.forEach(id => selectedIds.add(id));
  else selectedIds.clear();
  remindersList.querySelectorAll('.reminder').forEach(li => {
    const box = li.querySelector('.r-select');
    if (!box) return;
    box.checked = selectAllBox.checked;
    li.classList.toggle('selected', selectAllBox.checked);
  });
  renderBulkBar();
});

btnBulkDone.addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const done = actionFilter !== 'done';
  btnBulkDone.disabled = true;
  try {
    const n = await window.yapper.updateReminders(ids, { done });
    setStatus(statusEl, `${n} action item${n === 1 ? '' : 's'} marked as ${done ? 'done' : 'not done'}.`);
  } catch (err) {
    setStatus(statusEl, `Could not update the action items: ${err.message}`, true);
  }
  setSelecting(false);
  await refreshReminders();
});

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
      data.summary, data.transcript, data.hasRecording, data.participants, null, data.speakers);
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

// ---------- renaming a meeting ----------
// The automatic title is a guess from the transcript, and a guess is sometimes
// wrong. The heading itself is the field: double-click it (or the pencil, or
// ⌘⇧R), type, Enter. Escape puts the old one back.

const btnRename = $('btn-rename');
let renameBefore = null;          // the title as it was when editing began; null when not editing

function beginRename() {
  if (!currentFolder || renameBefore !== null) return;
  if (viewMeeting.classList.contains('hidden') || noteStreamFolder) return;
  renameBefore = resultTitle.textContent;
  resultTitle.contentEditable = 'plaintext-only';
  resultTitle.classList.add('editing');
  resultTitle.focus();
  const range = document.createRange();
  range.selectNodeContents(resultTitle);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function endRename(commit) {
  if (renameBefore === null) return;
  const before = renameBefore;
  renameBefore = null;
  resultTitle.contentEditable = 'false';
  resultTitle.classList.remove('editing');
  const typed = resultTitle.textContent.replace(/\s+/g, ' ').trim();
  if (!commit || !typed || typed === before) { resultTitle.textContent = before; return; }
  try {
    const saved = await window.yapper.renameMeeting(currentFolder, typed);
    resultTitle.textContent = saved;
    await refreshMeetingList();      // the sidebar, search and digests all read title.txt
  } catch (err) {
    resultTitle.textContent = before;
    setStatus(regenStatusEl, `Could not rename the meeting: ${err.message}`, true);
  }
}

btnRename.addEventListener('click', beginRename);
resultTitle.addEventListener('dblclick', beginRename);
resultTitle.addEventListener('keydown', e => {
  if (renameBefore === null) return;
  if (e.key === 'Enter') { e.preventDefault(); endRename(true); }
  else if (e.key === 'Escape') { e.preventDefault(); endRename(false); }
});
resultTitle.addEventListener('blur', () => endRename(true));

// ---------- keyboard ----------
// The accelerators live in the application menu (main.js), so they are listed
// where people look for them and they work with the menu bar hidden on Windows.
// The menu only names what it wants; what that means right now is decided here.

window.yapper.onUiCommand(name => {
  const inMeeting = !viewMeeting.classList.contains('hidden');
  switch (name) {
    case 'home': $('btn-home').click(); break;
    case 'actions': btnReminders.click(); break;
    case 'search': $('btn-search-view').click(); break;
    case 'settings': $('btn-settings').click(); break;
    case 'export': if (inMeeting && !btnExport.disabled) btnExport.click(); break;
    case 'copy-notes': if (inMeeting && !btnCopy.disabled) btnCopy.click(); break;
    case 'rename': if (inMeeting) beginRename(); break;
    default: break;
  }
});

// Escape closes whatever is open, nearest first. Handled here rather than in the
// menu because what it dismisses is a fact about the page.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (renameBefore !== null) return;                   // the title's own handler
  if (!exportMenu.classList.contains('hidden')) { closeExportMenu(); return; }
  if (!meetingPrompt.classList.contains('hidden')) { meetingPrompt.classList.add('hidden'); return; }
  if (document.activeElement && document.activeElement !== document.body
      && typeof document.activeElement.blur === 'function') document.activeElement.blur();
});

// ---------- init ----------

syncOptionControls();
// The app opens on the day rather than on the record view: the first question on
// launch is usually "what happened / what do I owe", not "record something".
// Every path that starts a recording switches to the record view itself.
showView('home');
loadHome();
refreshMeetingList();
refreshReminders();

(async () => {
  await unlockMicLabels();
  await populateMicSelect();
})();

(async () => {
  try {
    let env = await window.yapper.checkEnvironment();
    // A fresh install has nothing to transcribe with yet; download it now,
    // with the progress on screen, instead of telling the user to run a script.
    if (!env.whisper) env = (await provisionEngine()) || env;

    const issues = [];
    if (!env.whisper) issues.push('• The transcription engine could not be set up — check the connection and restart Yapper to retry.');
    if (env.notes && !env.notes.ok) issues.push(`• ${env.notes.reason} Recording and transcription still work.`);
    refreshSetupBanner(env.notes);
    if (issues.length) {
      setStatus(statusEl, 'Setup needed:\n' + issues.join('\n'), true);
    } else if (env.tier === 'modest') {
      // not a failure: this machine simply gets the transcript after the
      // meeting instead of during it
      setStatus(statusEl, 'Live transcript is off on this machine — it is not fast enough to keep up. Recording and notes work as usual.');
    }
  } catch { /* never block the app on the preflight check */ }
})();

/**
 * The one-time engine download, narrated in the status area.
 *
 * It resolves at the *usable* milestone, not the complete one: the engine and
 * the first model are enough to record, and the larger model keeps arriving
 * afterwards. So the narration has two halves — a blocking one, and a quieter
 * one that has to stay visible, because a transcript that waits for a download
 * nobody mentioned reads as the app being stuck.
 */
async function provisionEngine() {
  btnRecord.disabled = true;
  btnImport.disabled = true;
  let usable = false;
  window.yapper.onEngineSetup(p => {
    if (!p) return;
    if (p.error) {
      // Before the app opened, the invoke result carries this and the caller
      // reports it. After — the background half failing is the only way anyone
      // hears about it, and leaving "still downloading" on screen for a
      // download that has stopped is worse than saying nothing.
      if (usable) {
        setStatus(statusEl, 'The rest of the transcription engine could not be '
          + 'downloaded. Recording works; the first transcript will retry it.', true);
      }
      return;
    }
    if (p.usable) usable = true;
    if (/engine ready/i.test(p.label || '')) {
      clearStatus(statusEl); // everything is down; nothing left to say
      return;
    }
    const pct = p.pct != null ? ` — ${Math.round(p.pct)}%` : '';
    setStatus(statusEl, usable
      ? `You can record now. Still downloading, so the first transcript may wait for it:\n${p.label}${pct}`
      : `Setting up transcription (one-time download, step ${p.step} of ${p.steps}):\n${p.label}${pct}`);
  });
  setStatus(statusEl, 'Setting up transcription — a one-time download…');
  let ok = false;
  try { ok = await window.yapper.engineSetup(); } catch { ok = false; }
  btnRecord.disabled = false;
  btnImport.disabled = false;
  if (!ok) return null;
  // The status is left alone on purpose: the handler above hides it when the
  // background half finishes, which is usually after this returns.
  return window.yapper.checkEnvironment();
}

// ---------- updates ----------
// Installed copies download updates in the background; this pill is the offer
// to apply one now. Ignoring it is fine — it applies on next quit anyway.

window.yapper.onUpdateReady(info => {
  const b = $('btn-update');
  b.textContent = `Update ${info && info.version ? 'v' + info.version : ''} ready — restart`.replace('  ', ' ');
  b.classList.remove('hidden');
});
$('btn-update').addEventListener('click', async () => {
  if (recording) {
    setStatus(statusEl, 'Recording — the update will install when Yapper closes.');
    return;
  }
  await window.yapper.updateRestart();
});
